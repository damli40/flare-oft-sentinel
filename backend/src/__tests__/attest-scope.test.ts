import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attestInScope } from "../services/attestor.js";

// Below rules 5.0.0 a mainnet instance may attest ONLY the assets the operator
// listed by hand — never the whole discovered fleet. The gate is env-driven and
// INERT when unset, so the production Mantle instance keeps attesting everything
// it watches.
//
// The list it reads is ATTEST_PINNED, NOT WATCH_PINNED. That separation is the
// point of this file. It was one list until 2026-08-05, when widening the watch
// list to cover the Flare OFT fleet silently made three live third-party tokens
// attestable; the poll would have signed verdicts about FLR and DINERO into a
// permanent registry. Reading a contract and signing a claim about it are
// different acts. Any test here that starts sourcing the allowlist from
// WATCH_PINNED has reintroduced that bug.
//
// Chain resolution runs against the real committed chain-registry.json (flare
// = 14, mantle = 5000), so no registry mock is needed here — unlike getWatched,
// which also needs dune/alerts doubles.

// The unset case is the one that guards production behavior, so it must not
// depend on what happens to be exported in the ambient shell.
beforeEach(() => {
  for (const name of ["ATTEST_SCOPE", "ATTEST_PINNED", "WATCH_PINNED", "WATCH_CHAINS"])
    vi.stubEnv(name, undefined);
});

afterEach(() => vi.unstubAllEnvs());

const DEMO = "0x00502397F31ee5989a24329ed3dFED55828e6786";
const USDT0 = "0x567287d2a9829215a37e3b88843d32f9221e7588";

describe("attestInScope", () => {
  it("allows everything when ATTEST_SCOPE is unset (prod behavior)", () => {
    expect(attestInScope("0x1111111111111111111111111111111111111111", 14)).toBe(true);
  });

  it("treats an empty ATTEST_SCOPE as unset, not as a restriction", () => {
    vi.stubEnv("ATTEST_SCOPE", "");
    expect(attestInScope("0x1111111111111111111111111111111111111111", 14)).toBe(true);
  });

  it("with ATTEST_SCOPE=allowlist, allows only ATTEST_PINNED chainId:address pairs", () => {
    vi.stubEnv("ATTEST_SCOPE", "allowlist");
    vi.stubEnv("ATTEST_PINNED", `flare:${DEMO}:MOFT`);
    expect(attestInScope(DEMO, 14)).toBe(true);
    expect(attestInScope(DEMO.toLowerCase(), 14)).toBe(true); // case-insensitive
    expect(attestInScope(USDT0, 14)).toBe(false); // watched, but not on the allowlist
    expect(attestInScope(DEMO, 5000)).toBe(false); // right address, wrong chain
  });

  // ── Fail closed. One test per input named in the requirement. ──────────────
  // An allowlist that falls back to "everything" when it cannot be read is worse
  // than no allowlist, because it reads as a guarantee.

  it("with ATTEST_SCOPE=allowlist and ATTEST_PINNED UNSET, attests nothing", () => {
    vi.stubEnv("ATTEST_SCOPE", "allowlist");
    expect(attestInScope(DEMO, 14)).toBe(false);
    expect(attestInScope(USDT0, 14)).toBe(false);
  });

  it("with ATTEST_SCOPE=allowlist and ATTEST_PINNED EMPTY, attests nothing", () => {
    vi.stubEnv("ATTEST_SCOPE", "allowlist");
    vi.stubEnv("ATTEST_PINNED", "");
    expect(attestInScope(DEMO, 14)).toBe(false);
    vi.stubEnv("ATTEST_PINNED", "   ,  , ");
    expect(attestInScope(DEMO, 14)).toBe(false);
  });

  it("with ATTEST_SCOPE=allowlist and ATTEST_PINNED entirely UNPARSEABLE, attests nothing", () => {
    vi.stubEnv("ATTEST_SCOPE", "allowlist");
    vi.stubEnv("ATTEST_PINNED", "garbage,flare:not-an-address:X,::,flare");
    expect(attestInScope(DEMO, 14)).toBe(false);
    expect(attestInScope(USDT0, 14)).toBe(false);
  });

  it("NEVER falls back to WATCH_PINNED — the watch list does not authorise signing", () => {
    // The exact 2026-08-05 configuration: four assets watched, one attestable.
    vi.stubEnv("ATTEST_SCOPE", "allowlist");
    vi.stubEnv("WATCH_CHAINS", "flare");
    vi.stubEnv("WATCH_PINNED", `flare:${USDT0}:USDT0,flare:${DEMO}:MOFT`);
    vi.stubEnv("ATTEST_PINNED", `flare:${DEMO}:MOFT`);
    expect(attestInScope(DEMO, 14)).toBe(true);
    expect(attestInScope(USDT0, 14)).toBe(false); // pinned for WATCHING only
  });

  it("with ATTEST_PINNED set but ATTEST_SCOPE unset, still attests everything (allowlist is opt-in)", () => {
    vi.stubEnv("ATTEST_PINNED", `flare:${DEMO}:MOFT`);
    expect(attestInScope(USDT0, 14)).toBe(true);
  });

  // ── Unrecognised mode fails closed ────────────────────────────────────────
  // `pinned` was this gate's previous mode and is gone. A stale env file still
  // carrying it must attest NOTHING; degrading it to "unrecognised means unset"
  // would turn a restriction into "attest everything", which is the worst
  // possible reading of an operator who was clearly trying to restrict.

  it("with the REMOVED ATTEST_SCOPE=pinned, attests nothing (no silent fall-through to everything)", () => {
    vi.stubEnv("ATTEST_SCOPE", "pinned");
    vi.stubEnv("WATCH_PINNED", `flare:${DEMO}:MOFT`);
    vi.stubEnv("ATTEST_PINNED", `flare:${DEMO}:MOFT`);
    expect(attestInScope(DEMO, 14)).toBe(false);
    expect(attestInScope(USDT0, 14)).toBe(false);
  });

  it("with any unrecognised ATTEST_SCOPE, attests nothing", () => {
    vi.stubEnv("ATTEST_SCOPE", "everything");
    vi.stubEnv("ATTEST_PINNED", `flare:${DEMO}:MOFT`);
    expect(attestInScope(DEMO, 14)).toBe(false);
  });

  // ── Requirement 3: attestable only if also watched ────────────────────────

  it("drops an ATTEST_PINNED entry on a chain outside WATCH_CHAINS", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ATTEST_SCOPE", "allowlist");
    vi.stubEnv("WATCH_CHAINS", "flare");
    vi.stubEnv("ATTEST_PINNED", `mantle:${DEMO}:MOFT,flare:${DEMO}:MOFT`);
    expect(attestInScope(DEMO, 5000)).toBe(false); // mantle entry is not watched here
    expect(attestInScope(DEMO, 14)).toBe(true); // flare entry survives
    expect(err).toHaveBeenCalled();
    expect(err.mock.calls.flat().join(" ")).toContain("outside");
    err.mockRestore();
  });

  it("keeps every ATTEST_PINNED entry when WATCH_CHAINS is unset (no chain restriction)", () => {
    vi.stubEnv("ATTEST_SCOPE", "allowlist");
    vi.stubEnv("ATTEST_PINNED", `mantle:${DEMO}:MOFT`);
    expect(attestInScope(DEMO, 5000)).toBe(true);
  });
});
