import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readSnapshot, _resetCorridorCache } from "../services/lz-config.js";
import {
  OFT, AGG3_SEL, fullHandler, failHandler, makeFactory, multicallHandler,
  chainRef, deps, installHermeticChainRegistry, type Handler,
} from "./helpers/fake-rpc.js";

installHermeticChainRegistry();
beforeEach(() => _resetCorridorCache());

/** Collect every sleep the reader requests, without actually waiting. */
function sleepSpy() {
  const ms: number[] = [];
  return { ms, sleep: async (n: number) => { ms.push(n); } };
}

describe("resilientCall pacing", () => {
  it("requests ZERO sleeps when every read succeeds", async () => {
    const log: string[] = [];
    const spy = sleepSpy();
    const factory = makeFactory({ p0: fullHandler() }, log);
    const chain = chainRef([{ url: "p0", provider: "official" }]);

    await readSnapshot(OFT, chain, deps({
      makeClient: factory, sleep: spy.sleep, jitter: () => 0.5,
    }));

    // A healthy fleet must not pay the pacing cost. If this ever fails, the
    // delay leaked onto the success path and every cycle just got slower.
    expect(spy.ms).toEqual([]);
  });

  it("paces the primary retry and each fallback hop after a failure", async () => {
    const log: string[] = [];
    const spy = sleepSpy();
    // p0 fails everything → primary attempt, paced retry, then paced hop to p1.
    const factory = makeFactory(
      { p0: { handler: failHandler }, p1: fullHandler() },
      log,
    );
    const chain = chainRef([
      { url: "p0", provider: "official" },
      { url: "p1", provider: "drpc" },
    ]);

    await readSnapshot(OFT, chain, deps({
      makeClient: factory, sleep: spy.sleep, jitter: () => 0.5,
    }));

    // jitter 0.5 → multiplier (0.5 + 0.5) = 1.0 → exact base values, so the
    // assertion pins WHICH delay was used at WHICH hop, not merely "some delay".
    expect(spy.ms.length).toBeGreaterThan(0);
    expect(new Set(spy.ms)).toEqual(new Set([150, 100]));
    // The retry delay must be requested before the first fallback delay.
    expect(spy.ms.indexOf(150)).toBeLessThan(spy.ms.indexOf(100));
  });

  it("scales the delay by the jitter seam", async () => {
    const log: string[] = [];
    const spy = sleepSpy();
    const factory = makeFactory(
      { p0: { handler: failHandler }, p1: fullHandler() },
      log,
    );
    const chain = chainRef([
      { url: "p0", provider: "official" },
      { url: "p1", provider: "drpc" },
    ]);

    // jitter 0 → multiplier 0.5 → half the base. Pins that jitter is actually
    // applied; a hardcoded `sleep(150)` passes the test above but fails here.
    await readSnapshot(OFT, chain, deps({
      makeClient: factory, sleep: spy.sleep, jitter: () => 0,
    }));

    expect(new Set(spy.ms)).toEqual(new Set([75, 50]));
  });
});

// resilientBatch's OWN copy of the pacing (the multicall3 client-walk loop),
// which every `chainRef([...])` fixture above skips: chainRef defaults
// multicall3 to false, so `if (chain.multicall3)` never executes and none of
// the tests above exercise this code path at all. Confirmed by mutation: M2
// above (deleting resilientCall's fallback backoff) kills only itself —
// resilientBatch's copy of the same line has no test that would notice it
// disappearing, or being paced onto the happy path instead.
describe("resilientBatch pacing", () => {
  it("requests ZERO sleeps when the batched primary succeeds", async () => {
    const log: string[] = [];
    const spy = sleepSpy();
    const { handler } = fullHandler();
    const factory = makeFactory({ u1: { handler: multicallHandler(handler) } }, log);
    const chain = chainRef([{ url: "u1", provider: "official" }], { multicall3: true });

    await readSnapshot(OFT, chain, deps({
      makeClient: factory, sleep: spy.sleep, jitter: () => 0.5,
    }));

    // Confirms the batched path actually ran (else this would pass vacuously).
    expect(log.some((l) => l.includes(AGG3_SEL))).toBe(true);
    // The batched happy path — which serves the majority of production reads —
    // must not pay the pacing cost either. If this fails, `if (!firstClient)`
    // got inverted (or equivalent) and every batch now sleeps before its own
    // first, successful attempt.
    expect(spy.ms).toEqual([]);
  });

  it("paces the fallback hop when the primary refuses the batch", async () => {
    const log: string[] = [];
    const spy = sleepSpy();
    const { handler } = fullHandler();
    // u1 answers everything EXCEPT aggregate3 — a transport-level batch
    // failure (429), not a per-selector one — forcing resilientBatch's
    // client-walk loop to hop to u2.
    const noBatch: Handler = (to, data) => {
      if (data.slice(0, 10) === AGG3_SEL) throw new Error("429 Too Many Requests");
      return handler(to, data);
    };
    const factory = makeFactory(
      { u1: { handler: noBatch }, u2: { handler: multicallHandler(handler) } },
      log,
    );
    const chain = chainRef(
      [{ url: "u1", provider: "official" }, { url: "u2", provider: "drpc" }],
      { multicall3: true },
    );

    await readSnapshot(OFT, chain, deps({
      makeClient: factory, sleep: spy.sleep, jitter: () => 0.5,
    }));

    // The recovery was a BATCH on u2, not a degrade to per-call.
    expect(log).toContain(`u2|${AGG3_SEL}`);
    // Every hop off a refused batch requests the 100ms fallback delay — jitter
    // 0.5 pins the exact value, same idiom as the resilientCall tests above.
    expect(spy.ms.length).toBeGreaterThan(0);
    expect(new Set(spy.ms)).toEqual(new Set([100]));
  });
});

// Neither zero-sleep test above exercises the cross-check's own batch client:
// both use a single-RPC chainRef, so secondaryClient is null and the
// rpcConflict cross-check (batchOnClient against the SECOND provider, see
// lz-config.ts) never fires. That leaves the real production shape —
// healthy fleet, two-provider chain, cross-check actually running — unpaced
// in behavior but UNASSERTED, so pacing could leak onto this happy path
// unseen. This closes that gap.
describe("cross-check batch pacing", () => {
  it("requests ZERO sleeps on a healthy two-provider chain where the cross-check runs", async () => {
    const log: string[] = [];
    const spy = sleepSpy();
    const { handler } = fullHandler();
    const factory = makeFactory(
      {
        p0: { handler: multicallHandler(handler) },
        p1: { handler: multicallHandler(handler) },
      },
      log,
    );
    const chain = chainRef(
      [{ url: "p0", provider: "official" }, { url: "p1", provider: "drpc" }],
      { multicall3: true },
    );

    await readSnapshot(OFT, chain, deps({
      makeClient: factory, sleep: spy.sleep, jitter: () => 0.5,
    }));

    // Confirms the cross-check batch actually ran against the secondary —
    // else this would pass vacuously, the same way a single-RPC fixture would.
    expect(log).toContain(`p1|${AGG3_SEL}`);
    // Nothing here failed, so nothing should have paced — the cross-check's
    // happy path must be as free as resilientBatch's.
    expect(spy.ms).toEqual([]);
  });
});

// House pattern from multicall.test.ts's "env configuration" describe block:
// default, override, fail-loudly-at-import per bad value, blank-string
// fallback, cap. `vi.resetModules()` + a dynamic import gets a fresh module
// with the constants re-parsed from the freshly stubbed env; the statically
// imported `readSnapshot`/`_resetCorridorCache` used elsewhere in this file
// are bound to the ORIGINAL module instance and are untouched by this.
describe("RPC pacing env configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const load = () => import("../services/lz-config.js");

  it("uses the documented defaults when unset", async () => {
    vi.stubEnv("RPC_RETRY_DELAY_MS", undefined);
    vi.stubEnv("RPC_FALLBACK_DELAY_MS", undefined);
    vi.resetModules();
    const m = await load();
    expect(m.RPC_RETRY_DELAY_MS).toBe(150);
    expect(m.RPC_FALLBACK_DELAY_MS).toBe(100);
  });

  it("accepts a valid override", async () => {
    vi.stubEnv("RPC_RETRY_DELAY_MS", "300");
    vi.stubEnv("RPC_FALLBACK_DELAY_MS", "200");
    vi.resetModules();
    const m = await load();
    expect(m.RPC_RETRY_DELAY_MS).toBe(300);
    expect(m.RPC_FALLBACK_DELAY_MS).toBe(200);
  });

  /**
   * 0 is a legitimate value — pacing off — unlike multicall.ts's
   * parsePositiveInt knobs, which reject it. This is the exact acceptance
   * `n < 0` (rather than `n < 1`) exists to preserve: mutating that guard to
   * `n < 1` rejects 0 at import and this test catches it.
   */
  it("accepts 0 — pacing off is a legitimate operator choice", async () => {
    vi.stubEnv("RPC_RETRY_DELAY_MS", "0");
    vi.stubEnv("RPC_FALLBACK_DELAY_MS", "0");
    vi.resetModules();
    const m = await load();
    expect(m.RPC_RETRY_DELAY_MS).toBe(0);
    expect(m.RPC_FALLBACK_DELAY_MS).toBe(0);
  });

  it.each(["abc", "-1", "2.5", "NaN"])(
    "fails loudly at import on RPC_RETRY_DELAY_MS=\"%s\"",
    async (bad) => {
      vi.stubEnv("RPC_RETRY_DELAY_MS", bad);
      vi.resetModules();
      await expect(load()).rejects.toThrow(/RPC_RETRY_DELAY_MS must be a non-negative integer/);
    },
  );

  it.each(["abc", "-1", "2.5", "NaN"])(
    "fails loudly at import on RPC_FALLBACK_DELAY_MS=\"%s\"",
    async (bad) => {
      vi.stubEnv("RPC_FALLBACK_DELAY_MS", bad);
      vi.resetModules();
      await expect(load()).rejects.toThrow(/RPC_FALLBACK_DELAY_MS must be a non-negative integer/);
    },
  );

  /**
   * A blank value is an empty field, not a typo — same reasoning as
   * multicall.ts's parsePositiveInt. This is a production monitor; booting on
   * the documented default beats refusing to boot on a cleared env var.
   */
  it.each(["", "   ", "\t"])(
    "falls back to the default on a blank RPC_RETRY_DELAY_MS=\"%s\"",
    async (blank) => {
      vi.stubEnv("RPC_RETRY_DELAY_MS", blank);
      vi.resetModules();
      const m = await load();
      expect(m.RPC_RETRY_DELAY_MS).toBe(150);
    },
  );

  it.each(["", "   ", "\t"])(
    "falls back to the default on a blank RPC_FALLBACK_DELAY_MS=\"%s\"",
    async (blank) => {
      vi.stubEnv("RPC_FALLBACK_DELAY_MS", blank);
      vi.resetModules();
      const m = await load();
      expect(m.RPC_FALLBACK_DELAY_MS).toBe(100);
    },
  );

  /**
   * The upper bound. 150000 (a plausible seconds/ms typo) is not obviously
   * wrong the way "-1" is — it parses, it's a positive integer — but at that
   * magnitude a single failed read stalls 75-225s (jitter is 0.5x-1.5x of
   * base), which threatens the hourly sweep's window. See RPC_DELAY_MAX_MS's
   * comment in lz-config.ts for the full reasoning.
   */
  it("accepts the boundary value exactly", async () => {
    vi.stubEnv("RPC_RETRY_DELAY_MS", "10000");
    vi.resetModules();
    const m = await load();
    expect(m.RPC_RETRY_DELAY_MS).toBe(10_000);
    expect(m.RPC_RETRY_DELAY_MS).toBe(m.RPC_DELAY_MAX_MS);
  });

  it.each(["10001", "150000", "1000000"])(
    "fails loudly at import on an over-cap RPC_RETRY_DELAY_MS=\"%s\"",
    async (tooBig) => {
      vi.stubEnv("RPC_RETRY_DELAY_MS", tooBig);
      vi.resetModules();
      await expect(load()).rejects.toThrow(/RPC_RETRY_DELAY_MS must be <= 10000/);
    },
  );

  it("REJECTS rather than clamps an over-cap RPC_FALLBACK_DELAY_MS — a silently-substituted value is a config nobody chose", async () => {
    vi.stubEnv("RPC_FALLBACK_DELAY_MS", "150000");
    vi.resetModules();
    await expect(load()).rejects.toThrow(/RPC_FALLBACK_DELAY_MS must be <= 10000/);
  });

  /**
   * The behavioral half of "0 is legitimate": not just that it PARSES, but
   * that `backoff(0)` skips sleep entirely rather than calling sleep(0).
   * `base > 0 ? sleep(...) : Promise.resolve()` regressing to always calling
   * sleep would still read as "no real delay" on a spy that only checks
   * values (`[0, 0]` looks harmless) — only a call-count assertion catches it.
   * A real failure+fallback is forced here so the zero is a genuine "delay
   * disabled", not a vacuous "nothing happened to pace".
   */
  it("backoff(0) requests ZERO sleeps, not sleep(0)", async () => {
    vi.stubEnv("RPC_RETRY_DELAY_MS", "0");
    vi.stubEnv("RPC_FALLBACK_DELAY_MS", "0");
    vi.resetModules();
    const m = await load();

    const log: string[] = [];
    const spy = sleepSpy();
    const factory = makeFactory(
      { p0: { handler: failHandler }, p1: fullHandler() },
      log,
    );
    const chain = chainRef([
      { url: "p0", provider: "official" },
      { url: "p1", provider: "drpc" },
    ]);

    await m.readSnapshot(OFT, chain, deps({
      makeClient: factory, sleep: spy.sleep, jitter: () => 0.5,
    }));

    // p0 failed and the read still recovered via p1 — a real retry+fallback
    // happened — yet sleep was never called, because both delays are 0.
    expect(log.some((l) => l.startsWith("p1|"))).toBe(true);
    expect(spy.ms).toEqual([]);
  });
});
