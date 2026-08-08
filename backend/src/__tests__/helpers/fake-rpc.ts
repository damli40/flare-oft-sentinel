/**
 * Shared fake-RPC harness for readSnapshot tests.
 *
 * Lifted out of read-snapshot.test.ts so the batching tests can drive the SAME
 * fixture data through both the batched and unbatched paths. That shared fixture
 * is what makes equivalence assertions meaningful: if the two paths had their own
 * canned returns, "batched agrees with unbatched" would only prove the two
 * fixtures agree.
 */
import { beforeAll, beforeEach, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { decodeFunctionData, encodeAbiParameters, getAddress, type Address } from "viem";
import type { RpcClient, ReadSnapshotDeps } from "../../services/lz-config.js";
import { _resetChainRegistryCache } from "../../services/chain-registry.js";
import type { ChainRef } from "../../types.js";

// ── Fixtures / ABI-shaped canned returns ─────────────────────────────────────
export const ENDPOINT = "0x1a44076050125825900e736c501f859c50fE728c" as Address;
export const OFT = "0x" + "12".repeat(20);
export const OWNER = "0x" + "a1".repeat(20);
export const SENDLIB = "0x" + "5e".repeat(20);
export const RECVLIB = "0x" + "5c".repeat(20);
export const PEER = "0x" + "ab".repeat(20);
export const ETH_EID = 30101;
export const MANTLE_EID = 30181;

/** 4-byte selectors (must mirror SEL in lz-config.ts). */
export const SEL = {
  getSendLibrary: "0xb96a277f",
  isDefaultSendLibrary: "0xdc93c8a2",
  getReceiveLibrary: "0x402f8468",
  getConfig: "0x2b3197b9",
  peers: "0xbb0b6a53",
  owner: "0x8da5cb5b",
  getThreshold: "0xe75235b8",
  enforcedOptions: "0x5535d461",
  decimals: "0x313ce567",
};

/**
 * Delivery-accounting selectors. These come from NONCE_ABI in lz-config.ts,
 * which encodes them through viem rather than from a SEL table — kept separate
 * so the SEL block above stays a literal mirror of that table.
 *   outboundNonce(address,uint32,bytes32) / inboundNonce(address,uint32,bytes32)
 */
export const NONCE_SEL = {
  outboundNonce: "0x9c6d7340",
  inboundNonce: "0xa0dd43fc",
};

export const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const boolWord = (b: boolean) => (b ? "1" : "0").padStart(64, "0");
export const peersRet = (addr: string) => "0x" + word(addr);
export const addrWord = (addr: string) => "0x" + word(addr);
const addrBoolRet = (addr: string, b: boolean) => "0x" + word(addr) + boolWord(b);
const enforcedEmpty = "0x" + "0".repeat(128);

/** A peers() word of all zeroes — the on-chain shape of "no peer for this eid".
 *  The COMMON case on a real sweep: ~100 of the ~120 known EIDs answer this. */
export const ZERO_PEER = "0x" + "0".repeat(64);

// ── Reverts that carry return data ───────────────────────────────────────────
/**
 * A handler return can be marked as a REVERT rather than a successful read.
 *
 * The distinction matters because a reverting sub-call is not the same as one
 * returning nothing: real chains revert with a payload (`Error(string)` from a
 * `require`, or a custom error), and Multicall3 reports that as
 * `{success: false, returnData: <non-empty bytes>}`. A harness that can only
 * emit `{success: false, returnData: "0x"}` cannot tell whether a decoder reads
 * the `success` flag or merely checks for empty bytes — so the revert payload
 * being mistaken for valid return data (and its last 20 bytes minted into an
 * address) is invisible to it.
 *
 * `revertWith` is honoured on BOTH paths, so a fixture stays truthful whichever
 * one the chain takes: multicallHandler maps it to a failed aggregate3 row, and
 * makeFactory throws it, which is what viem does for a direct eth_call revert.
 */
const REVERT_MARK = "revert!";

/** Mark a handler's return as a revert carrying `returnData` (may be "0x"). */
export const revertWith = (returnData: string) => REVERT_MARK + returnData;

/** The revert payload, or null if `r` is an ordinary successful return. */
export function asRevert(r: string): string | null {
  return r.startsWith(REVERT_MARK) ? r.slice(REVERT_MARK.length) : null;
}

/** Standard `Error(string)` revert payload — what `require(false, msg)` returns.
 *  Non-empty bytes on a FAILED call, which is the discriminating case. */
export function errorStringRevert(msg: string): string {
  return revertWith(
    "0x08c379a0" + encodeAbiParameters([{ type: "string" }], [msg]).slice(2),
  );
}

/** UlnConfig-shaped bytes decodable by decodeUlnConfig; requiredDVNCount is the
 *  only field we vary (word index 4 = byte offset 128). */
export function buildUln(requiredDVNCount: number): string {
  const words = new Array(20).fill("0".repeat(64));
  words[4] = word(requiredDVNCount.toString(16));
  return "0x" + words.join("");
}
export const ulnZero = buildUln(0);
export const ulnDiff = buildUln(1);

export const ZERO_ULN = {
  confirmations: 0,
  requiredDVNCount: 0,
  requiredDVNs: [],
  optionalDVNCount: 0,
  optionalDVNThreshold: 0,
  optionalDVNs: [],
};

export type Handler = (to: Address, data: string) => string;

/**
 * What a send-side call must ask before this fixture will answer it. Overridable
 * for a test that drives readSnapshot with a different OFT, endpoint or source
 * chain; the defaults match `OFT` / `ENDPOINT` / `chainRef()`.
 */
export interface SendSideExpect {
  /** The OFT the OApp-level selectors are aimed at and the endpoint-level ones ask about. */
  oft?: string;
  /** The endpoint the endpoint-level selectors are aimed at. */
  endpoint?: string;
  /** The SOURCE chain's own eid. No corridor carries it — see isRouteEid. */
  srcEid?: number;
  /** The library getSendLibrary hands back, and therefore the only one a wave-2
   *  getConfig may name. */
  sendLib?: string;
}

/**
 * A handler that answers every send-side selector with valid data (given a
 * getConfig uln).
 *
 * ⚠️ STRICT, in the same sense as read-snapshot.test.ts's `dstHandler`, and for
 * the same reason. Index-alignment coverage pins WHICH route a result lands on;
 * it says nothing about WHAT QUESTION the calldata asked. A fixture that
 * dispatches on the selector alone — `case SEL.getConfig: return uln;` — answers
 * anything, so every calldata mutation that keeps the selector intact survives
 * it, and three of those mutations produce a WRONG POSITIVE rather than a
 * fail-safe null:
 *
 *  - getConfig with config type 1 (EXECUTOR) instead of 2 (ULN). decodeUlnConfig
 *    does not reject an executor config — its 192-char floor is cleared — so it
 *    returns a NON-NULL UlnSnapshot of garbage, and the monitor asserts a DVN set
 *    it never read.
 *  - getConfig with the oapp and library arguments swapped. The endpoint would
 *    answer that with the DEFAULT config for the library-as-oapp, i.e. a
 *    plausible-looking config on every route regardless of what the OFT set.
 *  - enforcedOptions with msgType 2 instead of 1 (lzReceive). Every route reads
 *    back "no enforced options" — a silent false negative on the exact finding
 *    the call exists to raise.
 *
 * And a peers() sweep aimed at the ENDPOINT instead of the OFT discovers zero
 * corridors fleet-wide, which reads downstream as "all clear".
 *
 * So: every modelled selector returns `"0x"` unless the TARGET, the eid
 * argument, the config type, the msgType and the library argument are all
 * exactly what the production read path should be sending.
 */
export function fullHandler(
  uln = ulnZero,
  ownerCode = "0xabcd",
  expect: SendSideExpect = {},
): { handler: Handler; ownerCode: string } {
  const oft = (expect.oft ?? OFT).toLowerCase();
  const endpoint = (expect.endpoint ?? ENDPOINT).toLowerCase();
  const srcEid = expect.srcEid ?? MANTLE_EID;
  const sendLib = (expect.sendLib ?? SENDLIB).toLowerCase();

  const handler: Handler = (to, data) => {
    const at = (addr: string) => to.toLowerCase() === addr;
    /** The 20-byte address argument whose word starts at `start` (post-padding). */
    const argAddr = (start: number) => "0x" + data.slice(start, start + 40).toLowerCase();
    const argU = (start: number) => parseInt(data.slice(start, start + 64), 16);
    /**
     * A corridor eid — anything except the source chain's OWN eid, which no
     * send-side read may ever carry. `chain.eid` is the single most available
     * wrong value at every one of these call sites (it is in scope, it is a
     * uint32, and it makes a plausible-looking call), and substituting it turns
     * a per-route read into one that asks the chain about itself.
     */
    const isRouteEid = (eid: number) => Number.isInteger(eid) && eid > 0 && eid !== srcEid;

    switch (data.slice(0, 10)) {
      // peers(uint32 _eid) — on the OFT itself.
      case SEL.peers:
        if (!at(oft)) return "0x";
        if (!isRouteEid(argU(10))) return "0x";
        return peersRet(PEER);

      // getSendLibrary(address _sender, uint32 _dstEid) — on the ENDPOINT.
      case SEL.getSendLibrary:
        if (!at(endpoint)) return "0x";
        if (argAddr(34) !== oft) return "0x";
        if (!isRouteEid(argU(74))) return "0x";
        return addrWord(SENDLIB);

      // isDefaultSendLibrary(address _sender, uint32 _dstEid) — on the ENDPOINT.
      //
      // 0x-prefixed, like every real RPC return. Without the prefix the plain
      // path still read it as `false` (BigInt of a zero-word), while the batched
      // path handed the unprefixed string to viem's bytes encoder and got a
      // NON-zero payload back — so the same fixture produced `false` unbatched
      // and `true` batched. A harness that answers in a shape no chain emits
      // cannot testify about equivalence.
      case SEL.isDefaultSendLibrary:
        if (!at(endpoint)) return "0x";
        if (argAddr(34) !== oft) return "0x";
        if (!isRouteEid(argU(74))) return "0x";
        return "0x" + boolWord(false);

      // getReceiveLibrary(address _receiver, uint32 _srcEid) — on the ENDPOINT.
      case SEL.getReceiveLibrary:
        if (!at(endpoint)) return "0x";
        if (argAddr(34) !== oft) return "0x";
        if (!isRouteEid(argU(74))) return "0x";
        return addrBoolRet(RECVLIB, false);

      // getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType)
      // — on the ENDPOINT. Config type 2 is the ULN config; 1 is the EXECUTOR
      // config, which decodeUlnConfig happily returns non-null garbage for.
      case SEL.getConfig:
        if (!at(endpoint)) return "0x";
        if (argAddr(34) !== oft) return "0x";
        if (argAddr(98) !== sendLib) return "0x";
        if (!isRouteEid(argU(138))) return "0x";
        if (argU(202) !== 2) return "0x";
        return uln;

      // enforcedOptions(uint32 _eid, uint16 _msgType) — on the OFT. msgType 1 is
      // lzReceive; asking any other one reads back "none set" on every route.
      case SEL.enforcedOptions:
        if (!at(oft)) return "0x";
        if (!isRouteEid(argU(10))) return "0x";
        if (argU(74) !== 1) return "0x";
        return enforcedEmpty;

      // decimals() — on the OFT. Read once per OFT for the quoteSend probe
      // amount (see lz-config.ts's `probeAmount`). Unmodelled until 2026-07-20:
      // resilientCall's paced retry made that "0x" default (a silent, free
      // no-op before pacing existed) cost a real 150ms sleep on what should be
      // an all-succeeding fixture — exactly the kind of previously-invisible
      // cost this task exists to surface.
      //
      // 6, not 18: lz-config.ts's catch-block default IS 18, so answering 18
      // here made the success and failure branches indistinguishable — every
      // fullHandler test incidentally exercised "keep the default" and none
      // exercised "read the real value". 6 (USDC's decimals) is a real,
      // common on-chain value that makes the two branches actually diverge.
      case SEL.decimals:
        if (!at(oft)) return "0x";
        return "0x" + word("6");

      // Nullary, and called on more than one target (the OFT, and a ProxyAdmin's
      // owner) — nothing to pin beyond the selector.
      case SEL.owner: return addrWord(OWNER);
      case SEL.getThreshold: return "0x";
      default: return "0x";
    }
  };
  return { handler, ownerCode };
}

/** Every read fails → forces the fallback chain. */
export const failHandler: Handler = () => "0x";

export interface FakeSpec { handler: Handler; ownerCode?: string }

/**
 * Peak-concurrency observer for the BOUNDED fallback paths.
 *
 * "Fallback paths must be bounded, never a bare unbounded `Promise.all`" is a
 * stated constraint of this branch — removing unbounded RPC fan-out is the
 * whole point — and it applies precisely when a chain is degraded, i.e. when
 * restraint matters most. Nothing observes it unless a fixture counts calls
 * that are in flight AT THE SAME TIME, so `mapLimit(…, FALLBACK_CONCURRENCY, …)`
 * swapped for `Promise.all` reads identically from a call LOG.
 *
 * Counts are kept per `${url}|${selector}` so a phase's peak can be read
 * without the genuinely-unbounded per-route fan-out elsewhere in readSnapshot
 * polluting it.
 */
export interface InFlight {
  /** Highest simultaneous in-flight count for calls matching the predicate. */
  peak(match: (url: string, sel: string) => boolean): number;
  /** Total calls seen matching the predicate — guards against a vacuous peak. */
  total(match: (url: string, sel: string) => boolean): number;
}

interface InFlightRec { url: string; sel: string; peak: number; total: number }

export function makeInFlight(): InFlight & { _rec: Map<string, InFlightRec>; _enter(url: string, sel: string): void; _exit(url: string, sel: string): void } {
  const rec = new Map<string, InFlightRec>();
  const live = new Map<string, number>();
  const get = (url: string, sel: string) => {
    const k = `${url}|${sel}`;
    let r = rec.get(k);
    if (!r) { r = { url, sel, peak: 0, total: 0 }; rec.set(k, r); }
    return r;
  };
  const fold = (match: (url: string, sel: string) => boolean, pick: (r: InFlightRec) => number) =>
    [...rec.values()].filter((r) => match(r.url, r.sel)).reduce((a, r) => a + pick(r), 0);
  return {
    _rec: rec,
    _enter(url, sel) {
      const k = `${url}|${sel}`;
      const n = (live.get(k) ?? 0) + 1;
      live.set(k, n);
      const r = get(url, sel);
      r.total += 1;
      if (n > r.peak) r.peak = n;
    },
    _exit(url, sel) {
      const k = `${url}|${sel}`;
      live.set(k, (live.get(k) ?? 1) - 1);
    },
    // Peak is per key, so the aggregate over a selector set is the MAX of the
    // per-key peaks — summing them would over-count phases that never overlap.
    peak(match) {
      return [...rec.values()].filter((r) => match(r.url, r.sel)).reduce((a, r) => Math.max(a, r.peak), 0);
    },
    total(match) { return fold(match, (r) => r.total); },
  };
}

/** Build an injectable makeClient over a url→spec map, logging every call.
 *  `inFlight` (optional) additionally observes simultaneity, which a log cannot. */
export function makeFactory(specs: Record<string, FakeSpec>, log: string[], inFlight?: ReturnType<typeof makeInFlight>) {
  return (url: string): RpcClient => ({
    async call({ to, data }) {
      log.push(`${url}|${data.slice(0, 10)}`);
      const spec = specs[url];
      if (!spec) throw new Error("no fake for url " + url);
      const sel = data.slice(0, 10);
      if (!inFlight) {
        const out = spec.handler(to, data);
        // A revert is an error on the per-call path — viem throws, it does not
        // hand back the revert payload as if it were return data.
        if (asRevert(out) !== null) throw new Error("execution reverted");
        return { data: out };
      }
      inFlight._enter(url, sel);
      try {
        // Suspend before answering, so genuinely-concurrent callers overlap
        // here. Without a suspension point each call would run to completion
        // before the next began and the observed peak would be 1 under ANY
        // concurrency policy — the fixture would agree with a bare Promise.all.
        await new Promise((r) => setTimeout(r, 0));
        const out = spec.handler(to, data);
        if (asRevert(out) !== null) throw new Error("execution reverted");
        return { data: out };
      } finally {
        inFlight._exit(url, sel);
      }
    },
    async getBytecode() {
      return specs[url]?.ownerCode ?? "0x";
    },
    async getStorageAt() {
      return "0x"; // no proxy admin slot
    },
  });
}

/** Multicall3 aggregate3 selector. */
export const AGG3_SEL = "0x82ad56cb";

/** Wrap a plain selector-dispatch handler so it also answers Multicall3
 *  aggregate3, routing each sub-call back through the inner handler.
 *  Lets the SAME fixture data serve the batched and unbatched paths — which is
 *  what makes equivalence assertions meaningful. */
export function multicallHandler(inner: Handler): Handler {
  const abi = [
    {
      name: "aggregate3", type: "function", stateMutability: "payable",
      inputs: [{
        name: "calls", type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      }],
      outputs: [],
    },
  ] as const;

  return (to, data) => {
    if (data.slice(0, 10) !== AGG3_SEL) return inner(to, data);
    const { args } = decodeFunctionData({ abi, data: data as `0x${string}` });
    const calls = args![0] as readonly { target: Address; callData: string }[];
    const rows = calls.map((c) => {
      const r = inner(c.target, c.callData);
      // An explicit revert (see revertWith / errorStringRevert) keeps its
      // payload: success=false WITH non-empty returnData, which is what a real
      // chain returns for `require(false, msg)` and the only shape that can
      // tell a success-flag check apart from an empty-bytes check.
      const reverted = asRevert(r);
      if (reverted !== null) {
        return { success: false, returnData: reverted as `0x${string}` };
      }
      // Empty return == the sub-call produced nothing; model it as a revert,
      // which is how a real Multicall3 reports a failing sub-call.
      return r && r !== "0x"
        ? { success: true, returnData: r as `0x${string}` }
        : { success: false, returnData: "0x" as `0x${string}` };
    });
    return encodeAbiParameters(
      [{
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      }],
      [rows],
    );
  };
}

export const rpc = (url: string, provider: string) => ({ url, provider });

export function chainRef(rpcs: { url: string; provider: string }[], over: Partial<ChainRef> = {}): ChainRef {
  return {
    chainKey: "mantle",
    eid: MANTLE_EID,
    chainId: 5000,
    eligible: true,
    etherscanFree: false,
    multicall3: false,
    rpcs,
    ...over,
  };
}

export const eidMapDep = async () => ({ [ETH_EID]: { chainKey: "ethereum", endpoint: ENDPOINT } });

/**
 * A corridor set large enough to span several MULTICALL_CHUNK_SIZE (50) chunks.
 * The single-EID default map makes every batch size-1, which cannot detect a
 * chunking bug or a result/EID misalignment — the ordering guarantee is the
 * load-bearing part of resilientBatch's contract, so it needs a fixture that
 * can actually violate it.
 */
export const MANY_EIDS = Array.from({ length: 120 }, (_, i) => 40_000 + i);

export const manyEidMap = async () =>
  Object.fromEntries(
    MANY_EIDS.map((e) => [e, { chainKey: `chain-${e}`, endpoint: ENDPOINT }]),
  );

/** The peer address this EID must map to — distinct per EID, so a misaligned
 *  batch result lands a neighbour's peer and the assertion catches it. */
export const peerForEid = (eid: number) =>
  getAddress(("0x" + eid.toString(16).padStart(40, "0")) as Address);

/**
 * Wrap a handler so peers(eid) returns a peer unique to that EID.
 *
 * `zeroFor` makes those EIDs answer an all-zero word instead — the on-chain
 * "no peer here" reply, and the majority answer on a real full-EID sweep.
 * `malformedFor` makes them answer an undecodable word, which is what a
 * misbehaving RPC hands back; it must cost that corridor and nothing else.
 *
 * STRICT about the target, like fullHandler: peers() lives on the OApp, and a
 * sweep aimed at the ENDPOINT instead answers nothing on every eid at once —
 * zero corridors discovered, no findings, "all clear". A fixture keyed on the
 * eid argument alone cannot see that, because the eid argument is unchanged.
 */
export function perEidPeers(
  inner: Handler,
  opts: { zeroFor?: Iterable<number>; malformedFor?: Iterable<number>; oft?: string } = {},
): Handler {
  const zero = new Set(opts.zeroFor ?? []);
  const bad = new Set(opts.malformedFor ?? []);
  const oft = (opts.oft ?? OFT).toLowerCase();
  return (to, data) => {
    if (data.slice(0, 10) !== SEL.peers) return inner(to, data);
    if (to.toLowerCase() !== oft) return "0x";
    const eid = parseInt(data.slice(10), 16);
    if (bad.has(eid)) return MALFORMED_PEER;
    if (zero.has(eid)) return ZERO_PEER;
    return "0x" + word(eid.toString(16).padStart(40, "0"));
  };
}

/** Not hex — BigInt() throws SyntaxError on it. Some public RPCs really do
 *  return junk like this, and it reaches the decoder verbatim on the per-call
 *  path (no viem ABI decode in between). */
export const MALFORMED_PEER = "0xZZZZ";
export const dvnMetaDep = async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() });

/**
 * `sleep` defaults to a no-op. Without this, every test file that builds deps()
 * here but doesn't care about pacing falls through to readSnapshot's production
 * `setTimeout` + `Math.random` jitter default and pays real wall-clock time on
 * every simulated RPC failure — nondeterministic run to run, and on a fixture
 * with enough failures (e.g. read-snapshot.test.ts's 120-corridor sweep) enough
 * of it to threaten vitest's default timeout. `extra` spreads AFTER, so
 * rpc-pacing.test.ts's own sleep spy still wins.
 */
export function deps(extra: Partial<ReadSnapshotDeps>): ReadSnapshotDeps {
  return { loadEidMap: eidMapDep, loadDvnMeta: dvnMetaDep, sleep: async () => {}, ...extra };
}

/**
 * Point the destination-RPC registry lookup at an empty registry so the dest-side
 * receive read is deterministically skipped (receiveUln null) — keeps snapshot
 * fixtures hermetic and independent of the committed chain-registry.json.
 *
 * Call at the top level of a test file; it registers its own beforeAll/afterAll.
 *
 * The env var is re-asserted in beforeEach, not just beforeAll. process.env is
 * shared by every test file that lands in the same vitest worker, so a sibling
 * file's afterAll can delete CHAIN_REGISTRY_PATH out from under a file that is
 * still running. That drops readSnapshot onto the real committed registry and a
 * live RPC URL, and the test hangs until the 5s timeout instead of failing
 * honestly. Re-asserting per test makes the hermetic setup order-independent.
 */
let hermeticRegFile: string | null = null;

/**
 * Rewrite the hermetic registry's chain table and drop the module cache.
 *
 * Destination-side reads resolve their RPC (and Multicall3 capability) through
 * `getChainRefByKey`, so a test that wants a destination read to HAPPEN has to
 * put that chain in the registry. Requires installHermeticChainRegistry().
 */
export function setChainRegistryChains(chains: Record<string, ChainRef>): void {
  if (!hermeticRegFile) throw new Error("installHermeticChainRegistry() must run first");
  writeFileSync(
    hermeticRegFile,
    JSON.stringify({ generatedAt: "x", source: "test", chains }),
  );
  _resetChainRegistryCache();
}

export function installHermeticChainRegistry(): void {
  let regDir: string;
  const savedRegPath = process.env.CHAIN_REGISTRY_PATH;

  beforeAll(() => {
    regDir = mkdtempSync(join(tmpdir(), "lzreg-"));
    hermeticRegFile = join(regDir, "reg.json");
    // Point the env var at the hermetic file BEFORE writing it. The write path
    // (setChainRegistryChains) drops the module cache itself, so doing it in the
    // other order still ended up correct — but only by accident of that reset,
    // which reads as though the ordering were load-bearing in reverse.
    process.env.CHAIN_REGISTRY_PATH = hermeticRegFile;
    setChainRegistryChains({});
  });

  beforeEach(() => {
    // Reset to the empty registry every test, not just when the env var drifted:
    // a test that installs destination chains must not leak them into the next
    // one, where an unexpected destination read would change the snapshot.
    if (process.env.CHAIN_REGISTRY_PATH !== hermeticRegFile) {
      process.env.CHAIN_REGISTRY_PATH = hermeticRegFile!;
    }
    setChainRegistryChains({});
  });
  afterAll(() => {
    rmSync(regDir, { recursive: true, force: true });
    // Clear the handle along with the directory it named. Left set, it points at
    // a deleted path, and a stray setChainRegistryChains() after teardown fails
    // with an ENOENT from writeFileSync instead of the intended
    // "installHermeticChainRegistry() must run first" — an unrelated-looking
    // error for exactly the mistake that guard exists to name.
    hermeticRegFile = null;
    if (savedRegPath === undefined) delete process.env.CHAIN_REGISTRY_PATH;
    else process.env.CHAIN_REGISTRY_PATH = savedRegPath;
    _resetChainRegistryCache();
  });
}
