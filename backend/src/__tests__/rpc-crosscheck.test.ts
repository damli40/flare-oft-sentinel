import { describe, it, expect, beforeEach } from "vitest";
import { readSnapshot, _resetCorridorCache } from "../services/lz-config.js";
import {
  OFT, ulnZero, ulnDiff, fullHandler, multicallHandler, AGG3_SEL, SEL, ETH_EID, ENDPOINT,
  makeFactory, chainRef, deps, installHermeticChainRegistry, type Handler,
} from "./helpers/fake-rpc.js";

installHermeticChainRegistry();
beforeEach(() => _resetCorridorCache());

describe("rpcConflict cross-check — batched, on the SECOND provider", () => {
  it("still detects a genuine conflict when batched", async () => {
    const log: string[] = [];
    const factory = makeFactory(
      {
        p0: { handler: multicallHandler(fullHandler(ulnZero).handler) },
        p1: { handler: multicallHandler(fullHandler(ulnDiff).handler) },
      },
      log,
    );
    const chain = chainRef(
      [{ url: "p0", provider: "official" }, { url: "p1", provider: "drpc" }],
      { multicall3: true },
    );

    const snap = await readSnapshot(OFT, chain, deps({ makeClient: factory }));
    expect(snap.routes[0].rpcConflict).toBe(true);
  });

  it("issues the cross-check against the SECONDARY url, never the primary", async () => {
    const log: string[] = [];
    const factory = makeFactory(
      {
        p0: { handler: multicallHandler(fullHandler(ulnZero).handler) },
        p1: { handler: multicallHandler(fullHandler(ulnZero).handler) },
      },
      log,
    );
    const chain = chainRef(
      [{ url: "p0", provider: "official" }, { url: "p1", provider: "drpc" }],
      { multicall3: true },
    );

    await readSnapshot(OFT, chain, deps({ makeClient: factory }));

    // The whole value of the check is that a DIFFERENT provider answers it.
    // If it batches onto the primary the check still "passes" and never detects
    // a conflict again — silent, permanent loss of detection.
    //
    // Asserts the AGGREGATE3 batch specifically, not just any "p1|" traffic:
    // this fixture's fullHandler doesn't model quoteSend, so the unrelated
    // sendability probe (probeSendability) also exhausts to p1 on every route
    // regardless of where the cross-check lands — a bare `startsWith("p1|")`
    // would pass even if the cross-check itself never left the primary.
    expect(log).toContain(`p1|${AGG3_SEL}`);
  });

  it("does NOT flag a conflict when the secondary fails to answer", async () => {
    const log: string[] = [];
    // p1 answers nothing at all — every sub-call comes back empty → null rows.
    const deadSecondary: Handler = () => "0x";
    const factory = makeFactory(
      {
        p0: { handler: multicallHandler(fullHandler(ulnZero).handler) },
        p1: { handler: multicallHandler(deadSecondary) },
      },
      log,
    );
    const chain = chainRef(
      [{ url: "p0", provider: "official" }, { url: "p1", provider: "drpc" }],
      { multicall3: true },
    );

    const snap = await readSnapshot(OFT, chain, deps({ makeClient: factory }));

    // THE safety invariant. null == "we never managed to ask", NOT "the chain
    // disagreed". A cross-check we could not run must leave rpcConflict unset;
    // flagging here would manufacture a CRITICAL out of a transport failure.
    expect(snap.routes[0].rpcConflict).toBeFalsy();
    expect(snap.routes[0].uln).toEqual(expect.objectContaining({ requiredDVNCount: 0 }));
  });

  it("skips the check entirely when no different-provider fallback exists", async () => {
    const log: string[] = [];
    const factory = makeFactory(
      {
        p0: { handler: multicallHandler(fullHandler(ulnZero).handler) },
        p1: { handler: multicallHandler(fullHandler(ulnDiff).handler) },
      },
      log,
    );
    // BOTH endpoints are the same provider → no independent corroboration is
    // possible, so the check must be skipped rather than faked.
    const chain = chainRef(
      [{ url: "p0", provider: "official" }, { url: "p1", provider: "official" }],
      { multicall3: true },
    );

    const snap = await readSnapshot(OFT, chain, deps({ makeClient: factory }));
    expect(snap.routes[0].rpcConflict).toBeFalsy();
  });

  it("does not corrupt an unrelated route when a corridor lacks a send library (index alignment)", async () => {
    // The filter removes routes without a decoded sendLibrary/uln BEFORE the
    // cross-check batch is built. Two corridors here: EID_A (ETH_EID) resolves
    // fully (a real conflict to detect); EID_B's getSendLibrary comes back
    // empty, so wave 2 never even asks for its ULN and it never qualifies.
    // Dropping the filter would try to build EID_B's cross-check calldata from
    // a null sendLibrary (padAddr(null!)) and throw or misalign — the exact
    // index-misalignment class that survived 309 and 320 passing tests on the
    // previous branch. A single-corridor fixture can never exercise this: the
    // filter and no-filter cases are identical unless there is an entry the
    // filter actually removes.
    //
    // EID_B is deliberately SMALLER than ETH_EID: corridor discovery sweeps
    // Object.keys(eidMap), and integer-valued object keys always enumerate in
    // ascending numeric order regardless of insertion order, so EID_B lands
    // BEFORE EID_A in routeList. That is what makes an eid→routeList-position
    // mutation (vs. eid→xcheckRoutes-position) observable: with EID_B filtered
    // out of xcheckRoutes but still occupying routeList[0], indexing the
    // secondary's answer by routeList position instead of xcheckRoutes
    // position would read EID_A's result off the wrong slot (or fall off the
    // end into undefined) instead of its own.
    const EID_B = 100;
    const twoEidMap = async () => ({
      [ETH_EID]: { chainKey: "ethereum", endpoint: ENDPOINT },
      [EID_B]: { chainKey: `chain-${EID_B}`, endpoint: ENDPOINT },
    });

    const good = fullHandler(ulnZero);
    const primaryHandler: Handler = (to, data) => {
      if (data.slice(0, 10) === SEL.getSendLibrary) {
        const eid = parseInt(data.slice(74, 138), 16);
        if (eid === EID_B) return "0x"; // route B never resolves a send library
      }
      return good.handler(to, data);
    };

    const log: string[] = [];
    const factory = makeFactory(
      {
        p0: { handler: multicallHandler(primaryHandler) },
        p1: { handler: multicallHandler(fullHandler(ulnDiff).handler) },
      },
      log,
    );
    const chain = chainRef(
      [{ url: "p0", provider: "official" }, { url: "p1", provider: "drpc" }],
      { multicall3: true },
    );

    const snap = await readSnapshot(
      OFT, chain,
      deps({ makeClient: factory, loadEidMap: twoEidMap }),
    );

    const routeA = snap.routes.find((r) => r.eid === ETH_EID);
    const routeB = snap.routes.find((r) => r.eid === EID_B);
    // Route A still gets a real, correctly-batched cross-check.
    expect(routeA?.rpcConflict).toBe(true);
    // Route B was correctly excluded — never crossed with garbage calldata,
    // never flagged off an eid it was never asked about.
    expect(routeB?.sendLibrary).toBeNull();
    expect(routeB?.uln).toBeNull();
    expect(routeB?.rpcConflict).toBeFalsy();
  });

  it("maps xcheckResults back to the right eid when TWO corridors both qualify (MUST-FIX 1)", async () => {
    // The test above proves the filter excludes an unqualified corridor
    // correctly, but it can never catch an eid↔result index swap: EID_B is
    // filtered out of xcheckRoutes there, so xcheckRoutes has length 1 and
    // `xcheckResults[xcheckRoutes.length - 1 - i]` is the identity on a
    // single-element array. Only a fixture where BOTH corridors survive the
    // `.filter((r) => r.sendLibrary && r.uln)` gives xcheckRoutes length 2,
    // where a swapped index is actually observable.
    //
    // EID_B is deliberately SMALLER than ETH_EID — see the previous test's
    // comment on ascending numeric key enumeration — which fixes routeList
    // (and therefore xcheckRoutes) order as [EID_B, ETH_EID]. That makes
    // `xcheckResults[xcheckRoutes.length - 1 - i]` a genuine 2-element swap:
    // EID_B (i=0) reads ETH_EID's secondary answer and vice versa.
    const EID_B = 100;
    const twoEidMap = async () => ({
      [ETH_EID]: { chainKey: "ethereum", endpoint: ENDPOINT },
      [EID_B]: { chainKey: `chain-${EID_B}`, endpoint: ENDPOINT },
    });

    // Primary agrees with itself everywhere: every corridor reads ulnZero, so
    // BOTH corridors fully resolve a send library and a ULN and qualify for
    // the cross-check.
    const primaryHandler = fullHandler(ulnZero).handler;

    // Secondary AGREES with the primary on ETH_EID (also ulnZero) and DIFFERS
    // on EID_B (ulnDiff). getConfig is the only selector the cross-check batch
    // asks the secondary, so it's the only one that needs to vary by eid.
    const secondaryHandler: Handler = (to, data) => {
      if (data.slice(0, 10) === SEL.getConfig) {
        const eid = parseInt(data.slice(138, 202), 16);
        return eid === EID_B
          ? fullHandler(ulnDiff).handler(to, data)
          : fullHandler(ulnZero).handler(to, data);
      }
      return fullHandler(ulnZero).handler(to, data);
    };

    const log: string[] = [];
    const factory = makeFactory(
      {
        p0: { handler: multicallHandler(primaryHandler) },
        p1: { handler: multicallHandler(secondaryHandler) },
      },
      log,
    );
    const chain = chainRef(
      [{ url: "p0", provider: "official" }, { url: "p1", provider: "drpc" }],
      { multicall3: true },
    );

    const snap = await readSnapshot(
      OFT, chain,
      deps({ makeClient: factory, loadEidMap: twoEidMap }),
    );

    const routeA = snap.routes.find((r) => r.eid === ETH_EID); // secondary AGREED
    const routeB = snap.routes.find((r) => r.eid === EID_B);   // secondary DIFFERED

    // Both directions matter — a swapped mapping manufactures a false CRITICAL
    // on the route that actually agreed (A) AND suppresses the real one on the
    // route that actually disagreed (B). Asserting only one side would still
    // pass against a mutant that happens to get the other side right.
    expect(routeA?.rpcConflict).toBeFalsy();
    expect(routeB?.rpcConflict).toBe(true);
  });
});
