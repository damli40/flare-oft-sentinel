import { describe, it, expect, beforeEach } from "vitest";
import { readSnapshot, _resetCorridorCache } from "../services/lz-config.js";
import {
  OFT, SEL, AGG3_SEL, fullHandler, makeFactory, multicallHandler,
  chainRef, rpc, deps, installHermeticChainRegistry, type Handler,
  MANY_EIDS, manyEidMap, peerForEid, perEidPeers, errorStringRevert,
  revertWith, word, buildUln, makeInFlight,
} from "./helpers/fake-rpc.js";
import { FALLBACK_CONCURRENCY } from "../services/multicall.js";

installHermeticChainRegistry();
beforeEach(() => _resetCorridorCache());

describe("resilientBatch", () => {
  it("uses aggregate3 when the chain supports it", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    await readSnapshot(OFT, chainRef([rpc("u1", "p1")], { multicall3: true }), deps({
      makeClient: makeFactory({ u1: { handler: multicallHandler(handler) } }, log),
    }));
    expect(log.some((l) => l.includes(AGG3_SEL))).toBe(true);
  });

  it("never uses aggregate3 when the chain does not support it", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    await readSnapshot(OFT, chainRef([rpc("u1", "p1")], { multicall3: false }), deps({
      makeClient: makeFactory({ u1: { handler } }, log),
    }));
    expect(log.some((l) => l.includes(AGG3_SEL))).toBe(false);
  });

  it("falls back to individual calls when the batch throws wholesale", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    // Answers individual selectors, but refuses aggregate3 entirely.
    const noBatch: Handler = (to, data) => {
      if (data.slice(0, 10) === AGG3_SEL) throw new Error("execution reverted");
      return handler(to, data);
    };
    const snap = await readSnapshot(OFT, chainRef([rpc("u1", "p1")], { multicall3: true }), deps({
      makeClient: makeFactory({ u1: { handler: noBatch } }, log),
    }));
    expect(snap.routes.length).toBeGreaterThan(0);
    expect(snap.routes[0].sendLibrary).not.toBeNull();
    expect(log.some((l) => l.includes(SEL.getSendLibrary))).toBe(true);
  });

  it("SAFETY: a rate-limited batch must not null out config it could not read", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    // Primary 429s on the batch. A second client is present and answers it, but
    // note this test does NOT pin WHICH recovery path runs: with the fallback
    // clients removed entirely it still passes, because the per-call path
    // degrades to a correct read too. What it pins is the outcome — a 429 never
    // presents as "no config" — not the route taken to it.
    const rateLimited: Handler = (to, data) => {
      if (data.slice(0, 10) === AGG3_SEL) throw new Error("429 Too Many Requests");
      return handler(to, data);
    };
    const snap = await readSnapshot(
      OFT,
      chainRef([rpc("u1", "p1"), rpc("u2", "p2")], { multicall3: true }),
      deps({
        makeClient: makeFactory(
          { u1: { handler: rateLimited }, u2: { handler: multicallHandler(handler) } },
          log,
        ),
      }),
    );
    // The read succeeded via the fallback — a 429 must never present as "no config".
    expect(snap.routes[0].uln).not.toBeNull();
    expect(snap.routes[0].sendLibrary).not.toBeNull();
  });

  it("BATCH FALLBACK: a failing primary batch is retried as a BATCH on the next client", async () => {
    // Pins the `...fallbackClients` half of resilientBatch's client loop, which
    // the outcome-only SAFETY test above cannot: with the fallbacks dropped from
    // that loop the read still comes back correct, just one eth_call per
    // sub-call — silently forfeiting the entire saving on any chain whose
    // primary RPC is flaky, which is exactly when the call budget matters most.
    const log: string[] = [];
    const { handler } = fullHandler();
    const rateLimited: Handler = (to, data) => {
      if (data.slice(0, 10) === AGG3_SEL) throw new Error("429 Too Many Requests");
      return handler(to, data);
    };
    const snap = await readSnapshot(
      OFT,
      chainRef([rpc("u1", "p1"), rpc("u2", "p2")], { multicall3: true }),
      deps({
        makeClient: makeFactory(
          { u1: { handler: rateLimited }, u2: { handler: multicallHandler(handler) } },
          log,
        ),
      }),
    );
    expect(snap.routes[0].sendLibrary).not.toBeNull();
    // The recovery was a batch on u2 …
    expect(log).toContain(`u2|${AGG3_SEL}`);
    // … not a degrade to one call per selector. getSendLibrary is only ever
    // batched now, so a bare one here means the per-call path ran.
    expect(log.filter((l) => l.endsWith(`|${SEL.getSendLibrary}`))).toEqual([]);
  });

  it("BATCH FALLBACK: when EVERY client refuses the batch, it degrades to per-call", async () => {
    // The other half of the loop. Refusing the batch must never mean refusing
    // the read — an unreadable config reads downstream as "nothing to report".
    const log: string[] = [];
    const { handler } = fullHandler();
    const noBatch: Handler = (to, data) => {
      if (data.slice(0, 10) === AGG3_SEL) throw new Error("429 Too Many Requests");
      return handler(to, data);
    };
    const snap = await readSnapshot(
      OFT,
      chainRef([rpc("u1", "p1"), rpc("u2", "p2")], { multicall3: true }),
      deps({
        makeClient: makeFactory(
          { u1: { handler: noBatch }, u2: { handler: noBatch } },
          log,
        ),
      }),
    );
    // Both clients were asked for a batch before giving up on batching.
    expect(log).toContain(`u1|${AGG3_SEL}`);
    expect(log).toContain(`u2|${AGG3_SEL}`);
    // And the config still came back, in full, via individual calls.
    expect(snap.routes[0].sendLibrary).not.toBeNull();
    expect(snap.routes[0].uln).not.toBeNull();
    expect(snap.routes[0].hasEnforcedOptions).toBe(false);
    expect(log.filter((l) => l.endsWith(`|${SEL.getSendLibrary}`)).length).toBeGreaterThan(0);
  });

  it("BOUNDED: the degraded per-call path never fans out past FALLBACK_CONCURRENCY", async () => {
    // The Global Constraint: "fallback paths must be bounded, never a bare
    // unbounded Promise.all". Removing unbounded RPC fan-out is what this
    // branch is FOR, and the constraint binds exactly when the chain is
    // degraded — a batch has just failed, so the RPC is already unhappy, and
    // answering by firing all 120 corridor reads at once is the worst possible
    // response to a rate limit.
    //
    // Replacing `mapLimit(calls, FALLBACK_CONCURRENCY, …)` with `Promise.all`
    // makes the SAME calls in the SAME order, so a call log cannot see it. Only
    // simultaneity can, so the fake client counts calls in flight.
    const inFlight = makeInFlight();
    const { handler } = fullHandler();
    // Multicall3 advertised, aggregate3 refused → resilientBatch exhausts its
    // client list and degrades to the bounded per-call path.
    const noBatch: Handler = (to, data) => {
      if (data.slice(0, 10) === AGG3_SEL) throw new Error("429 Too Many Requests");
      return perEidPeers(handler)(to, data);
    };
    const snap = await readSnapshot(
      OFT,
      chainRef([rpc("u1", "p1")], { multicall3: true }),
      deps({
        makeClient: makeFactory({ u1: { handler: noBatch } }, [], inFlight),
        loadEidMap: manyEidMap,
      }),
    );

    // Scoped per selector: readSnapshot has other, deliberately-unbounded
    // per-route fan-out (the sendability probe), and a global counter would
    // measure that instead. The corridor sweep is peers(); the send-side waves
    // are their own selectors. Each is a distinct resilientBatch call list.
    const sweep = (u: string, s: string) => u === "u1" && s === SEL.peers;
    const sendSide = (u: string, s: string) =>
      u === "u1" && [SEL.getSendLibrary, SEL.isDefaultSendLibrary, SEL.enforcedOptions].includes(s);

    // The degrade happened and had a real fan-out to bound: 120 corridors.
    expect(inFlight.total(sweep)).toBeGreaterThanOrEqual(MANY_EIDS.length);
    expect(inFlight.total(sendSide)).toBeGreaterThan(100);
    // The fixture can SEE concurrency — otherwise a peak of 1 would pass under
    // any policy at all, Promise.all included, and the bound would be vacuous.
    expect(inFlight.peak(sweep)).toBeGreaterThan(1);
    expect(inFlight.peak(sweep)).toBeLessThanOrEqual(FALLBACK_CONCURRENCY);
    expect(inFlight.peak(sendSide)).toBeLessThanOrEqual(FALLBACK_CONCURRENCY);

    // Bounded, but not at the cost of the read.
    expect(snap.routes.length).toBe(MANY_EIDS.length);
    expect(snap.routes[0].sendLibrary).not.toBeNull();
  });

  it("maps a genuinely reverting sub-call to null without harming its neighbours", async () => {
    const log: string[] = [];
    const { handler } = fullHandler();
    // enforcedOptions reverts WITH data, and the payload is deliberately
    // WELL-FORMED for its decoder: an abi-encoded `bytes` of length 2. Read as
    // return data, decodeBytesNonEmpty answers `true` off it — "this route HAS
    // enforced options", invented out of a revert. Only the aggregate3 success
    // flag says the call failed.
    //
    // The payload shape is the whole point of this test. An Error(string) revert
    // (what `require(false, msg)` emits) would make decodeBytesNonEmpty THROW,
    // the decode guard would swallow it, and the field would land null by
    // accident — green regardless of whether the success flag is read at all.
    // With a decodable payload the null is only reachable via the success flag.
    const bytesShapedRevert = revertWith(
      "0x" + word("20") + word("2") + "beef".padEnd(64, "0"),
    );
    const partial: Handler = (to, data) =>
      data.slice(0, 10) === SEL.enforcedOptions
        ? bytesShapedRevert
        : handler(to, data);
    const snap = await readSnapshot(OFT, chainRef([rpc("u1", "p1")], { multicall3: true }), deps({
      makeClient: makeFactory({ u1: { handler: multicallHandler(partial) } }, log),
    }));
    // null, NOT false. `false` is the positive claim "no enforced options are
    // set", and nothing we read supports it — the read failed. `false` here
    // would silently clear the missing-enforced-options finding on every route
    // whose enforcedOptions call the RPC could not serve.
    expect(snap.routes[0].hasEnforcedOptions).toBeNull();
    expect(snap.routes[0].hasEnforcedOptions).not.toBe(false);
    // Its batch neighbours — the other three wave-1 reads for this route, and
    // the wave-2 ULN that depends on one of them — are untouched.
    expect(snap.routes[0].sendLibrary).not.toBeNull();
    expect(snap.routes[0].sendLibIsDefault).toBe(false);
    expect(snap.routes[0].receiveLibrary).not.toBeNull();
    expect(snap.routes[0].uln).not.toBeNull();
  });

  it("BLAST RADIUS: an undecodable peers() word costs that corridor, not the snapshot", async () => {
    // multicall3: false — the per-call path, which serves the 16 eligible chains
    // with no Multicall3 and hands the RPC's bytes to the decoder verbatim.
    // BigInt("0xZZZZ") throws SyntaxError; unguarded, that rejects readSnapshot
    // for the whole token, so one bad RPC blinds the monitor on every corridor
    // instead of one.
    const bad = [MANY_EIDS[0], MANY_EIDS[7], MANY_EIDS[60]];
    const { handler } = fullHandler();
    const snap = await readSnapshot(
      OFT,
      chainRef([rpc("u1", "p1")], { multicall3: false }),
      deps({
        makeClient: makeFactory(
          { u1: { handler: perEidPeers(handler, { malformedFor: bad }) } },
          [],
        ),
        loadEidMap: manyEidMap,
      }),
    );

    const eids = snap.routes.map((r) => r.eid);
    expect(eids).toEqual(MANY_EIDS.filter((e) => !bad.includes(e)));
    for (const r of snap.routes) expect(r.peerAddress).toBe(peerForEid(r.eid));
  });

  it.each([true, false])(
    "ZERO PEER: an all-zero peers() word mints no corridor (multicall3=%s)",
    async (multicall3) => {
      // The common case on a real sweep: most of the ~120 known EIDs have no
      // peer and answer bytes32(0). Without the non-zero guard every one of them
      // becomes a phantom corridor with peer 0x0000…0000 — ~100 per token.
      const zero = MANY_EIDS.filter((_, i) => i % 3 !== 0);
      const live = MANY_EIDS.filter((_, i) => i % 3 === 0);
      const { handler } = fullHandler();
      const inner = perEidPeers(handler, { zeroFor: zero });
      const snap = await readSnapshot(
        OFT,
        chainRef([rpc("u1", "p1")], { multicall3 }),
        deps({
          makeClient: makeFactory(
            { u1: { handler: multicall3 ? multicallHandler(inner) : inner } },
            [],
          ),
          loadEidMap: manyEidMap,
        }),
      );

      expect(snap.routes.map((r) => r.eid)).toEqual(live);
      for (const r of snap.routes) {
        expect(r.peerAddress).toBe(peerForEid(r.eid));
        // The phantom shape, named explicitly so a regression is unmistakable.
        expect(r.peerAddress).not.toBe("0x0000000000000000000000000000000000000000");
      }
    },
  );

  it("SUB-CALL REVERT DATA: a reverting peers() is not decoded as a peer", async () => {
    // Multicall3 reports `require(false, msg)` as success=false WITH a non-empty
    // Error(string) payload. Read as return data, its last 20 bytes decode to a
    // perfectly well-formed address and mint a corridor that does not exist.
    // Only the success flag distinguishes it — the bytes themselves look fine.
    const reverting = [MANY_EIDS[2], MANY_EIDS[55]];
    const { handler } = fullHandler();
    const inner: Handler = (to, data) => {
      if (data.slice(0, 10) === SEL.peers) {
        const eid = parseInt(data.slice(10), 16);
        if (reverting.includes(eid)) return errorStringRevert("peer lookup failed");
      }
      return perEidPeers(handler)(to, data);
    };
    const snap = await readSnapshot(
      OFT,
      chainRef([rpc("u1", "p1")], { multicall3: true }),
      deps({
        makeClient: makeFactory({ u1: { handler: multicallHandler(inner) } }, []),
        loadEidMap: manyEidMap,
      }),
    );

    expect(snap.routes.map((r) => r.eid)).toEqual(
      MANY_EIDS.filter((e) => !reverting.includes(e)),
    );
    for (const r of snap.routes) expect(r.peerAddress).toBe(peerForEid(r.eid));
  });
});
