import { createPublicClient, http, getAddress, keccak256, toHex, encodeFunctionData, concatHex, pad, type Address } from "viem";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ChainRef, Sendability, OftSnapshot, RouteSnapshot, UlnSnapshot } from "../types.js";
import { getChainRefByKey, normalizeProvider } from "./chain-registry.js";
import { getBlockClaimVerification, stampDelivery } from "./block-claim-verifications.js";
import {
  aggregate3Batch,
  mapLimit,
  FALLBACK_CONCURRENCY,
  type Call,
} from "./multicall.js";

// LayerZero V2 endpoint — same address on every EVM chain.
export const ENDPOINT = "0x1a44076050125825900e736c501f859c50fE728c" as Address;

// 4-byte selectors, mirrored from fetch_oft_config.py (the audited source of truth).
export const SEL = {
  getSendLibrary:      "0xb96a277f", // (oapp,eid) → address
  isDefaultSendLibrary:"0xdc93c8a2", // (oapp,eid) → bool
  getReceiveLibrary:   "0x402f8468", // (oapp,eid) → (address lib, bool isDefault)
  getConfig:           "0x2b3197b9", // (oapp,lib,eid,configType) → bytes (UlnConfig)
  peers:               "0xbb0b6a53", // (eid) → bytes32
  owner:               "0x8da5cb5b", // () → address
  getThreshold:        "0xe75235b8", // GnosisSafe: () → uint256
  enforcedOptions:     "0x5535d461", // OAppOptionsType3 public mapping getter (uint32,uint16) → bytes — getEnforcedOptions 0x9ca12263 is not a real OFT function (reverts on every standard OFT)
  decimals:            "0x313ce567", // () → uint8
} as const;

// ── Sendability probe (quoteSend) ────────────────────────────────────────────
// Asks the endpoint to price a real message against the live send library, ULN config
// and peer. A fee comes back only if the corridor will ACCEPT A SEND.
//
// ⚠️ IT PROVES SENDABILITY, NOT DELIVERABILITY, and conflating the two is a trap this
// codebase has already fallen into once. quoteSend is evaluated entirely on the SOURCE
// chain and has no knowledge of the destination's receive config. So a corridor whose
// send confirmations fall below the destination's requirement, or whose destination
// demands a DVN the sender never pays, or whose destination required-DVN set is a dead
// placeholder, will quote happily — and then strand every token sent through it. Tokens
// leave the source and never arrive, which is strictly WORSE than a corridor that
// refuses the send outright: an unsendable route at least declines the money.
// Deliverability is decided by the receive-side rules in drift.ts and must stay a
// separate axis.
//
// outboundNonce does NOT work as a substitute and must not be resurrected: a bricked
// corridor (weETH→Zircuit) reads nonce 2 while a working one (weETH→Ethereum) reads 0.
const QUOTE_SEND_ABI = [{
  name: "quoteSend",
  type: "function",
  stateMutability: "view",
  inputs: [
    { name: "_sendParam", type: "tuple", components: [
      { name: "dstEid", type: "uint32" },
      { name: "to", type: "bytes32" },
      { name: "amountLD", type: "uint256" },
      { name: "minAmountLD", type: "uint256" },
      { name: "extraOptions", type: "bytes" },
      { name: "composeMsg", type: "bytes" },
      { name: "oftCmd", type: "bytes" },
    ] },
    { name: "_payInLzToken", type: "bool" },
  ],
  outputs: [{ name: "msgFee", type: "tuple", components: [
    { name: "nativeFee", type: "uint256" },
    { name: "lzTokenFee", type: "uint256" },
  ] }],
}] as const;

// Type-3 options carrying an explicit lzReceive gas floor. Passed on every probe so the
// quote does NOT depend on the OFT having called setEnforcedOptions() — without this,
// every OFT missing enforced options would quote-revert and read as a false UNSENDABLE,
// silently capping the severity of the very assets most likely to be misconfigured.
const LZ_RECEIVE_OPTION = concatHex([
  "0x0003",                            // options type 3
  "0x01",                              // worker id 1 = executor
  "0x0011",                            // option length: 17 bytes (1 type + 16 gas)
  "0x01",                              // option type 1 = lzReceive
  pad(toHex(200_000n), { size: 16 }),  // gas, uint128
]);

// ── Delivery accounting (outboundNonce / inboundNonce) ───────────────────────
// The measurement that stops the engine inferring consequences it never observed. Config
// says what SHOULD happen; these say what DID. `sent - delivered` is stranded value.
const NONCE_ABI = [
  { name: "outboundNonce", type: "function", stateMutability: "view",
    inputs: [{ name: "_sender", type: "address" }, { name: "_dstEid", type: "uint32" }, { name: "_receiver", type: "bytes32" }],
    outputs: [{ type: "uint64" }] },
  { name: "inboundNonce", type: "function", stateMutability: "view",
    inputs: [{ name: "_receiver", type: "address" }, { name: "_srcEid", type: "uint32" }, { name: "_sender", type: "bytes32" }],
    outputs: [{ type: "uint64" }] },
] as const;

/** A revert is the chain's verdict ("this corridor will not accept a send"); anything
 *  else is our own failure to ask. Only a clear revert may return UNSENDABLE — a transport
 *  error, rate limit or timeout must fall through to UNKNOWN, which never caps severity.
 *  When in doubt, say UNKNOWN: a misread here suppresses a CRITICAL, so the bias must be
 *  toward "we don't know" rather than "nothing can be sent". */
function isRevert(e: any): boolean {
  const s = `${e?.name ?? ""} ${e?.shortMessage ?? ""} ${e?.details ?? ""} ${e?.message ?? ""}`.toLowerCase();
  if (/timeout|timed out|fetch failed|socket|econn|network|rate limit|too many requests|429|50[0234]/.test(s)) {
    return false;
  }
  return /revert|invalid opcode|out of gas|contractfunction/.test(s);
}

// ── Sendability cache: sticky SENDABLE, never sticky UNSENDABLE ──────────────
// The probe costs one eth_call per corridor per cycle, which is real money against an
// RPC budget across the whole fleet.
//
// The asymmetry that makes caching safe: caching SENDABLE can only ever cause us to NOT
// cap a severity, which is the harmless direction — we never suppress a finding. Caching
// UNSENDABLE could hold a cap in place after a corridor opens, silently muting a CRITICAL
// on a route that now takes real value: the one failure this design exists to prevent.
//
// So SENDABLE is remembered for 24h; UNSENDABLE and UNKNOWN are re-probed every cycle.
// Most corridors are sendable, so nearly all the cost amortizes away, and the promise that
// "the cap lifts the day the corridor opens" is honoured on the very next poll.
const SENDABILITY_TTL = 24 * 60 * 60_000;
const sendabilityCache = new Map<string, number>(); // key → time SENDABLE was observed

export function _resetSendabilityCache(): void {
  sendabilityCache.clear();
}

/** Will this corridor accept a send right now? (NOT: will the message be delivered.) */
async function probeSendability(
  clients: RpcClient[],
  oft: Address,
  dstEid: number,
  peerAddress: string | null,
  amountLD: bigint,
  chainId: number,
): Promise<Sendability> {
  // No peer = nothing to send to. This is a config fact, not a probe failure.
  if (!peerAddress) return "UNSENDABLE";

  const cacheKey = `${chainId}:${oft.toLowerCase()}:${dstEid}`;
  const seenSendableAt = sendabilityCache.get(cacheKey);
  if (seenSendableAt && Date.now() - seenSendableAt < SENDABILITY_TTL) return "SENDABLE";

  let data: `0x${string}`;
  try {
    data = encodeFunctionData({
      abi: QUOTE_SEND_ABI,
      functionName: "quoteSend",
      args: [{
        dstEid,
        to: pad(getAddress(peerAddress), { size: 32 }),
        amountLD,
        minAmountLD: 0n,
        extraOptions: LZ_RECEIVE_OPTION,
        composeMsg: "0x",
        oftCmd: "0x",
      }, false],
    });
  } catch {
    return "UNKNOWN"; // bad peer address — we cannot even form the question
  }

  let sawRevert = false;
  for (const client of clients) {
    try {
      const res = await rawCall(client, oft, data);
      if (res && res !== "0x") {
        sendabilityCache.set(cacheKey, Date.now());
        return "SENDABLE";
      }
      // Empty return from a `view` that always returns data = this RPC misbehaving,
      // not a verdict. Try the next one.
    } catch (e) {
      if (isRevert(e)) { sawRevert = true; break; } // the chain answered — stop asking
      // transport failure: try the next RPC
    }
  }
  return sawRevert ? "UNSENDABLE" : "UNKNOWN"; // deliberately not cached — see above
}

// ── Deployments-sourced EID map ───────────────────────────────────────────────
// Loaded dynamically from the authoritative LZ deployments API.
// chainKey is used directly as the DVN-metadata lookup key (no intermediate chainId).
// RPC URLs for destination-side receive reads are curated; absent = skip mismatch check.
const DEPLOYMENTS_URL = "https://metadata.layerzero-api.com/v1/metadata/deployments";

// Source-chain fallback RPCs and destination-side receive RPCs are no longer
// hardcoded to Mantle: the reader takes a ChainRef and derives its primary +
// quorum RPCs from the registry (see readSnapshot). Destination-side receive
// reads resolve their RPC from the registry too (getChainRefByKey), so coverage
// is every eligible chain rather than the old 22 curated ones.

export interface ChainInfo { chainKey: string; endpoint: string }

let eidMapCache: { at: number; map: Record<number, ChainInfo> } | null = null;

/** Load the V2 EVM mainnet EID→chainKey map from the LZ deployments API.
 *  Cached 24 h. Only includes EIDs 30000–39999 with 0x endpoints (EVM, no sandboxes). */
export async function loadEidMap(): Promise<Record<number, ChainInfo>> {
  if (eidMapCache && Date.now() - eidMapCache.at < 24 * 3600_000) return eidMapCache.map;
  try {
    const res = await fetch(DEPLOYMENTS_URL);
    const raw = (await res.json()) as Record<string, { deployments?: any[] }>;
    const map: Record<number, ChainInfo> = {};
    for (const [, val] of Object.entries(raw)) {
      for (const dep of val.deployments ?? []) {
        if (dep.version !== 2) continue;
        const eid = Number(dep.eid);
        if (eid < 30000 || eid >= 40000) continue; // exclude sandboxes (50xxx) and legacy
        const ep: string = dep.endpointV2?.address ?? dep.endpoint?.address ?? "";
        if (!ep.startsWith("0x")) continue; // non-EVM (Solana, Aptos, TON, etc.)
        map[eid] = {
          chainKey: dep.chainKey as string,
          endpoint: ep,
        };
      }
    }
    eidMapCache = { at: Date.now(), map };
    return map;
  } catch {
    return eidMapCache?.map ?? {};
  }
}

// EIP-1967 TransparentUpgradeableProxy admin slot
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as `0x${string}`;

// ── DVN metadata (chainKey-keyed) ─────────────────────────────────────────────
const DVN_META_URL = "https://metadata.layerzero-api.com/v1/metadata/dvns";

// A DVN's identity is the (chainKey, address) PAIR — never the address alone.
// The same address is a different verifier on different chains:
//   0xdd7b5e1d… = "Nethermind" (live) on linea, "BWare" (DEPRECATED) on zkevm
//   0x3b0531…   = usdt0 on ethereum, nansen on optimism, nethermind on sonic
//   0xce8358…   = "LZDeadDVN" on neox/bevm, "LayerZero Labs" (LIVE) on mode/skale/hedera
// 311 of 1052 registry addresses appear on more than one chain; 276 of those carry a
// different name/id per chain and 113 differ in their `deprecated` flag. So every
// lookup below takes a chainKey and fails closed without one.
//
// byChain:     chainKey → { addrLower → { name, deprecated, id } }
// deadByChain: chainKey → Set<addrLower> of that chain's LZ Dead DVN placeholders,
//   sourced from the deployments API's per-chain `deadDVN.address` plus any DVN whose
//   canonicalName matches "LZDeadDVN" ON THAT CHAIN.
//
// deadByChain was a FLAT cross-chain Set. That was wrong and dangerous: 14 addresses are
// a dead placeholder on one chain and a live DVN on another, so a flat union classifies a
// genuine 1-of-1 as an unconfigured dead pathway and SUPPRESSES the CRITICAL — the exact
// Kelp shape the Dead Pathway rule exists to preserve. It must stay per-chain.
//
// `globalFallback` (addr → name when the name was identical on every chain) is GONE. A
// name copied from another chain is an inference, not an observation, and it silently
// papered over the chainKey-namespace bug fixed in buildDvnKeyMap() below.
export type DvnEntry = { name: string; deprecated: boolean; id: string | null };
export type DvnMeta = {
  byChain: Record<string, Record<string, DvnEntry>>;
  deadByChain: Record<string, Set<string>>;
  /** epoch ms of the successful fetch this data came from; 0 for empty metadata. */
  fetchedAt: number;
};

/** Thrown when DVN metadata is unavailable from network AND disk. Callers must not
 *  assess: a verdict computed against empty metadata silently drops every Deprecated
 *  DVN finding and turns every real dead pathway into a false CRITICAL. Refusing to
 *  score is the only safe answer — a security monitor never claims an unread config. */
export class MetadataUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("DVN metadata unavailable: no live fetch, no cached copy on disk");
    this.name = "MetadataUnavailableError";
    this.cause = cause;
  }
}

/** Fresh empty metadata. A factory, not a const: `deadByChain` holds mutable Sets and a
 *  shared instance would let one caller's writes leak into every other caller's view. */
export const emptyDvnMeta = (): DvnMeta => ({
  byChain: {},
  deadByChain: {},
  fetchedAt: 0,
});

const DVN_META_TTL_MS = 24 * 3600_000;      // refresh cadence
const DVN_META_STALE_WARN_MS = 7 * 24 * 3600_000; // loud warning past this age
const DVN_META_BASENAME = "dvn-metadata.json";

/** Bump whenever DvnMeta's serialized shape changes. Any consumer that pins a frozen
 *  copy of this structure — notably oft-bench's ground-truth fixture, which IS the
 *  reward oracle — must fail loudly rather than deserialize a v1 payload into a v2
 *  reader. A v1 fixture read as v2 leaves `deadByChain` undefined, so isDeadDvn()
 *  returns false everywhere and every dead pathway silently relabels as a live
 *  1-of-1 CRITICAL. Silent label drift in a reward oracle is unrecoverable. */
export const DVN_META_SCHEMA_VERSION = 2;

/** Disk-cache path. Mirrors custody.ts: DATA_DIR on the Railway volume, else backend/data. */
export function dvnMetaFile(): string {
  const dataDir = process.env.DATA_DIR
    ? resolve(process.env.DATA_DIR)
    : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
  return join(dataDir, DVN_META_BASENAME);
}

let dvnMetaCache: DvnMeta | null = null;

// The DVN API and the deployments API DO NOT share a chainKey namespace, despite both
// living under metadata.layerzero-api.com. For three chains the names differ outright:
//
//   deployments top-level key   deployments[].chainKey   DVN API key
//   ─────────────────────────   ──────────────────────   ───────────
//   zkconsensys-mainnet         linea                    zkconsensys
//   zkpolygon-mainnet           zkevm                    zkpolygon
//   meritcircle-mainnet         beam                     meritcircle
//
// `deployments[].chainKey` is the namespace the rest of Sentinel speaks (eids.json and
// chain-registry.json both use "linea"). The DVN API is keyed by the top-level name.
// Joining them on eid recovers the mapping at runtime, so an LZ rename self-heals
// instead of silently blanking a chain's DVN table.
//
// Before this, byChain["linea"] was undefined and globalFallback quietly supplied names
// borrowed from other chains — hiding the gap. Linea's 3 deprecated DVNs (BWare,
// Stargate, LZDeadDVN) were invisible to isDvnDeprecated(), which fails closed.
type DeployRec = { chainKey?: string; eid?: string | number; version?: number; stage?: string; deadDVN?: { address?: string } };

/** dvnApiKey → the chainKey used everywhere else in Sentinel. Derived, never hardcoded. */
function buildDvnKeyMap(dep: Record<string, { deployments?: DeployRec[] }>): {
  dvnKeyToChainKey: Record<string, string>;
  deadByChain: Record<string, Set<string>>;
} {
  const dvnKeyToChainKey: Record<string, string> = {};
  const deadByChain: Record<string, Set<string>> = {};
  for (const [topKey, val] of Object.entries(dep)) {
    for (const d of val.deployments ?? []) {
      if (d.version !== 2 || d.stage !== "mainnet") continue;
      const eid = Number(d.eid);
      if (!Number.isFinite(eid) || eid < 30000 || eid >= 40000) continue; // V2 EVM mainnet only
      const chainKey = d.chainKey;
      if (!chainKey) continue;
      dvnKeyToChainKey[topKey.replace(/-mainnet$/, "")] = chainKey;
      const dead = d.deadDVN?.address;
      if (typeof dead === "string" && dead.startsWith("0x")) {
        (deadByChain[chainKey] ??= new Set()).add(dead.toLowerCase());
      }
    }
  }
  return { dvnKeyToChainKey, deadByChain };
}

async function fetchDvnMeta(): Promise<DvnMeta> {
  // dvns gives names/deprecation/id; deployments gives the eid↔chainKey join AND the
  // authoritative per-chain deadDVN address. Dead detection is address-based so a
  // metadata canonicalName change cannot silently reinstate a false CRITICAL.
  const [dvnRes, depRes] = await Promise.all([fetch(DVN_META_URL), fetch(DEPLOYMENTS_URL)]);
  if (!dvnRes.ok || !depRes.ok) throw new Error(`metadata fetch: dvns=${dvnRes.status} deployments=${depRes.status}`);
  const raw = (await dvnRes.json()) as Record<string, { dvns?: Record<string, any> }>;
  const dep = (await depRes.json()) as Record<string, { deployments?: DeployRec[] }>;

  const { dvnKeyToChainKey, deadByChain } = buildDvnKeyMap(dep);
  const byChain: Record<string, Record<string, DvnEntry>> = {};
  for (const [dvnApiKey, chainData] of Object.entries(raw)) {
    const chainKey = dvnKeyToChainKey[dvnApiKey];
    if (!chainKey) continue; // testnet, sandbox, or non-EVM — no V2 EVM mainnet deployment
    for (const [addr, info] of Object.entries(chainData.dvns ?? {})) {
      const name = info.canonicalName ?? info.id ?? addr;
      const key = addr.toLowerCase();
      (byChain[chainKey] ??= {})[key] = {
        name,
        deprecated: !!info.deprecated,
        id: typeof info.id === "string" ? info.id.toLowerCase() : null,
      };
      if (/dead\s*dvn/i.test(name)) (deadByChain[chainKey] ??= new Set()).add(key);
    }
  }
  // A parsed-but-empty table is a silent catastrophe (every deprecation check goes
  // false, every dead pathway becomes a false CRITICAL). Treat it as a failed fetch.
  if (Object.keys(byChain).length === 0) throw new Error("DVN metadata parsed to zero chains");
  return { byChain, deadByChain, fetchedAt: Date.now() };
}

/** Serialize Sets → arrays. */
function persistDvnMeta(meta: DvnMeta): void {
  const file = dvnMetaFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const payload = {
      schemaVersion: DVN_META_SCHEMA_VERSION,
      fetchedAt: meta.fetchedAt,
      byChain: meta.byChain,
      deadByChain: Object.fromEntries(Object.entries(meta.deadByChain).map(([k, v]) => [k, [...v]])),
    };
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), "utf8"); // atomic: tmp + rename
    renameSync(tmp, file);
  } catch (e) {
    console.warn(`[dvn-meta] could not persist cache to ${file}: ${(e as Error).message}`);
  }
}

function readDvnMetaFromDisk(): DvnMeta | null {
  try {
    const raw = JSON.parse(readFileSync(dvnMetaFile(), "utf8")) as {
      schemaVersion?: number;
      fetchedAt?: number;
      byChain?: Record<string, Record<string, DvnEntry>>;
      deadByChain?: Record<string, string[]>;
    };
    // A stale-shape cache is worse than no cache: a v1 payload has no deadByChain, so
    // every dead pathway would read as a live 1-of-1. Refuse it and let the caller
    // fail closed instead.
    if (raw.schemaVersion !== DVN_META_SCHEMA_VERSION) {
      console.warn(`[dvn-meta] ignoring disk cache: schemaVersion ${raw.schemaVersion} != ${DVN_META_SCHEMA_VERSION}`);
      return null;
    }
    if (!raw.byChain || Object.keys(raw.byChain).length === 0) return null;
    return {
      byChain: raw.byChain,
      deadByChain: Object.fromEntries(Object.entries(raw.deadByChain ?? {}).map(([k, v]) => [k, new Set(v)])),
      fetchedAt: raw.fetchedAt ?? 0,
    };
  } catch {
    return null; // absent or corrupt — indistinguishable, and both mean "no floor"
  }
}

/**
 * Load DVN metadata, keyed by (chainKey, address).
 *
 * Order: fresh in-memory cache → live fetch (persisted to disk) → stale copy from
 * memory or disk, whatever its age → throw.
 *
 * Serving a stale copy beats serving an empty one: DVN deprecation moves on the order
 * of months, so week-old truth is far closer to reality than a blank table that turns
 * every Deprecated DVN finding off and every dead pathway into a false CRITICAL.
 *
 * @throws {MetadataUnavailableError} when there is no live fetch and no cached copy.
 */
export async function loadDvnMeta(): Promise<DvnMeta> {
  if (dvnMetaCache && Date.now() - dvnMetaCache.fetchedAt < DVN_META_TTL_MS) return dvnMetaCache;
  try {
    const fresh = await fetchDvnMeta();
    dvnMetaCache = fresh;
    persistDvnMeta(fresh);
    return fresh;
  } catch (err) {
    const stale = dvnMetaCache ?? readDvnMetaFromDisk();
    if (!stale) throw new MetadataUnavailableError(err);
    const ageMs = Date.now() - stale.fetchedAt;
    const ageDays = (ageMs / 86_400_000).toFixed(1);
    if (ageMs > DVN_META_STALE_WARN_MS) {
      console.error(`[dvn-meta] STALE: serving DVN metadata ${ageDays}d old — live fetch failed: ${(err as Error).message}`);
    } else {
      console.warn(`[dvn-meta] live fetch failed, serving cached copy (${ageDays}d old): ${(err as Error).message}`);
    }
    dvnMetaCache = stale;
    return stale;
  }
}

/** Test seam: drop the in-memory cache so the next load re-reads disk / network. */
export function resetDvnMetaCache(): void {
  dvnMetaCache = null;
}

// ── Metadata provenance ───────────────────────────────────────────────────────
// assessSnapshot() is NOT a pure function of (config, declarations). It has a third,
// invisible input: this DVN table. Two nodes with different cache ages can read the same
// config and reach different severities — a DVN deprecated last Tuesday flips a MEDIUM to
// a CRITICAL. Since we now deliberately serve a stale table rather than an empty one, that
// third input has to be nameable, or "same config → same verdict" is a claim we cannot
// honour and the PDR's recomputability guarantee is hollow.
//
// So every PDR carries the keccak256 of the exact table that decided it. Anyone can fetch
// the archived table, hash it, and confirm they are recomputing against the same ground
// truth we used. A verdict you cannot reproduce is not evidence, it is an assertion.
//
// Hash the WHOLE table, not the per-chain slice actually touched: the slice depends on
// which corridors happened to be active, which would make the hash a function of the
// config too. One table, one hash, one thing to archive.

/** Deterministic serialization: every key sorted, Sets → sorted arrays. JSON.stringify's
 *  key order follows insertion order, which follows the API's response order — so an
 *  upstream reordering with identical content would otherwise change the hash. */
function canonicalizeDvnMeta(meta: DvnMeta): string {
  const byChain: Record<string, Record<string, DvnEntry>> = {};
  for (const chainKey of Object.keys(meta.byChain).sort()) {
    const addrs = meta.byChain[chainKey];
    byChain[chainKey] = {};
    for (const addr of Object.keys(addrs).sort()) {
      const e = addrs[addr];
      byChain[chainKey][addr] = { name: e.name, deprecated: e.deprecated, id: e.id }; // fixed field order
    }
  }
  const deadByChain: Record<string, string[]> = {};
  for (const chainKey of Object.keys(meta.deadByChain).sort()) {
    deadByChain[chainKey] = [...meta.deadByChain[chainKey]].sort();
  }
  return JSON.stringify({ schemaVersion: DVN_META_SCHEMA_VERSION, byChain, deadByChain });
}

const hashCache = new WeakMap<DvnMeta, `0x${string}`>();

/** keccak256 of the canonical DVN table. Memoized per DvnMeta instance — the table is
 *  ~1MB and this runs once per assessed asset per cycle. */
export function dvnMetaHash(meta: DvnMeta): `0x${string}` {
  const hit = hashCache.get(meta);
  if (hit) return hit;
  const h = keccak256(toHex(canonicalizeDvnMeta(meta)));
  hashCache.set(meta, h);
  return h;
}

// Overrides for canonical names returned by the LZ metadata API.
// Only add entries backed by wiki/ — do not invent descriptions.
// LZDeadDVN is intentionally absent: it's a named LZ null-verifier contract; any route
// listing it is permanently message-blocked. Keep canonical name exactly as-is.
const FRIENDLY_DVN: Record<string, string> = {};

/** Resolve a DVN address to its canonical name on ITS OWN chain.
 *  Unregistered on this chain → an address fragment, never a name borrowed from another
 *  chain. A DVN name is an observation about a (chain, address) pair or it is nothing.
 *  chainKey must be the LZ deployments chainKey (e.g. "mantle", "linea"), not a numeric ID. */
export function resolveDvn(addr: string, chainKey: string | null, meta: DvnMeta): string {
  const key = addr.toLowerCase();
  const raw = (chainKey && meta.byChain[chainKey]?.[key]?.name) ?? null;
  if (!raw) return `${addr.slice(0, 8)}…`;
  return FRIENDLY_DVN[raw] ?? raw;
}

/** Deprecation is per-chain: 113 addresses are deprecated on one chain and live on
 *  another. Fails closed — unknown chain or unregistered address is never "deprecated". */
export function isDvnDeprecated(addr: string, chainKey: string | null, meta: DvnMeta): boolean {
  const key = addr.toLowerCase();
  if (chainKey && meta.byChain[chainKey]?.[key]) return meta.byChain[chainKey][key].deprecated;
  return false;
}

// ── Dead DVN placeholders ─────────────────────────────────────────────────────
// A "Dead DVN" is a placeholder that can never attest — no verification will ever
// match it, so a pathway whose required set is entirely dead is unconfigured and
// message-blocked (LZ "Default Config D"), NOT a live 1-of-1 (a real, compromisable
// single verifier: the Kelp pattern). Ref: LZ docs, Dead DVN
// (v2/concepts/glossary#dead-dvn): "they function as null addresses — no
// verification will match, and messages will be blocked until the Dead DVN is
// replaced."
//
// ⚠️ LZ deploys a DISTINCT dead-DVN contract per chain (116 across V2 EVM mainnets;
// base = 0x6498…9703, ethereum = 0x747c…f6ac). None of them is 0x…dEaD. Detection is a
// union of two ADDRESS-based sources, so a metadata canonicalName change cannot silently
// reinstate the false CRITICAL this rule exists to prevent:
//   1. Universal burn/zero addresses — some OApps set these by hand (weETH→Zircuit).
//   2. `meta.deadByChain[chainKey]` — the deployments API's per-chain `deadDVN.address`,
//      plus any DVN whose canonicalName matches "LZDeadDVN" ON THAT CHAIN.
//
// ⚠️ Source 2 MUST stay per-chain. It was once a flat cross-chain Set, on the theory that
// "dead addresses are chain-specific LZ placeholders, so a cross-chain union carries no
// realistic collision risk." The live metadata refutes that: 14 addresses are a dead
// placeholder on one chain and a REAL, LIVE DVN on another —
//   0x28b6140e… dead on flare,        "LayerZero Labs" on mantle
//   0x6788f524… dead on 40 chains,    "LayerZero Labs" on 32 others
//   0x282b3386… dead on space/humanity, live on 36 incl. unichain, sonic, bera
// Under the flat union, a genuine 1-of-1 on one of those DVNs is classified as an
// unconfigured dead pathway and its CRITICAL is SUPPRESSED. That is the Kelp shape,
// silenced by the very rule written to protect it. Never reintroduce the union.
const DEAD_DVN_ADDRESSES = new Set<string>([
  "0x000000000000000000000000000000000000dead",
  "0x0000000000000000000000000000000000000000",
]);

/** Fails closed: without a chainKey we cannot tell a placeholder from a live verifier,
 *  and guessing "dead" would suppress a real CRITICAL. Only universal burn addresses
 *  are chain-independent. */
export function isDeadDvn(addr: string, chainKey: string | null, meta: DvnMeta): boolean {
  const key = addr.toLowerCase();
  if (DEAD_DVN_ADDRESSES.has(key)) return true;
  if (!chainKey) return false;
  return meta.deadByChain?.[chainKey]?.has(key) ?? false;
}

// ── Self-operated DVNs ────────────────────────────────────────────────────────
// Curated: OFT ticker → the LZ DVN operator `id`s that the SAME protocol operates.
//
// This is an allowlist, not a name match, and the direction matters. `ccip` is
// Chainlink's DVN: it is self-operated for LINK and a third-party DVN for everyone
// else. Keying by ticker is what encodes that. A name/substring match cannot.
//
// Only add an entry you can source from the LZ DVN metadata registry (the `id` field).
// An unlisted protocol simply gets no Self-DVN credit — a missing positive signal,
// never a false one. That asymmetry is the point.
const SELF_DVN_IDS: Record<string, readonly string[]> = {
  usdt0: ["usdt0"],
  usdy: ["ondo"],
  pyusd: ["paxos"],
  usdg: ["paxos"],
  link: ["ccip"],
};

/** True when `addr` is a DVN operated by the protocol that issues `ticker`, on `chainKey`.
 *  Identity comes from LZ's published `id` slug, never from the display name.
 *
 *  Fails closed: without a chainKey we cannot disambiguate an address that belongs to
 *  different operators on different chains, so we decline to credit rather than guess. */
export function isSelfDvn(addr: string, ticker: string | undefined, chainKey: string | null, meta: DvnMeta): boolean {
  if (!ticker || !chainKey) return false;
  const ids = SELF_DVN_IDS[ticker.toLowerCase()];
  if (!ids) return false;
  const id = meta.byChain[chainKey]?.[addr.toLowerCase()]?.id;
  return !!id && ids.includes(id);
}

// ── ABI encoding helpers ──────────────────────────────────────────────────────
function pad32(hex: string): string {
  return hex.replace(/^0x/, "").padStart(64, "0");
}
function padAddr(addr: string): string { return pad32(addr.toLowerCase()); }
function padU32(n: number): string { return pad32(n.toString(16)); }

function uintAt(h: string, byteOffset: number): number {
  return Number(BigInt("0x" + h.slice(byteOffset * 2, byteOffset * 2 + 64)));
}
function addrAt(h: string, byteOffset: number): string {
  return getAddress("0x" + h.slice(byteOffset * 2, byteOffset * 2 + 64).slice(24));
}
function decodeAddr(raw: string): string | null {
  if (!raw || raw.length < 42) return null;
  const addr = "0x" + raw.slice(-40);
  if (BigInt(addr) === 0n) return null;
  return getAddress(addr);
}
function decodeAddressBool(raw: string): [string | null, boolean | null] {
  if (!raw || raw === "0x") return [null, null];
  const h = raw.slice(2);
  if (h.length < 128) return [null, null];
  return [getAddress("0x" + h.slice(24, 64)), BigInt("0x" + h.slice(64, 128)) !== 0n];
}

/** Decode an abi.encode(bytes) return and report whether the bytes are non-empty.
 *  Empty bytes still encode as offset word (0x20) + zero length word — checking
 *  BigInt(raw) != 0 reads the offset word and always claims "non-empty". */
function decodeBytesNonEmpty(raw: string): boolean | null {
  if (!raw || raw === "0x") return null;
  const h = raw.slice(2);
  if (h.length < 128) return null; // need offset word + length word
  const off = uintAt(h, 0);
  return uintAt(h, off) > 0;
}

export function decodeUlnConfig(raw: string): UlnSnapshot | null {
  if (!raw || raw === "0x") return null;
  const h = raw.slice(2);
  if (h.length < 192) return null;
  const S = 96;
  const confirmations      = uintAt(h, S);
  const requiredDVNCount   = uintAt(h, S + 32);
  const optionalDVNCount   = uintAt(h, S + 64);
  const optionalDVNThreshold = uintAt(h, S + 96);
  const reqOff = uintAt(h, S + 128);
  const optOff = uintAt(h, S + 160);
  const reqArr = S + reqOff;
  const reqLen = uintAt(h, reqArr);
  const requiredDVNs: string[] = [];
  for (let i = 0; i < reqLen; i++) requiredDVNs.push(addrAt(h, reqArr + 32 + i * 32));
  const optArr = S + optOff;
  const optLen = uintAt(h, optArr);
  const optionalDVNs: string[] = [];
  for (let i = 0; i < optLen; i++) optionalDVNs.push(addrAt(h, optArr + 32 + i * 32));
  return { confirmations, requiredDVNCount, requiredDVNs, optionalDVNCount, optionalDVNThreshold, optionalDVNs };
}

// Minimal structural client interface — satisfied by viem's PublicClient and by
// test doubles. Lets readSnapshot take an injectable client factory (deps.makeClient)
// so the reader is unit-testable without live RPCs, while production keeps using viem.
export interface RpcClient {
  call(args: { to: Address; data: `0x${string}` }): Promise<{ data?: string }>;
  getBytecode(args: { address: Address }): Promise<string | undefined>;
  getStorageAt(args: { address: Address; slot: `0x${string}` }): Promise<string | undefined>;
}

function defaultMakeClient(url: string): RpcClient {
  return createPublicClient({ transport: http(url) }) as unknown as RpcClient;
}

async function rawCall(client: RpcClient, to: Address, data: string): Promise<string> {
  const res = await client.call({ to, data: data as `0x${string}` });
  return res.data ?? "0x";
}

// Etherscan v2 proxy eth_call — final fallback when both Mantle RPCs fail.
// /oft-review reads the same corridors cleanly through this path while the
// public RPCs drop calls under load. Only fires after both RPCs failed, so
// volume stays far below the free-tier rate limit.
const ETHERSCAN_API = "https://api.etherscan.io/v2/api";

// Free tier allows 3 calls/sec — serialize fallback calls ~400ms apart so a
// burst of concurrent RPC failures doesn't just trade one failure mode
// (dropped calls) for another (429s).
let etherscanQueue: Promise<unknown> = Promise.resolve();

function etherscanCall(chainId: number, to: Address, data: string): Promise<string> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return Promise.reject(new Error("ETHERSCAN_API_KEY unset"));
  const next = etherscanQueue.then(async () => {
    await new Promise((r) => setTimeout(r, 400));
    const url = `${ETHERSCAN_API}?chainid=${chainId}&module=proxy&action=eth_call&to=${to}&data=${data}&tag=latest&apikey=${key}`;
    const res = await fetch(url);
    const json = (await res.json()) as { result?: unknown };
    if (typeof json.result !== "string" || !json.result.startsWith("0x")) {
      throw new Error(`etherscan eth_call: ${JSON.stringify(json).slice(0, 120)}`);
    }
    return json.result;
  });
  etherscanQueue = next.catch(() => {});
  return next;
}

// ── Etherscan PeerSet corridor discovery ─────────────────────────────────────
// keccak256("PeerSet(uint32,bytes32)") — emitted by OAppCore.setPeer on every
// standard V2 OFT. One getLogs call returns every corridor the OFT has ever
// configured (including quiet ones with no message traffic), replacing the
// 170-EID peers() brute-force sweep with ~N reads.
const PEERSET_TOPIC = "0x238399d427b947898edb290f5ff0f9109849b1c3ba196a42e35f00c50a54b98b";

/** Returns eid → peer address for every corridor whose latest PeerSet event has a
 *  non-zero peer, or null when Etherscan is unavailable. Discovery only — every
 *  EID is re-confirmed with a direct peers() read, so a wrong or stale log can
 *  suggest a corridor but never fabricate one. */
async function discoverPeersViaEtherscan(chainId: number, oft: Address): Promise<Map<number, string> | null> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return null;
  const next = etherscanQueue.then(async () => {
    await new Promise((r) => setTimeout(r, 400));
    const url = `${ETHERSCAN_API}?chainid=${chainId}&module=logs&action=getLogs&address=${oft}&topic0=${PEERSET_TOPIC}&fromBlock=0&toBlock=latest&apikey=${key}`;
    const res = await fetch(url);
    const json = (await res.json()) as { result?: unknown };
    if (!Array.isArray(json.result)) {
      throw new Error(`etherscan getLogs: ${JSON.stringify(json).slice(0, 120)}`);
    }
    // Last write per EID wins — a later setPeer(eid, 0) removes the corridor.
    const logs = (json.result as { data: string; blockNumber: string; logIndex: string }[])
      .sort((a, b) =>
        Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
        Number(BigInt(a.logIndex || "0x0") - BigInt(b.logIndex || "0x0")));
    const latest = new Map<number, string>();
    for (const log of logs) {
      const h = log.data.replace(/^0x/, "");
      if (h.length < 128) continue; // PeerSet data = eid word + peer bytes32 word
      latest.set(uintAt(h, 0), "0x" + h.slice(64, 128));
    }
    for (const [eid, peer] of latest) if (BigInt(peer) === 0n) latest.delete(eid);
    return latest;
  });
  etherscanQueue = next.catch(() => {});
  return next as Promise<Map<number, string>>;
}

// ── Corridor cache ────────────────────────────────────────────────────────────
// Corridor DISCOVERY (Etherscan getLogs or the full peers() sweep) is the
// expensive part of a read and, unlike the ULN configs themselves, changes
// rarely. Cache the discovered active-corridor set per (chainId, oft) for
// CORRIDOR_TTL_MS; on a hit we skip discovery entirely and re-read the ULN
// configs for exactly the cached EIDs.
//
// SECURITY NOTE: this only delays detection of a BRAND-NEW corridor by up to the
// TTL. Config-attack detection on EXISTING corridors is unaffected — every cycle
// still reads their ULN afresh (the cache stores only which corridors exist, not
// their configs). A newly added corridor is picked up within ≤ TTL on the next
// full-discovery cycle.
const CORRIDOR_TTL_MS = Number(process.env.CORRIDOR_TTL_MS ?? 60 * 60_000);
interface CorridorCacheEntry { at: number; eids: number[]; peers: Record<number, string> }
const corridorCache = new Map<string, CorridorCacheEntry>();

/** Clear the corridor cache (tests + operational reset). */
export function _resetCorridorCache(): void {
  corridorCache.clear();
}

/** Injectable seams so the reader is unit-testable without live RPCs. Production
 *  passes nothing and gets viem clients + the real Etherscan discovery. */
export interface ReadSnapshotDeps {
  makeClient?: (url: string) => RpcClient;
  discoverPeers?: (chainId: number, oft: Address) => Promise<Map<number, string> | null>;
  loadEidMap?: typeof loadEidMap;
  loadDvnMeta?: typeof loadDvnMeta;
  /** Injectable so tests assert the pacing WITHOUT waiting for it. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness for jitter; production uses Math.random. */
  jitter?: () => number;
}

// ── RPC retry pacing ─────────────────────────────────────────────────────────
// A throttled primary used to convert itself into a storm against the fallback
// provider: resilientCall retried the primary with NO delay (still throttled),
// then walked every fallback at full speed. Measured 2026-07-19 — dRPC
// RPS-limited 62% of the day's requests while serving only cross-checks and
// fallbacks, i.e. one provider's rate limit became another's.
//
// Pacing applies ONLY after a failure. A read that succeeds first try sleeps
// zero times; the healthy fleet pays nothing for this.
//
// 0 is a legitimate value (pacing off), so this does NOT reuse multicall.ts's
// parsePositiveInt, which rejects 0.
//
// `max` mirrors parsePositiveInt's: REJECT, never clamp. A silently-substituted
// value is a config nobody chose, same as multicall.ts's MULTICALL_CHUNK_SIZE.
function parseNonNegativeInt(name: string, raw: string | undefined, fallback: number, max?: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`${name} must be <= ${max}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

// Ceiling for both pacing knobs — a REJECT bound (see parseNonNegativeInt
// above), not a recommendation. RPC_RETRY_DELAY_MS=150000 (a plausible
// seconds/milliseconds typo) stalls a single hop 75-225s (jitter is
// 0.5x-1.5x of base), which is already well past what this cap exists to
// catch.
//
// Pacing is per CALL, not per hop or per corridor. resilientBatch's degrade
// path (the multicall3-failed branch, and batchOnClient's cross-check
// sibling) fans calls out at FALLBACK_CONCURRENCY=4 via mapLimit, and EACH of
// those calls independently pays its own resilientCall retry-then-fallback
// walk. A degraded 120-corridor read on a 3-RPC chain is ~30 waves of 4
// concurrent calls, each call worst-casing at (1 retry + 2 fallback hops). At
// the 10s cap that's 30s of pure sleep per call — ~900s (15 minutes) for ONE
// wave of ONE OFT, against an hourly cadence and a fleet sweep the code's own
// comments put at ~20 min (see sentinel.ts's DEFAULT_POLL_INTERVAL_MS). Even a
// mild-looking tune to 2000ms costs ~180s per wave per OFT. So 10s is two
// orders of magnitude above either default (150ms / 100ms) and rejects
// anything past it, but it is NOT "headroom any real pacing tune needs" —
// an operator choosing a value anywhere near this cap is choosing to drop
// configs unread, not to be cautious. Tune close to the defaults; treat this
// ceiling as a blunder-catcher, not a target.
export const RPC_DELAY_MAX_MS = 10_000;

export const RPC_RETRY_DELAY_MS = parseNonNegativeInt("RPC_RETRY_DELAY_MS", process.env.RPC_RETRY_DELAY_MS, 150, RPC_DELAY_MAX_MS);
export const RPC_FALLBACK_DELAY_MS = parseNonNegativeInt("RPC_FALLBACK_DELAY_MS", process.env.RPC_FALLBACK_DELAY_MS, 100, RPC_DELAY_MAX_MS);

// ── Snapshot reader ───────────────────────────────────────────────────────────

/**
 * Read the full ULN config for `oft` on its source chain via direct viem calls.
 * Chain-agnostic: the source chain is described entirely by the `chain` ChainRef
 * (eid, chainKey, chainId, etherscanFree, and its ordered RPC set from the
 * registry). Mantle behaviour is byte-identical for a given RPC set.
 *
 *  - Primary read client = chain.rpcs[0]; quorum/fallback clients = chain.rpcs[1..]
 *  - RPC-conflict cross-check uses the first fallback from a DIFFERENT provider
 *    than the primary; if none exists the check is skipped (never faked)
 *  - Corridor discovery (Etherscan PeerSet logs → full peers() sweep) with cache
 *  - Destination-side receive ULN resolved from the registry (every eligible chain)
 *  - Chain-keyed DVN metadata, EIP-1967 proxy admin slot + GnosisSafe detection
 */
export async function readSnapshot(oft: string, chain: ChainRef, deps: ReadSnapshotDeps = {}): Promise<OftSnapshot> {
  const makeClient = deps.makeClient ?? defaultMakeClient;
  const discoverPeers = deps.discoverPeers ?? discoverPeersViaEtherscan;
  const eidMapLoader = deps.loadEidMap ?? loadEidMap;
  const dvnMetaLoader = deps.loadDvnMeta ?? loadDvnMeta;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const jitter = deps.jitter ?? Math.random;
  // Jitter spreads retries that would otherwise re-collide in lockstep. Not
  // ~174 assets concurrently — sentinel.ts's POLL_CONCURRENCY caps that at 3
  // OFTs in flight at once — but each OFT's own sweep still fans many corridor
  // calls out concurrently (FALLBACK_CONCURRENCY, resilientBatch's degrade
  // path), and a retry re-collides with the same peers on the same client
  // every subsequent hourly cycle regardless. An un-jittered fixed delay just
  // reschedules that thundering herd one interval later.
  const backoff = (base: number) => (base > 0 ? sleep(Math.round(base * (0.5 + jitter()))) : Promise.resolve());

  const srcClient = makeClient(chain.rpcs[0].url);
  // Quorum/fallback clients from the registry (replaces the Mantle-only set).
  const fallbackRpcs = chain.rpcs.slice(1);
  const fallbackClients = fallbackRpcs.map((r) => makeClient(r.url));
  // Cross-check source for RPC-conflict detection MUST be a DIFFERENT provider
  // than the primary — two endpoints from the same provider can't independently
  // corroborate a config. If every fallback shares the primary's provider, the
  // rpcConflict cross-check is skipped rather than faked.
  const primaryProvider = normalizeProvider(chain.rpcs[0].provider);
  const secondaryIdx = fallbackRpcs.findIndex((r) => normalizeProvider(r.provider) !== primaryProvider);
  const secondaryClient = secondaryIdx >= 0 ? fallbackClients[secondaryIdx] : null;
  const oftAddr = getAddress(oft) as Address;

  // Per-corridor reads retry once on the primary RPC, fall back to the
  // secondary, then to Etherscan's eth_call proxy (only where etherscanFree). A
  // transient RPC failure must not surface as "unverifiable" — that used to
  // deduct score and pollute history (USDT0 read 50/AT_RISK while every corridor
  // was a healthy 3-of-3). An empty "0x" counts as failure: every selector we
  // call returns data, and some public RPCs return empty instead of erroring.
  async function strictCall(client: RpcClient, to: Address, data: string): Promise<string> {
    const r = await rawCall(client, to, data);
    if (!r || r === "0x") throw new Error("empty result");
    return r;
  }
  async function resilientCall(to: Address, data: string): Promise<string> {
    try {
      return await strictCall(srcClient, to, data);
    } catch { /* paced retry below */ }
    await backoff(RPC_RETRY_DELAY_MS);
    try {
      return await strictCall(srcClient, to, data);
    } catch { /* fall through to fallbacks */ }
    for (const fb of fallbackClients) {
      await backoff(RPC_FALLBACK_DELAY_MS);
      try {
        return await strictCall(fb, to, data);
      } catch { /* next fallback */ }
    }
    // Etherscan is the last resort — but only on chains its free tier serves.
    // On unsupported chains, don't burn a guaranteed-failing call per cycle.
    if (chain.etherscanFree) return etherscanCall(chain.chainId, to, data);
    throw new Error(`all RPCs failed for ${to} on chain ${chain.chainId} (etherscan unavailable)`);
  }

  /**
   * Batched sibling of resilientCall. One entry per input call, in input order.
   *
   * `null` == NO ANSWER for this sub-call. It does not distinguish "the chain
   * said nothing" from "we never managed to ask", and it must not be read as
   * either — it is exactly the old per-call decode-guard `catch`, and every
   * caller in this file treats it as UNREAD. A null may never be decoded into
   * `false`, `0`, an empty DVN set, or any other positive claim; that is the
   * invariant, and it is what keeps a rate limit from clearing a CRITICAL (see
   * isRevert's note).
   *
   * What a transport failure does NOT do is stop at the first null. A 429 or a
   * timeout kills the WHOLE batch and escalates: the next client's batch, then
   * per-call resilientCall (primary retry → every fallback → Etherscan where the
   * chain supports it). Only when that entire chain is exhausted does the entry
   * fall to `null`, via the `.catch(() => null)` below. So null is the terminal
   * state of a fully-degraded read, not a shortcut past one — the escalation is
   * the guarantee here, not the absence of nulls.
   */
  async function resilientBatch(calls: Call[]): Promise<(string | null)[]> {
    if (calls.length === 0) return [];

    if (chain.multicall3) {
      let lastErr: unknown;
      let firstClient = true;
      for (const client of [srcClient, ...fallbackClients]) {
        if (!firstClient) await backoff(RPC_FALLBACK_DELAY_MS);
        firstClient = false;
        try {
          return await aggregate3Batch(
            (to, data) => rawCall(client, to, data),
            calls,
          );
        } catch (e) {
          // Transport-level failure for this client — try the next one.
          lastErr = e;
        }
      }
      // The per-call path below answers correctly but spends the CU volume
      // batching exists to save. A chain that lands here persistently (stale
      // multicall3 flag, provider rejecting aggregate3) is invisible in the
      // results — this line is the only signal, and the first thing to check
      // when post-deploy CU numbers disagree with the projection.
      console.warn(
        `[lz-config] multicall batch failed on ${chain.chainKey} (${calls.length} calls), falling back to per-call: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
    }

    // No Multicall3, or every client failed the batch. Per-call path, which
    // carries its own retry/fallback/etherscan chain — bounded, so a failing
    // batch cannot reintroduce the unbounded fan-out this change removes.
    return mapLimit(calls, FALLBACK_CONCURRENCY, (c) =>
      resilientCall(c.target, c.callData).catch(() => null),
    );
  }

  /**
   * Batch against an ARBITRARY client — originally the destination-side
   * sibling of resilientBatch, which closes over the SOURCE chain's client
   * list and so cannot be pointed at another chain. It now ALSO serves the
   * RPC-conflict cross-check above, which points it at secondaryClient (the
   * source chain's own second provider) rather than a destination chain — so
   * `chainKey` alone no longer says which side of the read collapsed; see the
   * `label` param below.
   *
   * Destination reads use a bare rawCall today with no retry and no fallback
   * chain, so on any failure this degrades to exactly that: one rawCall per
   * call, null where the call did not answer. Both helpers share
   * aggregate3Batch for the encode → chunk → call → decode loop; they differ
   * only in what they do when a batch fails (walk the client list vs. degrade
   * on the single client we have).
   */
  async function batchOnClient(
    client: RpcClient,
    hasMulticall: boolean,
    chainKey: string,
    /** Distinguishes this call site in the warn below — "dst" for a
     *  destination-chain batch, "src-xcheck" for the source-side cross-check.
     *  Without it every collapse logs as "dst", which misdirects triage on a
     *  source-side failure straight past the actual cause. */
    label: string,
    calls: Call[],
  ): Promise<(string | null)[]> {
    if (calls.length === 0) return [];
    if (hasMulticall) {
      try {
        return await aggregate3Batch((to, data) => rawCall(client, to, data), calls);
      } catch (e) {
        // Transport-level failure for the whole batch — fall through to
        // per-call. Same observability rationale as resilientBatch's warn.
        console.warn(
          `[lz-config] multicall batch failed on ${label} ${chainKey} (${calls.length} calls), falling back to per-call: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return mapLimit(calls, FALLBACK_CONCURRENCY, (c) =>
      rawCall(client, c.target, c.callData).catch(() => null),
    );
  }

  /**
   * One client per destination RPC URL. makeClient(dstRpc) used to run once PER
   * ROUTE, so ten corridors into the same destination chain built ten clients
   * (and ten connection pools) for one endpoint.
   */
  const dstClients = new Map<string, RpcClient>();
  function dstClientFor(url: string): RpcClient {
    let c = dstClients.get(url);
    if (!c) {
      c = makeClient(url);
      dstClients.set(url, c);
    }
    return c;
  }

  const [dvnMeta, eidMap] = await Promise.all([dvnMetaLoader(), eidMapLoader()]);

  // The source chain's chainKey — used for DVN name resolution of send-side
  // configs. Prefer the deployments-API chainKey for this EID; fall back to the
  // registry's chainKey (they agree for every real chain).
  const srcChainKey = eidMap[chain.eid]?.chainKey ?? chain.chainKey;

  // ── Step 1: discover active corridors ────────────────────────────────────
  // Fast path: one Etherscan getLogs call for PeerSet events yields the exact
  // candidate EID set; each is confirmed with a direct peers() read below.
  // Falls back to sweeping ALL known V2 EVM EIDs when Etherscan is unavailable
  // for this chain, errors, or returns nothing — a missed corridor would blind
  // the monitor, so omission always degrades to the exhaustive path, never to
  // silence. Read through resilientBatch: one Multicall3 round-trip per
  // MULTICALL_CHUNK_SIZE where the chain supports it, otherwise a bounded
  // per-call sweep. Skipped entirely on a corridor-cache hit (see CORRIDOR_TTL_MS).
  const activeEids: number[] = [];
  const peerAddresses: Record<number, string> = {};

  const cacheKey = `${chain.chainId}:${oftAddr}`;
  const cached = corridorCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CORRIDOR_TTL_MS) {
    for (const e of cached.eids) activeEids.push(e);
    Object.assign(peerAddresses, cached.peers);
  } else {
    const discovered = chain.etherscanFree
      ? await discoverPeers(chain.chainId, oftAddr).catch(() => null)
      : null;
    const allEids = discovered?.size
      ? [...discovered.keys()].filter((e) => e !== chain.eid && eidMap[e])
      : Object.keys(eidMap).map(Number).filter((e) => e !== chain.eid);
    if (discovered?.size) {
      console.log(`[lz-config] ${oft}: ${allEids.length} candidate corridors via PeerSet logs (skipping full sweep)`);
    }
    const peerCalls: Call[] = allEids.map((eid) => ({
      target: oftAddr,
      callData: SEL.peers + padU32(eid),
    }));
    const peerResults = await resilientBatch(peerCalls);
    allEids.forEach((eid, i) => {
      // Per-eid guard, as the pre-batching discovery loop had. Decoding is not
      // total: BigInt() throws SyntaxError on a non-hex word and getAddress()
      // throws on a malformed slice, and the per-call fallback path hands back
      // whatever the RPC said verbatim (the batched path is mostly insulated by
      // viem's decoder, but 16 eligible chains have no Multicall3 at all). One
      // misbehaving RPC must cost that ONE corridor, not the whole snapshot —
      // an unguarded throw here rejects readSnapshot for the entire token.
      try {
        const r = peerResults[i];
        if (!r || r === "0x" || BigInt(r) === 0n) return;
        // Decode BEFORE registering the corridor. Both statements can throw, so
        // pushing first would leave a half-registered eid — in activeEids with
        // no entry in peerAddresses — which reads downstream as a live corridor
        // whose peer is null, the exact silent-wrong-answer this guard exists to
        // prevent. Either the eid gets a peer or it gets nothing.
        // peers() returns bytes32 — last 20 bytes are the peer OFT address.
        const peer = getAddress("0x" + r.slice(-40));
        activeEids.push(eid);
        peerAddresses[eid] = peer;
      } catch { /* no readable peer for this eid — treat as no corridor */ }
    });
    corridorCache.set(cacheKey, { at: Date.now(), eids: [...activeEids], peers: { ...peerAddresses } });
  }

  // ── Step 2: read send-side ULN for each active route ─────────────────────
  const routes: RouteSnapshot[] = [];

  // Probe amount for quoteSend: one whole token, so it always clears the OFT's dust
  // threshold (amounts below the shared-decimal conversion rate round to zero and can
  // trip a slippage revert, which would read as a false DORMANT). Read once per OFT.
  let probeAmount = 10n ** 18n;
  try {
    const d = await resilientCall(oftAddr, SEL.decimals);
    const dec = BigInt(d);
    if (dec > 0n && dec <= 36n) probeAmount = 10n ** dec;
  } catch { /* keep the 18-decimal default */ }

  const liveClients = [srcClient, ...fallbackClients];

  // Build every route shell up front, so batch results can be assigned by index.
  // This is the largest fan-out in the read path — ~6 eth_calls per corridor,
  // times every corridor, times every OFT. Batched it is two round trips per OFT
  // (plus chunking), and the answer must be byte-identical either way.
  const routeList: RouteSnapshot[] = activeEids.map((eid) => {
    const chainInfo = eidMap[eid];
    return {
      eid,
      chainName: chainInfo?.chainKey ?? `eid-${eid}`,
      chainKey: chainInfo?.chainKey ?? null,
      sendLibrary: null,
      sendLibIsDefault: null,
      receiveLibrary: null,
      receiveLibIsDefault: null,
      uln: null,
      receiveUln: null,
      peer: peerAddresses[eid] ?? null,
      peerAddress: peerAddresses[eid] ?? null,
      hasEnforcedOptions: null,
      isActive: true,
    };
  });

  // ── Wave 1: the four reads that depend on no prior result ─────────────────
  // Two waves rather than one because the send-side ULN getConfig needs the
  // library address that getSendLibrary returns. Everything address-independent
  // goes first.
  const w1: Call[] = [];
  for (const r of routeList) {
    w1.push({ target: ENDPOINT, callData: SEL.getSendLibrary + padAddr(oftAddr) + padU32(r.eid) });
    w1.push({ target: ENDPOINT, callData: SEL.isDefaultSendLibrary + padAddr(oftAddr) + padU32(r.eid) });
    w1.push({ target: ENDPOINT, callData: SEL.getReceiveLibrary + padAddr(oftAddr) + padU32(r.eid) });
    // enforcedOptions msgType 1 (lzReceive). Non-empty bytes = options set.
    w1.push({ target: oftAddr, callData: SEL.enforcedOptions + padU32(r.eid) + padU32(1) });
  }
  const w1res = await resilientBatch(w1);

  routeList.forEach((route, i) => {
    const base = i * 4;
    const sendLib = w1res[base];
    const isDef = w1res[base + 1];
    const recvLib = w1res[base + 2];
    const enf = w1res[base + 3];

    // A null here is exactly the old `catch { /* null */ }` branch: we did not
    // get an answer, so the field stays unread. Each decode keeps its own guard
    // because each can throw independently, and one unreadable field must not
    // cost the other three.
    if (sendLib) { try { route.sendLibrary = decodeAddr(sendLib); } catch { /* null */ } }
    // Reproduces `r && r !== "0x" ? BigInt(r) !== 0n : null` exactly:
    // resilientBatch already maps an empty return to null.
    if (isDef) { try { route.sendLibIsDefault = BigInt(isDef) !== 0n; } catch { /* null */ } }
    if (recvLib) {
      try {
        const [lib, isDefault] = decodeAddressBool(recvLib);
        route.receiveLibrary = lib;
        route.receiveLibIsDefault = isDefault;
      } catch { /* null */ }
    }
    // A null MUST stay null, never false. `false` is the positive claim "this
    // route has no enforced options", and we did not read that — we failed to
    // read anything. decodeBytesNonEmpty is null-safe, but calling it on a null
    // and letting the result stand would be the same mistake in a different
    // place, so the guard is explicit.
    if (enf) { try { route.hasEnforcedOptions = decodeBytesNonEmpty(enf); } catch { /* null */ } }
  });

  // ── Wave 2: send-side ULN, which needs wave 1's library address ───────────
  const w2routes = routeList.filter((r) => r.sendLibrary);
  const w2: Call[] = w2routes.map((r) => ({
    target: ENDPOINT,
    callData: SEL.getConfig + padAddr(oftAddr) + padAddr(r.sendLibrary!) + padU32(r.eid) + padU32(2),
  }));
  const w2res = await resilientBatch(w2);
  w2routes.forEach((route, i) => {
    const raw = w2res[i];
    if (raw) { try { route.uln = decodeUlnConfig(raw); } catch { /* null */ } }
  });

  // ── RPC source-conflict cross-check (batched) ──────────────────────────────
  // Cross-check every send-side ULN against a secondary, DIFFERENT-provider RPC.
  // Disagreement on requiredDVNs / counts / optionalDVNThreshold flags the route
  // as potentially manipulated — surfaced as CRITICAL in assessSnapshot.
  //
  // Batched via batchOnClient, which issues against ONE named client. That is the
  // distinction the previous comment here missed: batching per se is not what
  // would break this check — batching through resilientBatch would, because that
  // reads from the PRIMARY and the primary would corroborate itself. Pointing a
  // batch at secondaryClient preserves provider independence exactly.
  //
  // ~870 unbatched calls per fleet cycle became ~20. That volume was a measured
  // contributor to the secondary provider's RPS throttling (2026-07-19).
  const xcheckRoutes = secondaryClient
    ? routeList.filter((r) => r.sendLibrary && r.uln)
    : [];
  // Defensive: the filter above makes this unreachable today (every entry has
  // a decoded sendLibrary and uln), but padAddr/calldata construction is not
  // provably total, and it runs OUTSIDE batchOnClient's own try/catch. A throw
  // here must cost the cross-check, not the whole snapshot — same "one bad
  // route can't take down the read" rule as everywhere else in this function.
  let xcheckResults: (string | null)[] = [];
  try {
    xcheckResults = xcheckRoutes.length
      ? await batchOnClient(
          secondaryClient!,
          chain.multicall3,
          chain.chainKey,
          "src-xcheck",
          xcheckRoutes.map((r) => ({
            target: ENDPOINT,
            callData: SEL.getConfig + padAddr(oftAddr) + padAddr(r.sendLibrary!) + padU32(r.eid) + padU32(2),
          })),
        )
      : [];
  } catch { /* treat as NOT ASKED — same invariant as a skipped cross-check */ }
  // eid → raw secondary result. null/absent == NOT ASKED, never "no conflict".
  const xcheckByEid = new Map<number, string | null>();
  xcheckRoutes.forEach((r, i) => xcheckByEid.set(r.eid, xcheckResults[i] ?? null));

  await Promise.all(
    routeList.map(async (route) => {
      const eid = route.eid;
      const chainInfo = eidMap[eid];

      // ── RPC source-conflict check ────────────────────────────────────────
      // Consume the batched cross-check result computed above.
      const xcheckRaw = xcheckByEid.get(eid);
      if (xcheckRaw) {
        // A throw here would abort the whole route; decode defensively and treat
        // any failure as "not asked", identical to the old catch-and-skip.
        let fbUln: ReturnType<typeof decodeUlnConfig> = null;
        try { fbUln = decodeUlnConfig(xcheckRaw); } catch { fbUln = null; }
        if (fbUln && route.uln) {
          const sameCount = fbUln.requiredDVNCount === route.uln.requiredDVNCount;
          const sameThreshold = fbUln.optionalDVNThreshold === route.uln.optionalDVNThreshold;
          const sameDvns = fbUln.requiredDVNs.length === route.uln.requiredDVNs.length &&
            fbUln.requiredDVNs.every((a, i) => a.toLowerCase() === route.uln!.requiredDVNs[i]?.toLowerCase());
          if (!sameCount || !sameThreshold || !sameDvns) {
            route.rpcConflict = true;
            console.warn(`[lz-config] RPC conflict ${oft} eid=${eid}: primary=${JSON.stringify(route.uln.requiredDVNs)}, secondary=${JSON.stringify(fbUln.requiredDVNs)}`);
          }
        }
      }

      // The destination chain's RPC and its own endpoint address (varies by
      // chain). Unknown / ineligible destination → nothing destination-side can
      // be read at all, and every destination field stays null.
      //
      // The receive ULN and the reverse-peer check used to live here too; they
      // are batched per destination chain after this loop. Delivery accounting
      // stays per route because its destination read is gated on the SOURCE
      // chain's outboundNonce, which this loop has just read.
      const peerAddr = peerAddresses[eid];
      const dstRpc = chainInfo?.chainKey ? getChainRefByKey(chainInfo.chainKey)?.rpcs[0]?.url : undefined;
      const dstEndpoint = (chainInfo?.endpoint ?? ENDPOINT) as Address;
      if (peerAddr && dstRpc) {
        const peerAddrChecked = getAddress(peerAddr) as Address;
        const dstClient = dstClientFor(dstRpc);

        // ── Delivery accounting: what actually crossed ───────────────────────
        // sent (source outboundNonce) vs delivered (destination inboundNonce). No rule
        // may claim "blocked" or "stranded" without these. Config says what SHOULD
        // happen; only these say what DID.
        try {
          const sentHex = await rawCall(
            srcClient, ENDPOINT,
            encodeFunctionData({ abi: NONCE_ABI, functionName: "outboundNonce", args: [oftAddr, eid, pad(peerAddrChecked, { size: 32 })] }),
          );
          if (sentHex && sentHex !== "0x") {
            const sent = Number(BigInt(sentHex));
            let delivered: number | null = null;
            try {
              const dHex = await rawCall(
                dstClient, dstEndpoint,
                encodeFunctionData({ abi: NONCE_ABI, functionName: "inboundNonce", args: [peerAddrChecked, chain.eid, pad(oftAddr, { size: 32 })] }),
              );
              // A failed destination read must stay null. Coercing it to 0 would invent
              // `sent` stranded messages out of an RPC hiccup — a false HIGH on every
              // corridor whose destination is briefly unreachable.
              if (dHex && dHex !== "0x") delivered = Number(BigInt(dHex));
            } catch { /* delivered stays null */ }
            route.delivery = { sent, delivered };
            // UNTESTED discriminator: stamp whether the delivery history crossed under
            // the CURRENT config, when (and only when) an archival verification exists
            // and is still valid — see block-claim-verifications.ts for the validity rule.
            stampDelivery(route.delivery, route.uln, getBlockClaimVerification(chain.chainId, oftAddr, eid));
          }
        } catch { /* delivery stays undefined */ }
      }

      // ── Step 3b: sendability ─────────────────────────────────────────────
      // Will this corridor accept a send? Teams pre-wire chains long before opening
      // them, and a config on a corridor nothing can even enter is not a security
      // posture anyone chose. It also separates a harmless dormant misconfiguration
      // from a live funds trap (see the receive-side rules in drift.ts).
      route.sendability = await probeSendability(liveClients, oftAddr, eid, peerAddr ?? null, probeAmount, chain.chainId);

      routes.push(route);
    })
  );

  // ── Step 3c: destination-side reads, grouped by destination chain ─────────
  // Three reads per route (receive library, receive ULN, reverse peer) against a
  // client that was rebuilt for every single route. Now: one client and two
  // batched waves per DESTINATION chain, covering all of that chain's routes.
  //
  // ⚠️ Two FILTERED index spaces are created here, and neither lines up with
  // routeList:
  //   `jobs`       — routes with a peer AND a destination the registry resolves
  //   `needConfig` — of those, the ones whose receive library actually decoded
  // Results are assigned back over the list they were BUILT from, never over
  // routeList. Indexing wave 1 over routeList, or wave 2 over jobs, silently
  // hands a corridor the receive config of a route on a different chain — and
  // the receive config is what decides whether a message can be delivered.
  type DstJob = { route: RouteSnapshot; peer: Address; endpoint: Address };
  const byDstChain = new Map<string, { ref: ChainRef; jobs: DstJob[] }>();

  for (const route of routeList) {
    const peerAddr = peerAddresses[route.eid];
    if (!peerAddr || !route.chainKey) continue;
    const ref = getChainRefByKey(route.chainKey);
    // No RPC known for this destination ⇒ every destination field stays null,
    // and the engine falls back to `inferred` rather than asserting anything.
    if (!ref?.rpcs[0]?.url) continue;
    const bucket = byDstChain.get(route.chainKey) ?? { ref, jobs: [] };
    bucket.jobs.push({
      route,
      peer: getAddress(peerAddr) as Address,
      // The destination's OWN endpoint address, kept PER JOB rather than per
      // bucket: two eids sharing a chainKey must not inherit each other's
      // endpoint. Multicall3 carries a target per sub-call, so a batch with
      // mixed targets is fine.
      endpoint: (eidMap[route.eid]?.endpoint ?? ENDPOINT) as Address,
    });
    byDstChain.set(route.chainKey, bucket);
  }

  await Promise.all([...byDstChain.values()].map(async ({ ref, jobs }) => {
    const dstClient = dstClientFor(ref.rpcs[0].url);
    const hasMc = ref.multicall3;

    // Wave 1: receive library + reverse peer. Neither depends on a prior result.
    const d1: Call[] = [];
    for (const j of jobs) {
      // Reverse direction: the peer's receive config for messages coming FROM
      // this source chain, so the EID argument is chain.eid.
      d1.push({ target: j.endpoint, callData: SEL.getReceiveLibrary + padAddr(j.peer) + padU32(chain.eid) });
      d1.push({ target: j.peer, callData: SEL.peers + padU32(chain.eid) });
    }
    const d1res = await batchOnClient(dstClient, hasMc, ref.chainKey, "dst", d1);

    const needConfig: { job: DstJob; recvLib: string }[] = [];
    jobs.forEach((j, i) => {
      const rawRecv = d1res[i * 2];
      const back = d1res[i * 2 + 1];

      // A null is the old `catch { /* receiveUln stays null */ }` branch: we did
      // not get an answer. Each decode keeps its own guard, because one
      // unreadable field must not cost the other.
      if (rawRecv) {
        try {
          const [recvLib] = decodeAddressBool(rawRecv);
          if (recvLib) needConfig.push({ job: j, recvLib });
        } catch { /* receiveUln stays null */ }
      }

      // ── Reverse peer: is this corridor wired in BOTH directions? ───────────
      // setPeer is one-directional. If the source peers to the destination but
      // the destination does not peer back, quoteSend still succeeds (it only
      // reads the source's own peer mapping), tokens still leave — and
      // lzReceive reverts on _getPeerOrRevert forever. LZ documents this as the
      // "NotInitializable" / Blocked class. Teams wire chains one direction at a
      // time, so this is predicted to be common, and it is invisible to every
      // other check we run.
      //
      // Unread stays NULL, never false. `false` is the positive claim "the
      // destination does not peer back", which is itself a finding; null means
      // we did not look.
      if (back && back !== "0x") {
        try {
          const backAddr = BigInt(back) === 0n ? null : getAddress("0x" + back.slice(-40));
          j.route.reversePeer = backAddr;
          j.route.peerSymmetric = backAddr !== null && backAddr.toLowerCase() === oftAddr.toLowerCase();
        } catch { /* peerSymmetric stays null — unread, never assume unset */ }
      }
    });

    // Wave 2: the receive ULN, which needs wave 1's library address. Indexed
    // over needConfig — the list these calls were built from.
    const d2: Call[] = needConfig.map(({ job, recvLib }) => ({
      target: job.endpoint,
      callData: SEL.getConfig + padAddr(job.peer) + padAddr(recvLib) + padU32(chain.eid) + padU32(2),
    }));
    const d2res = await batchOnClient(dstClient, hasMc, ref.chainKey, "dst", d2);
    needConfig.forEach(({ job }, i) => {
      const raw = d2res[i];
      if (raw) { try { job.route.receiveUln = decodeUlnConfig(raw); } catch { /* null */ } }
    });
  }));

  // ── Step 4: owner + EIP-1967 proxy admin ─────────────────────────────────
  let owner: string | null = null;
  let ownerIsContract: boolean | null = null;
  let proxyAdmin: string | null = null;
  let proxyAdminOwner: string | null = null;
  let proxyAdminIsMultisig: boolean | null = null;
  let proxyAdminOwnerIsContract: boolean | null = null;

  try {
    owner = decodeAddr(await rawCall(srcClient, oftAddr, SEL.owner));
    if (owner) {
      const code = await srcClient.getBytecode({ address: owner as Address });
      ownerIsContract = !!code && code !== "0x";
    }
  } catch { /* null */ }

  try {
    const slot = await srcClient.getStorageAt({ address: oftAddr, slot: EIP1967_ADMIN_SLOT });
    if (slot && slot !== "0x" && BigInt(slot) !== 0n) {
      proxyAdmin = getAddress("0x" + slot.slice(-40));
      // ProxyAdmin.owner()
      try {
        proxyAdminOwner = decodeAddr(await rawCall(srcClient, proxyAdmin as Address, SEL.owner));
        if (proxyAdminOwner) {
          // Bytecode first: a failed GnosisSafe probe does NOT make the owner an EOA.
          // Timelocks, custom multisigs and governance contracts all fail getThreshold()
          // while being contracts. Read code once and let the rule distinguish them.
          try {
            const code = await srcClient.getBytecode({ address: proxyAdminOwner as Address });
            proxyAdminOwnerIsContract = !!code && code !== "0x";
          } catch { proxyAdminOwnerIsContract = null; /* unreadable → never scored */ }
          // GnosisSafe detection: getThreshold()
          try {
            const thresh = await rawCall(srcClient, proxyAdminOwner as Address, SEL.getThreshold);
            proxyAdminIsMultisig = thresh !== "0x" && BigInt(thresh) > 0n;
          } catch { proxyAdminIsMultisig = false; }
        }
      } catch { /* null */ }
    }
  } catch { /* not a proxy */ }

  return {
    oft: oftAddr,
    chainId: chain.chainId,
    capturedAt: Date.now(),
    owner,
    ownerIsContract,
    proxyAdmin,
    proxyAdminOwner,
    proxyAdminIsMultisig,
    proxyAdminOwnerIsContract,
    routes,
  };
}
