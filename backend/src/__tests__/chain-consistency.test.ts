import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AddressInfo } from "node:net";

// This suite exists because the previous round's tests pinned the four hardcoded
// chain sites that had already been found, and four more stayed invisible. A test
// that lists known instances does not stop the next one. These assert the CLASS:
//
//   A. no chain or network proper noun appears in a user-facing string, anywhere
//      in the shipped surfaces — the test does not know or care which chains we
//      currently ship to;
//   B. per-asset store reads use the asset's own chain id, so a read and a write
//      can never key differently (the IMP-3 asymmetry, which no test noticed
//      because both halves were individually correct).

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(here, "..");
const FRONTEND = join(here, "..", "..", "..", "frontend", "src");
const ROOT = join(BACKEND, "..", "..");
const rel = (abs: string) => relative(ROOT, abs);

/** Source with comments removed. Explaining a past mistake must stay legal;
 *  shipping the string must not.
 *
 *  Block comments are replaced by the SAME NUMBER of newlines rather than
 *  deleted: collapsing them shifted every line number this test reports, so a
 *  failure pointed at the wrong line — a diagnostic that lies is worse than none. */
function code(abs: string): string {
  return readFileSync(abs, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length))
    // `\s` matches newlines, so `^\s*//` swallowed a preceding blank line and
    // shifted every number below it — the second line-number bug in this helper.
    // `[^\S\n]` is horizontal whitespace only, which is what "indentation" means.
    .replace(/^[^\S\n]*\/\/.*$/gm, "")
    .replace(/[^\S\n]\/\/.*$/gm, "");
}

// ── A/B. Chain identity is never hardcoded ───────────────────────────────────
//
// TWO checks with deliberately DIFFERENT scopes, because one check cannot make
// an honest claim about both. Round 1 shipped a single case-SENSITIVE scan while
// claiming it caught "the next hardcoded chain" — but `const srcChainKey =
// "mantle";`, verbatim the worst bug this sequence found, passed it silently.
// Rather than leave a broad claim over a narrow check, the claim is now split so
// each half says exactly what it covers.

const CHAIN_WORDS = [
  "Mantle", "Sepolia", "Flare", "Ethereum", "Arbitrum", "Optimism", "Polygon",
  "Avalanche", "Berachain", "Hyperliquid", "Linea", "Scroll", "zkSync", "Fantom",
  "Gnosis", "Celo", "Blast", "Zora", "Sonic", "Unichain", "Plasma", "Monad",
  "Mainnet", "Testnet",
];

// CHECK A — DISPLAY NAMES. Case-sensitive, because a capitalised chain name in
// source is nearly always copy shown to a user. "Base" is included here only:
// capitalised it is a chain, lowercase it is `const base = …` everywhere.
const DISPLAY_RE = new RegExp(`\\b(${[...CHAIN_WORDS, "Base"].join("|")})\\b`);

// CHECK B — CHAIN KEYS. Case-INSENSITIVE, over the modules that RESOLVE chain
// identity and must therefore never contain a chain literal in any casing. This
// is the check that catches `srcChainKey = "mantle"`. "Base" is excluded: as a
// bare lowercase word it is a variable name in half these files, and a guard
// that cries wolf gets switched off.
const KEY_RE = new RegExp(`\\b(${CHAIN_WORDS.join("|")})\\b`, "i");

// ── The scanned set is WALKED, not hand-listed ───────────────────────────────
//
// This used to be twelve hand-written paths under a comment claiming coverage of
// user-facing strings "anywhere in the shipped surfaces". A hand list cannot make
// that claim — a file added later ships unscanned — and one already had:
// `frontend/src/api.ts` threw `"Failed to load Mantle OFTs"` at a user, on a
// fleet that is not on Mantle, in exactly the class this guard says it closes.
//
// So the set is derived from the tree. Every .ts/.tsx file under frontend/src,
// backend/src/services and backend/src/routes is scanned the day it lands, and
// staying out of it costs an explicit EXCLUDED entry with a stated reason —
// the same necessity discipline ALLOWED already carries, checked the same way.
const SHIPPED_SURFACES = [FRONTEND, join(BACKEND, "services"), join(BACKEND, "routes")];

/** Every .ts/.tsx file under `dir`, recursively. CSS carries no chain claims and
 *  no logic; the two HTML entries sit outside these trees and are named below. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = join(dir, e.name);
    if (e.isDirectory()) return sourcesUnder(abs);
    return /\.tsx?$/.test(e.name) ? [abs] : [];
  });
}

const WALKED = SHIPPED_SURFACES.flatMap(sourcesUnder).sort();

// Files deliberately NOT scanned by CHECK A, each on the record — silence is the
// failure mode here. Checked below for existence and for NECESSITY: an entry that
// suppresses nothing is dead and has to go.
//
// Two more files are excluded from CHECK B only, and stay in CHECK A:
//   services/sentinel.ts   chainAllowed("mantle") and the Mantle watchlist are
//                          Mantle-scoped by design, and the replay fixtures use
//                          "ethereum" as synthetic data.
//   routes/sentinel.ts     its lowercase chain names are input-format examples in
//                          advisory copy ("a chain name like \"ethereum\""), not
//                          identity. CHECK A is where IMP-3 lived.
const EXCLUDED = new Map<string, string>([
  [
    "backend/src/services/chain-registry.ts",
    "IS the chain table — naming chains is its job, and it is where the explorer, RPC and native-currency literals were deliberately centralised",
  ],
  [
    "backend/src/services/drift.ts",
    'engine file: zero edits, byte-identical to upstream. Its hits are the multisig product name "Gnosis Safe", not a chain claim — and a guard must never be in a position to demand an edit to a file the submission claims is unmodified',
  ],
  [
    "frontend/src/components/FlowAnimation.tsx",
    "decorative canvas: chain badges on an illustration, no figures and no claims",
  ],
]);

const SCANNED = WALKED.filter((f) => !EXCLUDED.has(rel(f)));

// Surfaces whose strings reach a user: everything walked above, plus the two HTML
// entries. HTML ships the <title> and <meta description> — the most-read text on
// the site and, until it was listed, entirely invisible to this guard. That is how
// "Autonomous OFT Security on Mantle" survived every sweep.
const USER_FACING = [
  ...SCANNED,
  join(FRONTEND, "..", "index.html"),
  join(FRONTEND, "..", "flare.html"),
];

// Modules that resolve chain identity. A literal here is a bug in ANY casing.
const IDENTITY_MODULES = [
  join(BACKEND, "services/report.ts"),
  join(BACKEND, "services/alerts.ts"),
  join(BACKEND, "services/attestor.ts"),
  // ask.ts writes the copilot's system prompt, which told the model the fleet's
  // chain in prose. A prompt is a user-facing string with an extra step: the
  // model repeats what the prompt asserts, so a hardcoded chain there names the
  // wrong chain in every answer. Same defect class as the page copy, one layer
  // further back — and invisible to a guard that only scanned modules.
  join(BACKEND, "services/ask.ts"),
  join(FRONTEND, "explorer.ts"),
];

// Exact lines that legitimately carry a chain word, with the reason each is
// allowed. EXACT STRINGS, not patterns: a NEW hardcoded name still fails inside
// these same files. The list is meant to shrink, so it is checked for rot below.
const ALLOWED = new Map<string, string>([
  ["<span>Flare Summer Signal · 2026</span>", "program name, not a chain claim"],
  ['<span style={{ fontFamily: "var(--mono)", fontSize: "12px" }}>Flare Summer Signal · 2026</span>',
   "program name, not a chain claim"],
  ["<span className=\"dot\"></span> Flare Summer Signal 2026", "program name, not a chain claim"],
  // flare.html is the entry point for the Flare-specific page. A static <head>
  // cannot read /status, so its own subject is named literally — the same reason
  // the rail page's title was allowed before it became derivable in React.
  ["<title>Flare OFT Rail Status — OFT Sentinel</title>", "static <head> of the Flare-specific entry point"],
  ['<meta name="description" content="Deterministic LayerZero config monitoring for the OFT rails on Flare. Sentinel re-reads each rail\'s cross-chain configuration every cycle and publishes verdicts anyone can recompute from the same rules." />',
   "static <head> of the Flare-specific entry point"],
]);

describe("no hardcoded chain or network names in user-facing strings", () => {
  it.each(USER_FACING)("display names — %s", (file) => {
    const hits = code(file)
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => DISPLAY_RE.test(line) && !ALLOWED.has(line));
    expect(
      hits.map((h) => `${h.n}: ${h.line}`),
      "hardcoded chain/network name — derive it from /status or the chain registry",
    ).toEqual([]);
  });

  it.each(IDENTITY_MODULES)("chain keys, any casing — %s", (file) => {
    const hits = code(file)
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => KEY_RE.test(line) && !ALLOWED.has(line));
    expect(
      hits.map((h) => `${h.n}: ${h.line}`),
      'chain literal in an identity-resolving module — this is the `srcChainKey = "mantle"` shape',
    ).toEqual([]);
  });

  it("catches a chain name if one is reintroduced (guards are live, not vacuous)", () => {
    expect(DISPLAY_RE.test('const label = "AuditRegistry · Mantle Sepolia";')).toBe(true);
    expect(DISPLAY_RE.test('"Fetching live DVN config from Flare"')).toBe(true);
    expect(DISPLAY_RE.test("const base = explorerBase(chainId);")).toBe(false);
    expect(DISPLAY_RE.test("const db = database.query();")).toBe(false);

    // The hole the Task 16 re-review found: lowercase and ALL-CAPS chain keys.
    expect(DISPLAY_RE.test('const srcChainKey = "mantle";')).toBe(false); // check A misses it, by design
    expect(KEY_RE.test('const srcChainKey = "mantle";')).toBe(true);      // check B does not
    expect(KEY_RE.test('const k = "MANTLE";')).toBe(true);
    expect(KEY_RE.test("const base = byChainId[chainId];")).toBe(false);  // no false positive on `base`
  });

  it("every allowlist entry is NECESSARY — removing it must make some file fail", () => {
    // The previous version asserted the line still EXISTS somewhere. That cannot
    // detect an entry which is present but no longer suppresses anything — the
    // reviewer deleted a dead entry and all 25 tests stayed green. Necessity is
    // the property we actually want: an entry earns its place only if the guard
    // would flag something without it.
    const sources = [
      ...USER_FACING.map((f) => [f, code(f), DISPLAY_RE] as const),
      ...IDENTITY_MODULES.map((f) => [f, code(f), KEY_RE] as const),
    ];
    for (const [entry, reason] of ALLOWED) {
      const withoutThis = new Map(ALLOWED);
      withoutThis.delete(entry);
      const stillSuppressed = sources.some(([, src, re]) =>
        src.split("\n").some((l) => {
          const t = l.trim();
          return re.test(t) && !withoutThis.has(t) && t === entry;
        }),
      );
      expect(stillSuppressed, `allowlist entry is DEAD — delete it (${reason}): ${entry}`).toBe(true);
    }
  });
});

// ── A2. The guard's SCOPE is itself checked ──────────────────────────────────
//
// The checks above are only as good as the set of files they run over. When that
// set was hand-written, a file could ship without ever being looked at — and one
// did. These three tests are about the walk rather than about any one file.

describe("the guard's scope covers the shipped surfaces", () => {
  it("every source file under the shipped surfaces is scanned or excluded with a reason", () => {
    const unaccounted = WALKED.map(rel).filter(
      (r) => !SCANNED.map(rel).includes(r) && !EXCLUDED.has(r),
    );
    expect(
      unaccounted,
      "a shipped source file is in neither set — add it to EXCLUDED with a reason, or let it be scanned",
    ).toEqual([]);

    // Non-vacuity: a walk that returned nothing would make every it.each above
    // pass for free, silently. These two files are named because they are the
    // reason this test exists — api.ts is what slipped the old hand list, and
    // orchestrator.ts composes the `verdict:` strings that render on the page.
    const walked = WALKED.map(rel);
    expect(walked.length).toBeGreaterThan(25);
    expect(walked).toContain("frontend/src/api.ts");
    expect(walked).toContain("backend/src/services/orchestrator.ts");
    expect(new Set(walked).size).toBe(walked.length);
  });

  it("every EXCLUDED entry names a real file and is NECESSARY", () => {
    for (const [path, reason] of EXCLUDED) {
      const abs = join(ROOT, path);
      expect(existsSync(abs), `EXCLUDED names a file that is gone: ${path}`).toBe(true);
      // Same necessity property as ALLOWED: an exclusion earns its place only if
      // the guard would flag the file without it. One that suppresses nothing is
      // dead weight that makes the scope look smaller than it is.
      const hits = code(abs)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => DISPLAY_RE.test(l) && !ALLOWED.has(l));
      expect(
        hits.length,
        `EXCLUDED entry is DEAD — delete it and let the file be scanned (${reason}): ${path}`,
      ).toBeGreaterThan(0);
    }
  });

  it("no shipped source file contains a raw NUL byte", () => {
    // A raw NUL makes git and GitHub treat a source file as binary: `git diff`
    // prints "Binary files differ" and the web UI refuses to render it at all.
    // orchestrator.ts carried two inside a template literal — in the one file
    // holding both attest-scope call sites, i.e. the file a reader checking the
    // safety claim would want to open. The escape form has the identical runtime
    // value and keeps the file readable as text.
    const binary = WALKED.filter((f) => readFileSync(f).includes(0)).map(rel);
    expect(binary, "raw NUL byte in a source file — use the \\u0000 escape").toEqual([]);
  });
});

// ── B. Reads and writes must key on the same chain id ────────────────────────

describe("score history keys on the asset's own chain", () => {
  it("a history written under one chain id is not readable under another", async () => {
    // Unique address per run, so the assertion does not depend on what earlier
    // runs left in the store. snapshot-store resolves DATA_DIR at module load,
    // which makes per-test directory isolation brittle; a unique key is the
    // simpler way to be deterministic, and it tests the same invariant.
    const store = await import("../services/snapshot-store.js");
    const oft = `0x${Date.now().toString(16)}${"0".repeat(24)}`.slice(0, 42);

    expect(store.getScoreHistory(oft, 14)).toEqual([]); // nothing under this key yet
    store.appendScoreHistory({ oft, chainId: 14, score: 75, riskLevel: "AT_RISK", capturedAt: 1 });

    // Same key → found. This is the invariant the route must respect.
    expect(store.getScoreHistory(oft, 14)).toHaveLength(1);
    // Different key → empty, and indistinguishable from "never polled". That
    // silence is why a hardcoded read chain id produced blank charts rather
    // than an error: nothing anywhere could tell the two apart.
    expect(store.getScoreHistory(oft, 5000)).toEqual([]);
  });
});

describe("history routes read with the watched asset's chain id", () => {
  const OFT = "0x560C03079FE54Fa53e15b48C615b1ef76D6DF621";
  const FLARE = 14;
  let server: ReturnType<express.Express["listen"]> | null = null;

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    server?.close();
    server = null;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /** Boot the REAL router in-process. No new dependency: express is already a
   *  runtime dep, so this drives the actual handler rather than a copy of its
   *  logic — which is the only way to catch an argument the handler chooses. */
  async function startRouter(getScoreHistory: ReturnType<typeof vi.fn>) {
    vi.doMock("../services/sentinel.js", () => ({
      getWatched: vi.fn().mockResolvedValue([{ ticker: "MOFT", address: OFT, chainId: FLARE }]),
      getWatchlistHealth: () => ({ degraded: false, reasons: [], lastRefreshAt: 1, servedStaleAt: null }),
      pollOnce: vi.fn(), runKelpReplay: vi.fn(), runLibraryRevertReplay: vi.fn(),
      runRpcConflictReplay: vi.fn(), resetDemo: vi.fn(),
    }));
    vi.doMock("../services/snapshot-store.js", () => ({
      getScoreHistory,
      getVerdicts: () => [], getSnapshot: () => null, latestVerdict: () => null,
      getFeedEvents: () => [],
    }));
    const { router } = await import("../routes/sentinel.js");
    const app = express();
    app.use(express.json());
    app.use("/api/sentinel", router);
    server = app.listen(0);
    await new Promise((r) => server!.once("listening", r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it("GET /history/:address uses the asset's chain id, not a hardcoded one", async () => {
    const getScoreHistory = vi.fn().mockReturnValue([{ score: 75, riskLevel: "AT_RISK", capturedAt: 1 }]);
    const base = await startRouter(getScoreHistory);

    const res = await fetch(`${base}/api/sentinel/history/${OFT.toLowerCase()}`);
    const body = await res.json();

    expect(getScoreHistory).toHaveBeenCalled();
    const [, chainIdArg] = getScoreHistory.mock.calls[0];
    expect(chainIdArg).toBe(FLARE); // was MANTLE_CHAIN_ID (5000) — a permanent miss
    expect(body.chainId).toBe(FLARE);
    expect(body.history).toHaveLength(1);
  });

  it("GET /history uses each asset's own chain id", async () => {
    const getScoreHistory = vi.fn().mockReturnValue([]);
    const base = await startRouter(getScoreHistory);

    await fetch(`${base}/api/sentinel/history`);

    expect(getScoreHistory).toHaveBeenCalled();
    for (const call of getScoreHistory.mock.calls) expect(call[1]).toBe(FLARE);
  });

  it("an explicit ?chainId= wins, so one address on several chains is resolvable", async () => {
    const getScoreHistory = vi.fn().mockReturnValue([]);
    const base = await startRouter(getScoreHistory);

    await fetch(`${base}/api/sentinel/history/${OFT.toLowerCase()}?chainId=5000`);

    expect(getScoreHistory.mock.calls[0][1]).toBe(5000);
  });

  it("a junk ?chainId= is a 400, not a null chain with an empty history", async () => {
    // `Number("abc")` is NaN, which serialised as `chainId: null` alongside an
    // empty history — the exact shape a caller reads as "this asset has no data
    // yet". Bad input has to look like bad input.
    const getScoreHistory = vi.fn().mockReturnValue([]);
    const base = await startRouter(getScoreHistory);

    for (const q of ["abc", "", "1e999", "14.5", "-14", "0"]) {
      const res = await fetch(`${base}/api/sentinel/history/${OFT.toLowerCase()}?chainId=${q}`);
      expect(res.status, `?chainId=${q} should be rejected`).toBe(400);
    }

    expect(getScoreHistory).not.toHaveBeenCalled();
  });

  it("an unwatched address returns an empty history and a null chain, not a guess", async () => {
    const getScoreHistory = vi.fn().mockReturnValue([]);
    const base = await startRouter(getScoreHistory);

    const res = await fetch(`${base}/api/sentinel/history/0x0000000000000000000000000000000000000001`);
    const body = await res.json();

    expect(body.chainId).toBeNull();
    expect(body.history).toEqual([]);
    expect(getScoreHistory).not.toHaveBeenCalled(); // never read under a guessed chain
  });
});

// ── C. The chain key that reaches resolveDvn ─────────────────────────────────
//
// A static scan proves a string is absent. Only a behavioural test proves the
// RIGHT chain key arrives where it matters, and until now nothing imported
// report.ts at all — so the regression it once carried was caught by nothing.
//
// Why this specific call is worth a test of its own: a DVN's identity is the
// (chainKey, address) PAIR. lz-config.ts records that 0x28b6140e… is a DEAD
// placeholder on flare and "LayerZero Labs" on mantle. Resolving a Flare OFT's
// DVNs under "mantle" would therefore print a trusted operator's name for an
// address recorded as dead — a report that is confidently wrong.

describe("report.ts resolves DVNs against the OFT's own chain", () => {
  const FLARE_OFT = "0x560C03079FE54Fa53e15b48C615b1ef76D6DF621";
  const DVN = "0x28b6140ead1b0dc0b0f0d0a0d0e0f0a0b0c0d0e0";

  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  async function generateFor(chainId: number, resolveDvn: ReturnType<typeof vi.fn>) {
    // No LLM key → writeReport returns null and generateReport short-circuits,
    // but the facts (and therefore resolveDvn) are built first. No network.
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    vi.doMock("../services/lz-config.js", () => ({
      resolveDvn,
      loadDvnMeta: vi.fn().mockResolvedValue({ byChain: {}, fetchedAt: 1 }),
    }));
    vi.doMock("../services/drift.js", () => ({
      assessSnapshot: vi.fn().mockResolvedValue({ findings: [], score: 75, riskLevel: "AT_RISK", tis: [] }),
    }));
    vi.doMock("../services/snapshot-store.js", () => ({
      getSnapshot: () => ({
        oft: FLARE_OFT, chainId, capturedAt: 42, owner: null, ownerIsContract: null,
        proxyAdmin: null, proxyAdminOwner: null, proxyAdminIsMultisig: null,
        proxyAdminOwnerIsContract: null,
        routes: [{
          eid: 30110, chainName: "arbitrum", chainKey: "arbitrum",
          sendLibrary: "0x1", sendLibIsDefault: true,
          receiveLibrary: "0x2", receiveLibIsDefault: true,
          uln: { confirmations: 20, requiredDVNCount: 1, requiredDVNs: [DVN],
                 optionalDVNCount: 0, optionalDVNThreshold: 0, optionalDVNs: [] },
          receiveUln: null, peer: "0x0", peerAddress: null,
          hasEnforcedOptions: null, isActive: true,
        }],
      }),
      latestVerdict: () => null,
    }));
    const { generateReport } = await import("../services/report.js");
    await generateReport({ ticker: "MOFT", address: FLARE_OFT, chainId });
  }

  it("passes the Flare chain key, not a hardcoded 'mantle'", async () => {
    const resolveDvn = vi.fn().mockReturnValue("some-dvn");
    await generateFor(14, resolveDvn); // 14 = Flare in the committed registry

    expect(resolveDvn).toHaveBeenCalled();
    const chainKeys = resolveDvn.mock.calls.map((c) => c[1]);
    expect(chainKeys).toContain("flare");
    expect(chainKeys).not.toContain("mantle"); // the round-1 defect, verbatim
  });

  it("passes the Mantle chain key for a Mantle OFT — the fix is per-asset, not a swap", async () => {
    const resolveDvn = vi.fn().mockReturnValue("some-dvn");
    await generateFor(5000, resolveDvn);

    expect(resolveDvn.mock.calls.map((c) => c[1])).toContain("mantle");
  });

  it("passes null for a chain the registry does not know, rather than borrowing a name", async () => {
    const resolveDvn = vi.fn().mockReturnValue("0x28b6…");
    await generateFor(999999, resolveDvn);

    const chainKeys = resolveDvn.mock.calls.map((c) => c[1]);
    expect(chainKeys).toContain(null);
    expect(chainKeys).not.toContain("mantle");
  });
});

// ── D. The chain the copilot is told it is looking at ────────────────────────
//
// Same argument as C, for the prompt instead of the report: a static scan proves
// the literal is gone, only a behavioural test proves the RIGHT chain arrives.
// The copilot repeats what its system prompt asserts, so a prompt naming the
// wrong chain produces answers that are fluent, confident and false about which
// network the assets live on.

describe("the copilot prompt names the fleet's own chain", () => {
  const OFT = "0x560C03079FE54Fa53e15b48C615b1ef76D6DF621";

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** Ask one question against a fleet on `chainId` and return the system prompt
   *  the model would have received. No network: fetch is stubbed, and the fleet
   *  has no snapshots so nothing is scored. */
  async function systemPromptFor(chainId: number): Promise<string> {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.doMock("../services/sentinel.js", () => ({
      getWatched: vi.fn().mockResolvedValue([{ ticker: "MOFT", address: OFT, chainId }]),
    }));
    vi.doMock("../services/snapshot-store.js", () => ({ getSnapshot: () => null }));
    vi.doMock("../services/drift.js", () => ({ assessSnapshot: vi.fn() }));

    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }));

    const { askCopilot } = await import("../services/ask.js");
    await askCopilot(`which chain is this fleet on? ${chainId}`);

    const sent = JSON.parse(bodies[0]) as { messages: { role: string; content: string }[] };
    return sent.messages.find((m) => m.role === "system")!.content;
  }

  it("names Flare for a Flare fleet, not a hardcoded chain", async () => {
    const prompt = await systemPromptFor(14);

    expect(prompt).toContain("Flare (chain 14)");
    expect(prompt).not.toContain("Mantle"); // the literal that shipped in the prompt
    expect(prompt).not.toContain("5000");
  });

  it("names Mantle for a Mantle fleet — derived, not swapped", async () => {
    const prompt = await systemPromptFor(5000);

    expect(prompt).toContain("Mantle (chain 5000)");
    expect(prompt).not.toContain("Flare");
  });

  it("says Unknown for a chain the registry does not know, rather than borrowing a name", async () => {
    const prompt = await systemPromptFor(999999);

    expect(prompt).toContain("Unknown (chain 999999)");
    expect(prompt).not.toContain("Mantle");
    expect(prompt).not.toContain("Flare");
  });
});
