import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEMO_PINNED,
  META_CAVEAT,
  WITHHELD_LINE,
  ago,
  columnsFor,
  countsLine,
  detailAfterIndex,
  dvnName,
  findingsLine,
  fleetLine,
  isDemoAsset,
  keyed,
  libState,
  metaLine,
  parseDemoPins,
  publicRead,
  routesOf,
  short,
  structuralRoutes,
  utc,
  verdictIsStale,
  structuralNote,
  verificationOf,
  withheldNote,
} from "../../../frontend/src/rail-logic";
import type { RouteRead, UlnRead, WatchedRead } from "../../../frontend/src/rail-logic";

// The judge page's non-obvious logic, tested from the backend suite rather than
// from a second test runner nobody would remember to run — the same reach into
// `frontend/src` that chain-consistency.test.ts already makes.
//
// Two of these cases exist because the behaviour they pin ALREADY SHIPPED WRONG
// once and was fixed with a fixture that no longer exists:
//
//   * a recorded verdict older than the snapshot was rendered as if it described
//     the snapshot, so a healthy band sat over stale CRITICAL findings;
//   * a corridor whose ULN could not be read was filtered out entirely, which
//     threw away the libraries the same read DID return and, if every corridor
//     read that way, left the card on "Reading routes…" forever.
//
// Neither is reachable against the current live instance, which is exactly why
// they need a test: nothing else would notice them coming back.

const here = dirname(fileURLToPath(import.meta.url));
const COMPONENT = join(here, "..", "..", "..", "frontend", "src", "components", "FlareRailStatus.tsx");
/** The instance's own env template — the source of the pin the page's
 *  ours-or-theirs test is a copy of. See the DEMO_PINNED describe block. */
const ENV_TEMPLATE = join(here, "..", "..", ".env.flare.example");

// ── builders ─────────────────────────────────────────────────────────────────

function uln(over: Partial<UlnRead> = {}): UlnRead {
  const requiredDVNs = over.requiredDVNs ?? ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
  return {
    requiredCount: requiredDVNs.length,
    optionalThreshold: 0,
    effectiveCount: requiredDVNs.length,
    optionalDVNs: [],
    names: {},
    ...over,
    requiredDVNs,
  };
}

function route(over: Partial<RouteRead> = {}): RouteRead {
  return {
    corridor: "A → B",
    eid: 30101,
    sendLibrary: "0x1111111111111111111111111111111111111111",
    sendLibIsDefault: true,
    receiveLibrary: "0x2222222222222222222222222222222222222222",
    receiveLibIsDefault: true,
    uln: uln(),
    ...over,
  };
}

/** Four required DVNs, no optional set — the shape the page is allowed to
 *  summarise in one sentence. */
const QUORUM_4 = {
  requiredDVNs: ["0xd1", "0xd2", "0xd3", "0xd4"],
  effectiveCount: 4,
  requiredCount: 4,
  names: { "0xd1": "Alpha", "0xd2": "Bravo", "0xd3": "Charlie", "0xd4": "Delta" },
};

function watched(over: Partial<WatchedRead> = {}): WatchedRead {
  return { dvnSummary: null, dvnNames: null, ...over };
}

// ── routesOf: an unreadable ULN keeps its corridor ───────────────────────────

describe("routesOf", () => {
  it("keeps a corridor whose verification set could not be read", () => {
    const routes = routesOf(
      watched({ dvnCorridors: [route({ uln: null }), route({ corridor: "A → C", eid: 30110 })] })
    );
    expect(routes).toHaveLength(2);
    expect(routes[0].uln).toBeNull();
    // The point of keeping it: the libraries live outside `uln`, so they survive
    // the failed read and the page can still show them.
    expect(routes[0].sendLibrary).toBe("0x1111111111111111111111111111111111111111");
    expect(routes[0].receiveLibrary).toBe("0x2222222222222222222222222222222222222222");
  });

  it("keeps corridors when EVERY one of them is unreadable", () => {
    // The regression that mattered: filtering these produced an empty array,
    // which the page renders as "Reading routes…" — a permanent "in progress"
    // for a permanent read failure.
    const routes = routesOf(
      watched({ dvnCorridors: [route({ uln: null }), route({ corridor: "A → C", uln: null })] })
    );
    expect(routes).toHaveLength(2);
    expect(routes.every((r) => r.uln === null)).toBe(true);
  });

  it("returns nothing when there are no corridors and no summary", () => {
    expect(routesOf(watched())).toEqual([]);
    expect(routesOf(watched({ dvnCorridors: [] }))).toEqual([]);
    expect(routesOf(watched({ dvnCorridors: null }))).toEqual([]);
  });

  it("falls back to the single-corridor summary, and synthesises nothing else", () => {
    const routes = routesOf(
      watched({
        corridors: ["A → B"],
        dvnSummary: {
          requiredCount: 2,
          optionalThreshold: 0,
          effectiveCount: 2,
          requiredDVNs: ["0xd1", "0xd2"],
          optionalDVNs: [],
        },
        dvnNames: { "0xd1": "Alpha" },
      })
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].corridor).toBe("A → B");
    expect(routes[0].uln?.effectiveCount).toBe(2);
    expect(routes[0].uln?.names).toEqual({ "0xd1": "Alpha" });
    // Absence is never filled in: the summary carries no libraries and no
    // confirmations, so those stay null/absent rather than becoming a value that
    // would be indistinguishable from a real read.
    expect(routes[0].sendLibrary).toBeNull();
    expect(routes[0].receiveLibrary).toBeNull();
    expect(routes[0].sendLibIsDefault).toBeNull();
    expect(routes[0].receiveLibIsDefault).toBeNull();
    expect(routes[0].uln?.confirmations).toBeUndefined();
  });

  it("prefers the per-route corridors over the summary when both are present", () => {
    const routes = routesOf(
      watched({
        dvnCorridors: [route({ uln: null })],
        dvnSummary: {
          requiredCount: 1,
          optionalThreshold: 0,
          effectiveCount: 1,
          requiredDVNs: ["0xd1"],
          optionalDVNs: [],
        },
      })
    );
    // An unreadable per-route read is reported as unreadable — it does not fall
    // through to a summary that would state a quorum the route did not confirm.
    expect(routes).toHaveLength(1);
    expect(routes[0].uln).toBeNull();
  });
});

// ── verificationOf / structuralNote: the page measures, it does not assert ──

describe("verificationOf and the note above the DVN rows", () => {
  // structuralNote replaced verificationNote here. The old sentence NAMED the
  // verification set whenever every route read the same one — which is exactly
  // what a third-party asset's panel may no longer say. The measurement itself
  // is unchanged: verificationOf still resolves names, because the demo asset's
  // rows still show them. Only the sentence changed.

  it("counts the verifiers on a uniform rail without naming any of them", () => {
    const routes = [route({ uln: uln(QUORUM_4) }), route({ corridor: "A → C", uln: uln(QUORUM_4) })];
    const v = verificationOf(routes);
    expect(v).toMatchObject({ routes: 2, readable: 2, min: 4, max: 4 });
    // The names are still MEASURED — they are what the demo asset's rows render.
    expect(v.names).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
    expect(structuralNote(v)).toBe(
      "This rail's 2 corridors currently read 4 verifying DVNs. " +
        "Sentinel re-reads and re-verifies this configuration every cycle."
    );
    expect(fleetLine(v)).toBe("2 routes · 4 verifying DVNs");
  });

  it("gives a range when the routes disagree, still without naming", () => {
    const other = { ...QUORUM_4, requiredDVNs: ["0xd1", "0xd2"], effectiveCount: 2, requiredCount: 2 };
    const v = verificationOf([route({ uln: uln(QUORUM_4) }), route({ uln: uln(other) })]);
    expect(v.names).toBeNull();
    expect(v.min).toBe(2);
    expect(v.max).toBe(4);
    expect(structuralNote(v)).toBe(
      "This rail's 2 corridors currently read between 2 and 4 verifying DVNs. " +
        "Sentinel re-reads and re-verifies this configuration every cycle."
    );
    expect(fleetLine(v)).toBe("2 routes · 2–4 verifying DVNs");
  });

  it("says how many corridors it could not read, rather than rounding them away", () => {
    const v = verificationOf([route({ uln: uln(QUORUM_4) }), route({ uln: null })]);
    expect(v).toMatchObject({ routes: 2, readable: 1, min: 4, max: 4 });
    expect(v.names).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
    expect(structuralNote(v)).toBe(
      "This rail's 2 corridors currently read 4 verifying DVNs. " +
        "1 of them could not be read this cycle. " +
        "Sentinel re-reads and re-verifies this configuration every cycle."
    );
    expect(fleetLine(v)).toBe("2 routes · 4 verifying DVNs · 1 unread");
  });

  it("counts an optional-DVN set the same way, and still names nothing", () => {
    const withOptional = uln({
      ...QUORUM_4,
      optionalDVNs: ["0xd5"],
      optionalThreshold: 1,
      effectiveCount: 5,
    });
    const v = verificationOf([route({ uln: withOptional })]);
    expect(v.names).toBeNull();
    const note = structuralNote(v);
    expect(note).toContain("1 corridor currently reads");
    expect(note).not.toContain("corridors");
  });

  it("says plainly when nothing was readable, and offers no stand-in", () => {
    const v = verificationOf([route({ uln: null })]);
    expect(v).toMatchObject({ routes: 1, readable: 0, min: null, max: null, names: null });
    expect(fleetLine(v)).toBe("1 route · verification set not readable this cycle");
    expect(structuralNote(v)).toBe(
      "The verification set could not be read on any of this rail's 1 corridor this cycle. " +
        "Nothing stands in for it. An unread value is never shown as a value. " +
        "Sentinel re-reads and re-verifies this configuration every cycle."
    );
  });

  // The invariant the old sentence could not have: whatever the read, the note a
  // third party's panel shows never contains a DVN operator's name. This is the
  // whole reason the function was replaced, so it is asserted directly rather
  // than inferred from the wording of any one case.
  it("never leaks a DVN name, whatever the read looks like", () => {
    const cases = [
      verificationOf([route({ uln: uln(QUORUM_4) }), route({ corridor: "A → C", uln: uln(QUORUM_4) })]),
      verificationOf([route({ uln: uln(QUORUM_4) }), route({ uln: null })]),
      verificationOf([route({ uln: uln(QUORUM_4) })]),
      verificationOf([route({ uln: null })]),
      verificationOf([]),
    ];
    for (const v of cases) {
      const note = structuralNote(v);
      for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
        expect(note, `structuralNote leaked ${name}`).not.toContain(name);
      }
      // and never a raw address either
      expect(note).not.toMatch(/0x[0-9a-fA-F]{2,}/);
    }
  });

  it("counts an empty watchlist entry as nothing rather than as safety", () => {
    const v = verificationOf([]);
    expect(v).toMatchObject({ routes: 0, readable: 0, min: null, max: null, names: null });
    expect(fleetLine(v)).toBe("0 routes · verification set not readable this cycle");
  });

  it("gets the singulars right", () => {
    const one = uln({ requiredDVNs: ["0xd1"], effectiveCount: 1, requiredCount: 1, names: { "0xd1": "Alpha" } });
    expect(fleetLine(verificationOf([route({ uln: one })]))).toBe("1 route · 1 verifying DVN");
  });

  it("names a DVN from the read, and shortens the address when it has no name", () => {
    const u = uln({
      requiredDVNs: ["0xABCDEF0123456789abcdef0123456789ABCDEF01", "0xd9"],
      effectiveCount: 2,
      requiredCount: 2,
      names: { "0xabcdef0123456789abcdef0123456789abcdef01": "Lowercased" },
    });
    expect(dvnName(u, "0xABCDEF0123456789abcdef0123456789ABCDEF01")).toBe("Lowercased");
    expect(dvnName(u, "0xd9")).toBe(short("0xd9"));
    expect(verificationOf([route({ uln: u })]).names).toEqual(["Lowercased", short("0xd9")]);
  });
});

// ── verdictIsStale: a recorded verdict stops being evidence ──────────────────

describe("verdictIsStale", () => {
  it("treats a verdict older than the snapshot as stale", () => {
    // The shipped bug: the band chip came from the fresh snapshot while the
    // findings came from this verdict, so a PASS chip sat over old CRITICALs.
    expect(verdictIsStale({ capturedAt: 1_000 }, 2_000)).toBe(true);
  });

  it("keeps a verdict captured at or after the snapshot", () => {
    expect(verdictIsStale({ capturedAt: 2_000 }, 2_000)).toBe(false);
    expect(verdictIsStale({ capturedAt: 3_000 }, 2_000)).toBe(false);
  });

  it("treats a missing verdict as stale", () => {
    expect(verdictIsStale(null, 2_000)).toBe(true);
    expect(verdictIsStale(undefined, 2_000)).toBe(true);
  });

  it("keeps a verdict when nothing has been snapshotted yet", () => {
    expect(verdictIsStale({ capturedAt: 1 }, null)).toBe(false);
    expect(verdictIsStale({ capturedAt: 0 }, null)).toBe(false);
  });
});

// ── the grid's geometry ──────────────────────────────────────────────────────

describe("columnsFor", () => {
  it("steps 3 → 2 → 1 at the widths the grid uses", () => {
    expect(columnsFor(1440)).toBe(3);
    expect(columnsFor(980)).toBe(3);
    expect(columnsFor(979)).toBe(2);
    expect(columnsFor(820)).toBe(2);
    expect(columnsFor(640)).toBe(2);
    expect(columnsFor(639)).toBe(1);
    expect(columnsFor(390)).toBe(1);
    expect(columnsFor(0)).toBe(1);
  });
});

describe("detailAfterIndex", () => {
  it("puts the panel after the last tile of the open tile's row", () => {
    const rows = (cols: number) => [0, 1, 2, 3, 4, 5].map((i) => detailAfterIndex(i, cols, 6));
    expect(rows(3)).toEqual([2, 2, 2, 5, 5, 5]);
    expect(rows(2)).toEqual([1, 1, 3, 3, 5, 5]);
    expect(rows(1)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("clamps to the last tile when the final row is ragged", () => {
    // 5 assets at 3 columns: the second row holds indices 3 and 4, and the row's
    // arithmetic names index 5, which does not exist. Without the clamp the panel
    // would never render.
    expect(detailAfterIndex(3, 3, 5)).toBe(4);
    expect(detailAfterIndex(4, 3, 5)).toBe(4);
    expect(detailAfterIndex(0, 3, 2)).toBe(1);
  });

  it("returns -1 when nothing is open", () => {
    expect(detailAfterIndex(-1, 3, 6)).toBe(-1);
    expect(detailAfterIndex(0, 3, 0)).toBe(-1);
  });
});

// ── keyed ────────────────────────────────────────────────────────────────────

describe("keyed", () => {
  it("keys a list by its own content", () => {
    expect(keyed(["a", "b"], (s) => s).map((k) => k.key)).toEqual(["a", "b"]);
  });

  it("only adds an occurrence ordinal when the content genuinely repeats", () => {
    expect(keyed(["a", "b", "a", "a"], (s) => s).map((k) => k.key)).toEqual(["a", "b", "a#1", "a#2"]);
  });

  it("keeps a surviving item's key when an earlier one clears", () => {
    // This is the reason index keys were removed: findings are re-derived every
    // cycle, and a rule that clears shifts every index below it.
    const before = keyed(["critical finding", "warning"], (s) => s);
    const after = keyed(["warning"], (s) => s);
    expect(after[0].key).toBe(before[1].key);
  });

  it("carries the item through untouched", () => {
    const item = { severity: "CRITICAL", check: "receive-library", detail: "d" };
    expect(keyed([item], (f) => `${f.severity}|${f.check}|${f.detail}`)[0].item).toBe(item);
  });
});

// ── Which asset is OURS ──────────────────────────────────────────────────────
//
// isDemoAsset is the control that decides whether a LIVE THIRD PARTY's findings
// get published on a page handed to that chain's own judges. It is the
// highest-consequence function in this module, and the two directions it can be
// wrong in are not symmetric: withholding our own detail costs depth on one
// tile; publishing somebody else's cannot be taken back. So the cases below lean
// hard on the false direction.

const DEMO_ADDR = "0x560C03079FE54Fa53e15b48C615b1ef76D6DF621";
const FLARE_CHAINS = [{ chainId: 14, chainKey: "flare" }];

describe("parseDemoPins", () => {
  it("parses the shipped pin into chain, address and ticker", () => {
    expect(parseDemoPins(DEMO_PINNED)).toEqual([
      { chainKey: "flare", address: DEMO_ADDR.toLowerCase(), ticker: "MOFT" },
    ]);
  });

  it("lowercases the chain key and the address, and leaves the ticker alone", () => {
    expect(parseDemoPins("FLARE:0xAABB:MoFt")).toEqual([
      { chainKey: "flare", address: "0xaabb", ticker: "MoFt" },
    ]);
  });

  it("takes a comma-separated list and drops every malformed entry", () => {
    // A malformed entry is DISCARDED, never half-parsed: a pin with a missing
    // field would otherwise resolve against whatever it does have.
    expect(parseDemoPins("flare:0xaaa:A, garbage, base:0xbbb:B, ::, flare: :C, a:b:c:d")).toEqual([
      { chainKey: "flare", address: "0xaaa", ticker: "A" },
      { chainKey: "base", address: "0xbbb", ticker: "B" },
    ]);
  });

  it("resolves nothing at all from an empty or blank string", () => {
    expect(parseDemoPins("")).toEqual([]);
    expect(parseDemoPins("   ")).toEqual([]);
    expect(parseDemoPins(",,,")).toEqual([]);
  });
});

describe("isDemoAsset", () => {
  const PINS = parseDemoPins(DEMO_PINNED);

  it("recognises the pinned asset on the chain the pin names", () => {
    expect(isDemoAsset({ address: DEMO_ADDR, chainId: 14 }, FLARE_CHAINS, PINS)).toBe(true);
    expect(isDemoAsset({ address: DEMO_ADDR.toLowerCase(), chainId: 14 }, FLARE_CHAINS, PINS)).toBe(true);
  });

  it("uses the module's own pin when none is passed", () => {
    expect(isDemoAsset({ address: DEMO_ADDR, chainId: 14 }, FLARE_CHAINS)).toBe(true);
  });

  it("FAILS CLOSED before the chain list has loaded", () => {
    // /status has not answered yet, so nothing resolves the pin's chain key.
    // Our OWN asset then reads as a third party's and its findings stay
    // withheld. That is the direction this is supposed to fail in.
    expect(isDemoAsset({ address: DEMO_ADDR, chainId: 14 }, [], PINS)).toBe(false);
  });

  it("right address, wrong chain ⇒ false", () => {
    // Same bytecode deployed to another chain is a DIFFERENT asset, and quite
    // possibly not ours.
    expect(
      isDemoAsset({ address: DEMO_ADDR, chainId: 1 }, [{ chainId: 1, chainKey: "ethereum" }, ...FLARE_CHAINS], PINS)
    ).toBe(false);
  });

  it("the pin's chain key resolving to a different chainId ⇒ false", () => {
    expect(isDemoAsset({ address: DEMO_ADDR, chainId: 14 }, [{ chainId: 114, chainKey: "flare" }], PINS)).toBe(false);
  });

  it("a chain row with no chain key never satisfies a pin", () => {
    expect(isDemoAsset({ address: DEMO_ADDR, chainId: 14 }, [{ chainId: 14, chainKey: null }], PINS)).toBe(false);
    expect(isDemoAsset({ address: DEMO_ADDR, chainId: 14 }, [{ chainId: 14 }], PINS)).toBe(false);
  });

  it("a third party whose TICKER collides with ours is still a third party", () => {
    // The mirror image of the failure this page already shipped once. A ticker
    // is a label anyone can choose; the identity here is chain + address, and
    // the ticker is not consulted at all — so a live token carrying the same
    // three letters is never promoted to full disclosure.
    const impostor = { address: "0x00000000000000000000000000000000deadbeef", chainId: 14, ticker: "MOFT" };
    expect(isDemoAsset(impostor, FLARE_CHAINS, PINS)).toBe(false);
  });

  it("an unparseable pin resolves nothing", () => {
    for (const raw of ["", "garbage", "flare:not-an-address", "::"]) {
      expect(
        isDemoAsset({ address: DEMO_ADDR, chainId: 14 }, FLARE_CHAINS, parseDemoPins(raw)),
        `pin ${JSON.stringify(raw)} resolved something`
      ).toBe(false);
    }
  });
});

describe("DEMO_PINNED matches the backend's ATTEST_PINNED", () => {
  // The safety net the comment above DEMO_PINNED promises, which did not exist
  // until fix round 1. DEMO_PINNED is a hand-copied duplicate of a backend env
  // value — there is no shared module between the two trees — and the reason a
  // reader is asked to trust that duplication is precisely this test. Re-pin the
  // demo asset in the backend, forget the frontend, and the suite goes red
  // instead of the page quietly publishing a third party's findings.
  it("is byte-identical to ATTEST_PINNED in backend/.env.flare.example", () => {
    const env = readFileSync(ENV_TEMPLATE, "utf8");
    const line = env.split("\n").find((l) => l.startsWith("ATTEST_PINNED="));
    expect(line, "ATTEST_PINNED is not set in backend/.env.flare.example").toBeDefined();
    const attestPinned = line!.slice("ATTEST_PINNED=".length).trim();
    expect(attestPinned, "ATTEST_PINNED is empty — it attests nothing, and pins nothing").not.toBe("");
    expect(DEMO_PINNED).toBe(attestPinned);
  });
});

// ── What a third-party asset is allowed to say ───────────────────────────────

describe("publicRead", () => {
  // Synthetic verifier names, matching the ones the builders above use. Real
  // operator names and real finding prose stay out of this tree by standing
  // rule; the assertion is about the FUNCTION, and it is exactly as strong
  // against an invented name as against a real one.
  const REASONS = [
    "Alpha is the sole required DVN on this corridor",
    "Bravo can change the receive configuration without a second verifier",
  ];

  it("returns the COUNT of the findings and never one of the findings", () => {
    const read = publicRead(REASONS, [route({ uln: uln(QUORUM_4) })]);
    expect(read.findings).toBe(2);
    const serialised = JSON.stringify(read);
    for (const leak of ["Alpha", "Bravo", "sole required DVN", "receive configuration"]) {
      expect(serialised, `publicRead leaked "${leak}"`).not.toContain(leak);
    }
  });

  it("carries counts and structure, and nothing else at all", () => {
    // toEqual on the whole value, deliberately: a field ADDED to PublicRead
    // later is a field the third-party panel can render, so it has to break
    // this test on the way in.
    expect(publicRead([], [route({ uln: uln(QUORUM_4) }), route({ corridor: "A → C", uln: null })])).toEqual({
      findings: 0,
      corridors: 2,
      structural: [
        { corridor: "A → B", dvnCount: 4, sendLib: "default", receiveLib: "default" },
        { corridor: "A → C", dvnCount: null, sendLib: "default", receiveLib: "default" },
      ],
    });
  });

  it("carries no address either — not the DVNs', not the libraries'", () => {
    const read = publicRead(REASONS, [route({ uln: uln(QUORUM_4) })]);
    expect(JSON.stringify(read)).not.toMatch(/0x[0-9a-fA-F]{2,}/);
  });

  it("counts nothing as nothing, rather than as safety", () => {
    expect(publicRead([], [])).toEqual({ findings: 0, corridors: 0, structural: [] });
  });
});

describe("libState and structuralRoutes", () => {
  it("says pinned or default, and says NOTHING when the flag was not read", () => {
    expect(libState(false)).toBe("pinned");
    expect(libState(true)).toBe("default");
    // null, not "default" — absence is never rendered as a state, and least of
    // all as the safe-sounding one.
    expect(libState(null)).toBeNull();
    expect(libState(undefined)).toBeNull();
  });

  it("reduces a corridor to structure, dropping every address and every name", () => {
    expect(
      structuralRoutes([route({ sendLibIsDefault: false, receiveLibIsDefault: null, uln: uln(QUORUM_4) })])
    ).toEqual([{ corridor: "A → B", dvnCount: 4, sendLib: "pinned", receiveLib: null }]);
  });

  it("reports an unreadable verification set as null, never as zero verifiers", () => {
    // Zero would read as "nothing verifies this route", which is a much worse
    // claim than "we could not read it".
    expect(structuralRoutes([route({ uln: null })])[0].dvnCount).toBeNull();
  });

  it("is empty for an empty route list", () => {
    expect(structuralRoutes([])).toEqual([]);
  });
});

describe("findingsLine, countsLine and withheldNote", () => {
  it("gets the zero, the singular and the plural right", () => {
    expect(findingsLine(0)).toBe("no findings");
    expect(findingsLine(1)).toBe("1 finding");
    expect(findingsLine(2)).toBe("2 findings");
    expect(findingsLine(28)).toBe("28 findings");
  });

  it("pairs the finding count with the corridor count", () => {
    expect(countsLine(3, 1)).toBe("3 findings · 1 corridor");
    expect(countsLine(1, 2)).toBe("1 finding · 2 corridors");
    expect(countsLine(0, 0)).toBe("no findings · 0 corridors");
  });

  it("states the counts AND the omission, so a short panel is never merely silent", () => {
    const note = withheldNote(3, 2);
    expect(note).toContain("3 findings · 2 corridors");
    expect(note).toContain("withheld here");
    expect(note).toContain("for the OFT we deployed ourselves, and no other");
  });

  it("names nothing, whatever the counts", () => {
    for (const [f, c] of [[0, 0], [1, 1], [28, 5]] as const) {
      const note = withheldNote(f, c);
      expect(note).not.toMatch(/0x[0-9a-fA-F]{2,}/);
      for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
        expect(note).not.toContain(name);
      }
    }
  });
});

describe("WITHHELD_LINE", () => {
  it("states both halves: what is withheld, and what every tile still shows", () => {
    // Half a sentence here is worse than none. "Findings are withheld" alone
    // invites the reading that the page is hiding a verdict; the second clause
    // is what makes the omission legible as a scope decision.
    expect(WITHHELD_LINE).toContain("only for the demo OFT we deployed ourselves");
    expect(WITHHELD_LINE).toContain("how many findings");
    expect(WITHHELD_LINE).not.toMatch(/0x[0-9a-fA-F]{2,}/);
  });
});

// ── Clocks ───────────────────────────────────────────────────────────────────

describe("utc", () => {
  it("formats to the minute, in UTC, with no seconds and no local offset", () => {
    expect(utc(Date.UTC(2026, 7, 8, 1, 26, 45))).toBe("2026-08-08 01:26 UTC");
  });

  it("renders a dash rather than the epoch when there is no timestamp", () => {
    expect(utc(null)).toBe("—");
    expect(utc(undefined)).toBe("—");
    expect(utc(0)).toBe("—");
  });
});

describe("ago", () => {
  const T = Date.UTC(2026, 7, 8, 3, 0, 0);

  it("says plainly when nothing has been read", () => {
    expect(ago(null, T)).toBe("not read yet");
    expect(ago(undefined, T)).toBe("not read yet");
    expect(ago(0, T)).toBe("not read yet");
  });

  it("CLAMPS AT ZERO when the reader's clock is behind the server's", () => {
    // These timestamps come from the server and the reader's clock can trail
    // it, which used to render as "-4s ago" — a page appearing to know about
    // the future is a page nobody trusts about the present.
    expect(ago(T + 4_000, T)).toBe("0s ago");
    expect(ago(T + 86_400_000, T)).toBe("0s ago");
  });

  it("steps s → m → h → d at each unit boundary", () => {
    expect(ago(T, T)).toBe("0s ago");
    expect(ago(T - 59_000, T)).toBe("59s ago");
    expect(ago(T - 60_000, T)).toBe("1m ago");
    expect(ago(T - 3_599_000, T)).toBe("59m ago");
    expect(ago(T - 3_600_000, T)).toBe("1h ago");
    expect(ago(T - 86_399_000, T)).toBe("23h ago");
    expect(ago(T - 86_400_000, T)).toBe("1d ago");
    expect(ago(T - 3 * 86_400_000, T)).toBe("3d ago");
  });
});

// ── The DVN metadata this fleet was scored against ───────────────────────────

describe("metaLine", () => {
  const T = Date.UTC(2026, 7, 8, 3, 0, 0);
  const TEN_MIN_AGO = T - 600_000;

  it("says the instance did not report a fetch time, rather than inventing one", () => {
    const line = "DVN metadata: this instance did not report a fetch time";
    expect(metaLine(null, false, T)).toBe(line);
    expect(metaLine(undefined, false, T)).toBe(line);
    expect(metaLine(0, false, T)).toBe(line);
    // and an unknown fetch time is never dressed up as a known-but-stale one
    expect(metaLine(undefined, true, T)).toBe(line);
  });

  it("states when the table was fetched, and how long ago", () => {
    expect(metaLine(TEN_MIN_AGO, false, T)).toBe("DVN metadata fetched 2026-08-08 02:50 UTC · 10m ago");
  });

  it("marks a cached table STALE in the line itself, not only in its colour", () => {
    expect(metaLine(TEN_MIN_AGO, true, T)).toBe(
      "DVN metadata fetched 2026-08-08 02:50 UTC · 10m ago · STALE · scored against a cached table"
    );
  });

  it("keeps the fresh line a strict prefix of the stale one", () => {
    // So the page can colour the stale case without the two lines drifting
    // apart in wording.
    expect(metaLine(TEN_MIN_AGO, true, T).startsWith(metaLine(TEN_MIN_AGO, false, T))).toBe(true);
  });
});

describe("META_CAVEAT", () => {
  it("keeps the determinism claim and names only what 'a given input' excludes", () => {
    expect(META_CAVEAT).toContain("deterministic for a given input");
    expect(META_CAVEAT).toContain("DVN metadata");
    expect(META_CAVEAT).toContain("no on-chain change");
  });

  it("stays at the level of the property — no incident, no address", () => {
    expect(META_CAVEAT).not.toMatch(/exploit|incident|attack|breach|hack/i);
    expect(META_CAVEAT).not.toMatch(/0x[0-9a-fA-F]{2,}/);
  });
});

// ── the extraction has to stay the page's real logic ─────────────────────────

describe("the rail page uses this module", () => {
  const src = readFileSync(COMPONENT, "utf8");

  it("imports the logic instead of carrying its own copy", () => {
    expect(src).toContain('from "../rail-logic.ts"');
    // A second copy of any of these in the component would leave every test
    // above passing while the page ran different code.
    for (const fn of [
      "routesOf",
      "verificationOf",
      "structuralNote",
      "fleetLine",
      "columnsFor",
      "keyed",
      "dvnName",
      "verdictIsStale",
      "detailAfterIndex",
    ]) {
      expect(src, `${fn} is redefined in the component`).not.toContain(`function ${fn}`);
    }
  });

  it("computes the panel's position rather than open-coding the arithmetic", () => {
    expect(src).toContain("detailAfterIndex(openIndex, cols, assets.length)");
  });

  // ── the two statements the page has to make about ITSELF ───────────────────
  //
  // Both of these were written, imported and never called. They shipped as dead
  // code, the bundler removed them, and the exported README told judges the page
  // showed one of them. The generic import-usage guard below catches "imported
  // and unused"; these two catch "removed from the page entirely", which the
  // generic one cannot, because deleting the import too makes it go quiet.
  //
  // `> src.indexOf("export function FlareRailStatus")` is the PAGE-LEVEL part:
  // rendering either of these inside a panel body would satisfy a bare
  // toContain while still being invisible until a reader expands a tile.

  it("renders the DVN metadata's fetch time, and the caveat that goes with it", () => {
    expect(src).toContain("metaLine(status?.dvnMeta?.fetchedAt");
    expect(src).toContain("{META_CAVEAT}");
    expect(src.indexOf("{META_CAVEAT}")).toBeGreaterThan(src.indexOf("export function FlareRailStatus"));
    // The stale mark is driven off the boolean, not off the wording metaLine
    // returns — a page that greps its own copy for "STALE" breaks when the
    // sentence is reworded.
    expect(src).toContain("status?.dvnMeta?.stale ?? false");
    expect(src, "the stale mark reads the rendered string instead of the flag").not.toContain(
      'includes("STALE")'
    );
  });

  it("states the withholding at page level, not only inside a panel", () => {
    expect(src).toContain("{WITHHELD_LINE}");
    expect(src.indexOf("{WITHHELD_LINE}")).toBeGreaterThan(
      src.indexOf("export function FlareRailStatus")
    );
    // and the per-panel note stays: the two are different registers, not
    // duplicates — one explains the page, one carries that asset's counts.
    expect(src).toContain("withheldNote(");
  });
});

// ── imported and never used: the defect class, not the two defects ───────────
//
// Requirement 2 and the page-level withholding line were BOTH shipped as a
// symbol imported from rail-logic into the component and never called. Neither
// tsconfig sets `noUnusedLocals`, so tsc stayed green; rollup then tree-shook
// the dead symbols out, so the feature was absent from the bundle and from the
// rendered page while the source still read as if it were there.
//
// This is a cheap deterministic oracle for exactly that: every identifier the
// component imports from rail-logic must appear somewhere in the file OUTSIDE
// the import statement it came from. It catches the class, not the two
// instances, and it costs one file read.
//
// It is deliberately NOT `noUnusedLocals` repo-wide — the cascade across two
// tsconfigs and every other file is unknown, and this is the file that matters.

describe("every symbol the page imports from rail-logic is used", () => {
  const src = readFileSync(COMPONENT, "utf8");

  /** Comments are not uses. Without this the guard is satisfied by prose: the
   *  first version of it passed on a page where `WITHHELD_LINE` was dead,
   *  because a `// … WITHHELD_LINE for what the page says …` comment several
   *  hundred lines away mentioned the name. A guard a comment can satisfy is
   *  not a guard.
   *
   *  Block comments go first (that covers the `{/* … *\/}` JSX form). Line
   *  comments are then cut only where `//` is not preceded by `:`, so the
   *  `https://…` in an href survives and does not take the rest of its line
   *  with it. */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  /** The identifiers of every `… from "../rail-logic.ts"` import in the file,
   *  plus the source with those import statements cut out. Both value and
   *  `import type` forms — a dead type import is the same defect. */
  function railLogicImports(text: string): { names: string[]; body: string } {
    const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"\.\.\/rail-logic\.ts";/g;
    const names: string[] = [];
    let body = text;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      for (const raw of m[1].split(",")) {
        // `x as y` binds y locally; y is the identifier that has to be used.
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) names.push(name);
      }
      body = body.replace(m[0], "");
    }
    return { names, body: stripComments(body) };
  }

  it("does not accept a comment as a use", () => {
    const fake =
      'import { ALPHA, BETA } from "../rail-logic.ts";\n' +
      "// ALPHA is described here and used nowhere\n" +
      "{/* BETA too */}\n" +
      'const href = "https://example.com/x"; // trailing\n';
    const { names, body } = railLogicImports(fake);
    expect(names).toEqual(["ALPHA", "BETA"]);
    expect(body).not.toMatch(/\bALPHA\b/);
    expect(body).not.toMatch(/\bBETA\b/);
    // …and the URL's `//` did not eat the code on its line.
    expect(body).toContain("https://example.com/x");
  });

  it("finds the import list at all, so the check below cannot go vacuous", () => {
    const { names, body } = railLogicImports(src);
    expect(names.length).toBeGreaterThan(10);
    expect(body).not.toContain('from "../rail-logic.ts"');
  });

  it("uses every identifier it imports, somewhere outside the import statement", () => {
    const { names, body } = railLogicImports(src);
    for (const name of names) {
      expect(
        body,
        `${name} is imported from rail-logic and never used — tsc will not tell you, ` +
          `and the bundler will silently drop whatever it was for`
      ).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});

// ── the third-party render path may not reach a name ──────────────────────────
//
// publicRead() hands a third-party panel counts and structure, never prose, and
// structuralNote() is tested above never to leak a name. Neither is worth much
// if the component can reach past them to `assessment.reasons` or `uln.names`
// directly. This walks the render path a NON-demo asset actually takes and
// pins that it cannot.
//
// Reaching for the raw field is exactly the shortcut a later change makes when
// someone wants "just the severity" on a tile — and it would republish a live
// third party's configuration without a single test going red.

describe("a third-party asset's panel cannot reach a DVN name", () => {
  const src = readFileSync(COMPONENT, "utf8");

  /** Source of one top-level `function Name(...) { ... }`, closing brace at col 0. */
  function bodyOf(name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start, `${name} not found in the component`).toBeGreaterThan(-1);
    const end = src.indexOf("\n}", start);
    expect(end, `${name} has no top-level close`).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  // RailBody is what a non-demo asset renders. DemoBody is deliberately absent:
  // full detail there is the point.
  const PUBLIC_PATH = ["RailBody", "StructuralRouteBlock", "ReadFooter"];

  // The brief forbids SIX things on a third-party panel: `assessment.reasons`,
  // `tis[].reason`, `tis[].currentState`, `tis[].targetState`, and any DVN
  // operator name. Until fix round 1 this list named only the first and the
  // last, which left a hole with a name: `{w.assessment?.tis?.map((t) => t.reason)}`
  // inside RailBody would have republished a live third party's remediation
  // prose and passed EVERY test in this suite — "reason" singular is not a
  // substring of "reasons", and nothing else in the old list matched.
  //
  // `assessment` is here too, and it is the one that makes the rest belt-and-
  // braces: after the RailBody prop narrowing there is no `WatchedStatus` in
  // scope on this path at all, so reaching any of these fields requires first
  // widening a prop type — a visible change this file would also have to be
  // edited to allow.
  const FORBIDDEN = [
    "reasons",
    "reason",
    "tis",
    "currentState",
    "targetState",
    ".names",
    "dvnName",
    "DvnRow",
    ".detail",
    "assessment",
  ];

  it("renders none of the fields that carry a finding or a verifier's name", () => {
    for (const fn of PUBLIC_PATH) {
      const body = bodyOf(fn);
      for (const forbidden of FORBIDDEN) {
        expect(body, `${fn} reaches ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("hands the public path identity, not the record identity came from", () => {
    // The prop type IS the narrowing. RailBody used to take the whole
    // `WatchedStatus` — for the three fields its footer needed — while the
    // comment above it claimed the prop type made a leak impossible. It did
    // not: every forbidden field was in scope and type-legal the whole time.
    const railBody = bodyOf("RailBody");
    expect(railBody).toContain("id: AssetIdentity");
    expect(railBody, "RailBody is holding the whole watched record again").not.toContain(
      "WatchedStatus"
    );
    expect(bodyOf("ReadFooter"), "ReadFooter is on the public path too").not.toContain(
      "WatchedStatus"
    );
  });

  it("still routes demo and non-demo to different bodies", () => {
    // If these ever collapse into one component the test above goes vacuous —
    // it would be checking a path nothing takes.
    expect(src).toContain("<DemoBody");
    expect(src).toContain("<RailBody");
    expect(src).toMatch(/demo\s*\?/);
  });

  it("decides ours-or-theirs by pinned identity, not by ticker", () => {
    expect(src).toContain("isDemoAsset(");
    // A ticker comparison is how this was decided before, and a ticker is not an
    // identity — any asset can carry the same three letters on another chain.
    expect(src).not.toMatch(/ticker\s*\.toUpperCase\(\)\s*===/);
    expect(src).not.toContain("DEMO_TICKER");
  });
});
