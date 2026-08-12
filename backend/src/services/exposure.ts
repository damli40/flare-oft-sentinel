import {
  createPublicClient,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  http,
  type Address,
} from "viem";
import { readExposure, type Exposure } from "./ftso.js";
import { aggregate3Batch, MULTICALL3_ADDRESS, type Call } from "./multicall.js";
import { sentinelChain, sentinelRpcUrl } from "./chain-registry.js";

// ── What each watched contract holds, priced by the enshrined oracle ─────────
//
// TWO jobs, and the second one is the reason this file is not three lines long.
//
// FIRST: ftso.ts prices an asset off the oracle and THROWS on transport failure
// — deliberately, so "the chain said no" stays distinguishable from "we failed
// to ask". That contract is right for the module and wrong for the caller: the
// verdict is the product and a price is a nice-to-have, so a rate limit on the
// price read must never take a verdict off the page. This module is that
// boundary. It answers with a map, it answers with an EMPTY map when anything
// goes wrong, and it never rejects. A row absent from the map renders as "not
// read this cycle" — absence stated as absence, never as zero.
//
// SECOND, and this is the part that had to be measured rather than assumed:
// THE AMOUNT. `readExposure` reads `totalSupply()` on the address it is given,
// which answers "how much of this token exists". That is NOT the question this
// product asks. The question is what the watched contract CUSTODIES on this
// chain, because that is what a forged inbound message could move.
//
// The two numbers are wildly different, measured on Flare Mainnet 2026-08-08:
//
//   watched FXRP adapter  token() -> a different ERC20
//                         underlying.totalSupply         148,811,449.705  $155,417,934
//                         underlying.balanceOf(adapter)   12,929,748.171   $13,503,764
//   watched USDT0 adapter token() -> a different ERC20
//                         underlying.totalSupply          26,421,206.049   $26,407,467
//                         underlying.balanceOf(adapter)                0            $0
//
// Serving totalSupply would have printed $155M for a contract holding $13.5M
// (11.5x) and $26.4M for one holding nothing at all. Both figures would have
// been confident, precise and false, on a page handed to judges.
//
// So the amount is read per SHAPE, each shape detected from `token()`, and each
// shape's answer carries its own label — see `HoldingBasis`. The label is on the
// row, not in a footnote: "$13,503,764" means nothing without the noun.

/** Which question this row's number answers. The two are not interchangeable and
 *  a row never shows one under the other's label.
 *
 *  `custodied`   — what the watched contract itself holds: an adapter's balance
 *                  of the token it locks, or a native-coin OFT's own balance.
 *  `circulating` — a plain OFT's own `totalSupply()`: it holds nothing, it mints
 *                  and burns, so the honest measure is what exists on this chain. */
export type HoldingBasis = "custodied" | "circulating";

/** One asset's holding, priced, shaped for JSON.
 *
 *  `amount` is a decimal STRING, not a bigint: JSON has no bigint and
 *  `res.json()` throws outright on one. It stays raw (unscaled) and travels with
 *  `decimals` so a consumer scales it the same way the pricing did, rather than
 *  receiving a float that already lost the distinction between "0" and "unread".
 *
 *  `readAt` is when THIS INSTANCE read the feed; `feedTimestamp` is the second-
 *  precision timestamp the feed itself reported. They answer different
 *  questions and both are served. */
export interface ExposureView {
  /** Feed name, e.g. "XRP/USD". Null when the ticker has no feed at all. */
  feed: string | null;
  /** Raw amount held, on the basis `basis` names. Null when the read was refused. */
  amount: string | null;
  decimals: number | null;
  basis: HoldingBasis | null;
  priceUsd: number | null;
  valueUsd: number | null;
  feedTimestamp: number | null;
  stale: boolean;
  readAt: number;
  /** The contract the amount was read from — the underlying ERC20 for an
   *  adapter, the watched address otherwise. Served so a page stating a figure
   *  can also state which contract it came from, rather than letting a reader
   *  assume it was the address in the row's own link. */
  pricedToken: string | null;
  /** True only for a lockbox-shaped OFT that custodies NOTHING while the token
   *  it moves has a supply: it mints on arrival instead of releasing from a
   *  vault. Set so the page can explain a real $0 rather than let it read as a
   *  broken number. It is NOT a licence to substitute the supply figure. */
  mintsOnArrival: boolean;
}

export interface ExposureAsset {
  address: string;
  chainId: number;
  ticker?: string | null;
}

/** How long one fleet read is served for. /status is polled once a minute by the
 *  page and is also a public URL, so without this every reader would push a
 *  fresh multicall at the RPC. */
export const EXPOSURE_TTL_MS = 60_000;

/** Ceiling on the whole read. The transport carries its own timeout, but an
 *  injected or misbehaving one that simply never settles would hang /status
 *  forever — which is a worse failure than the throw this module exists to
 *  absorb, because nothing downstream can even observe it. */
export const EXPOSURE_TIMEOUT_MS = 10_000;

/** `chainId:address`, address lowercased — the same identity the snapshot store
 *  keys on, so a row and its exposure cannot be matched by ticker (which is a
 *  label, not an identity). */
export function exposureKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

let cache: { keys: string; at: number; byKey: Map<string, ExposureView> } | null = null;

/** Drop the cached read. Tests call this between fixtures; nothing in the
 *  running service does. */
export function resetExposureCache(): void {
  cache = null;
}

/** An `eth_call` on the chain this instance's own client speaks to, built the
 *  same way attestor.ts and alerts.ts build theirs — from the chain registry, so
 *  this file holds no chain literal of its own. */
function defaultCall(): (to: string, data: string) => Promise<string> {
  const info = sentinelChain();
  // This is the call site the missing endpoint hurt most: eth_call carries no chain
  // id, so a wrong endpoint here returned another chain's balances and FTSOv2
  // prices with no error anywhere, and /status served them as this chain's.
  const rpc = sentinelRpcUrl();
  const chain = defineChain({
    id: info.chainId,
    name: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: { default: { http: [rpc] } },
  });
  const client = createPublicClient({
    chain,
    transport: http(rpc, { timeout: EXPOSURE_TIMEOUT_MS }),
  });
  return async (to, data) => {
    const res = await client.call({ to: to as Address, data: data as `0x${string}` });
    return res.data ?? "0x";
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`exposure read exceeded ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ── Three shapes, three reads, three labels ──────────────────────────────────
//
// A watched address is the OFT. The OFT is not always the ERC20, and it is not
// always the custodian either. LayerZero's OFT interface exposes `token()`
// precisely because these can be different contracts, and `token()` is what
// tells the three shapes apart. Measured on this instance's own fleet:
//
//   token() -> a DIFFERENT address   lockbox. It locks the underlying and
//                                    releases it on arrival, so the number that
//                                    matters is `underlying.balanceOf(oft)`.
//                                    CUSTODIED. (FXRP, USDT0)
//   token() -> the zero address      native-coin OFT. It holds no ERC20 at all;
//                                    it holds the chain's own coin, so the
//                                    number is the OFT's native balance.
//                                    CUSTODIED. (FLR)
//   token() reverts, or returns the  plain OFT. It custodies nothing — it mints
//   OFT itself                       and burns — so the honest measure is its
//                                    own totalSupply(). CIRCULATING.
//                                    (DINERO, UP, MOFT)
//
// Every branch reads something DIFFERENT and calls it something different. The
// one thing none of them does is fall back to the underlying's totalSupply for a
// lockbox: that is the number that would have printed $155M for a contract
// holding $13.5M, and `exposure.test.ts` carries a guard whose only job is to
// fail if someone reintroduces it.
//
// A wrong-but-plausible `token()` answer from a selector collision cannot invent
// a figure either: the balance and decimals reads that follow would have to
// succeed on that same contract, and if they do it is an ERC20 holding what it
// says it holds.

const OFT_TOKEN_ABI = [
  { name: "token", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const ERC20_READ_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Multicall3's own native-balance helper. Used rather than `eth_getBalance` so
 *  the native read travels the SAME injected `call` as everything else: one
 *  transport, one batch, one thing to fake in a test. Verified against
 *  `eth_getBalance` on Flare Mainnet 2026-08-08 — identical answer. */
const MULTICALL3_BALANCE_ABI = [
  {
    name: "getEthBalance",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type Shape =
  /** Lockbox: reads `token.balanceOf(oft)`. */
  | { kind: "lockbox"; token: string }
  /** Native-coin OFT: reads the OFT's own coin balance. */
  | { kind: "native" }
  /** Plain OFT: reads its own `totalSupply()`. */
  | { kind: "plain" };

function basisOf(shape: Shape): HoldingBasis {
  return shape.kind === "plain" ? "circulating" : "custodied";
}

/** `token()` for every watched address. A null row means the call reverted or
 *  answered nothing, which is what a plain OFT does — that is a SHAPE, not a
 *  failure. A transport failure is not caught here: it propagates so the whole
 *  read degrades, rather than silently reclassifying every asset as plain. */
async function resolveTokens(
  addresses: string[],
  call: (to: string, data: string) => Promise<string>,
): Promise<(string | null)[]> {
  const rows = await aggregate3Batch(
    call as (to: Address, data: string) => Promise<string>,
    addresses.map((address) => ({
      target: address as Address,
      callData: encodeFunctionData({ abi: OFT_TOKEN_ABI, functionName: "token" }),
    })),
  );
  return rows.map((raw) => {
    if (raw === null) return null;
    try {
      return (
        decodeFunctionResult({
          abi: OFT_TOKEN_ABI,
          functionName: "token",
          data: raw as `0x${string}`,
        }) as string
      ).toLowerCase();
    } catch {
      return null;
    }
  });
}

function classify(oft: string, token: string | null): Shape {
  if (token === null) return { kind: "plain" }; // token() reverted or answered nothing
  if (token === ZERO_ADDRESS) return { kind: "native" };
  if (token === oft) return { kind: "plain" }; // an OFT that IS its own token
  return { kind: "lockbox", token };
}

/** The custodied amount for every shape that has one, in input order. `null`
 *  entries are the plain OFTs, whose amount comes from `readExposure` instead. */
async function readCustodied(
  watched: string[],
  shapes: Shape[],
  call: (to: string, data: string) => Promise<string>,
): Promise<(bigint | null)[]> {
  const calls: Call[] = [];
  const owner: number[] = []; // asset index per call
  shapes.forEach((shape, i) => {
    if (shape.kind === "lockbox") {
      calls.push({
        target: shape.token as Address,
        callData: encodeFunctionData({
          abi: ERC20_READ_ABI,
          functionName: "balanceOf",
          args: [watched[i] as Address],
        }),
      });
      owner.push(i);
    } else if (shape.kind === "native") {
      calls.push({
        target: MULTICALL3_ADDRESS,
        callData: encodeFunctionData({
          abi: MULTICALL3_BALANCE_ABI,
          functionName: "getEthBalance",
          args: [watched[i] as Address],
        }),
      });
      owner.push(i);
    }
  });

  const out: (bigint | null)[] = watched.map(() => null);
  if (calls.length === 0) return out;

  const rows = await aggregate3Batch(call as (to: Address, data: string) => Promise<string>, calls);
  rows.forEach((raw, j) => {
    if (raw === null) return;
    try {
      // Both helpers return a bare uint256, so one decode serves both.
      out[owner[j]] = decodeFunctionResult({
        abi: ERC20_READ_ABI,
        functionName: "balanceOf",
        data: raw as `0x${string}`,
      }) as bigint;
    } catch {
      // Undecodable but non-empty: the chain answered junk. Left null, which
      // renders as "amount not reported" rather than as zero.
    }
  });
  return out;
}

/**
 * Compose one row. `priced` is the `readExposure` row for this asset, read
 * against the contract the shape names, so its `priceUsd`/`feed`/`stale` are the
 * oracle read and its `supply`/`decimals` describe THAT contract.
 *
 * Which of those survive into the view depends on the shape, and the one rule
 * that matters is negative: for a lockbox, `priced.supply` is the UNDERLYING'S
 * TOTAL SUPPLY and must never become the amount.
 */
function compose(
  priced: Exposure,
  shape: Shape,
  custodied: bigint | null,
  nativeDecimals: number,
  watchedAddress: string,
  readAt: number,
): ExposureView {
  const amount = shape.kind === "plain" ? priced.supply : custodied;
  const decimals =
    shape.kind === "native" ? nativeDecimals : priced.decimals; // lockbox: the underlying's own
  const valueUsd =
    amount !== null && decimals !== null && priced.priceUsd !== null
      ? scaledToNumber(amount, decimals) * priced.priceUsd
      : null;

  // A lockbox holding nothing while the token it moves has a supply is not a
  // failed read: it mints on arrival instead of releasing from a vault. Flagged
  // so the page can say so, because an unexplained $0 reads as a bug — and NOT
  // so anything can quietly substitute the supply figure for the zero.
  const mintsOnArrival =
    shape.kind === "lockbox" && amount === 0n && priced.supply !== null && priced.supply > 0n;

  return {
    feed: priced.feed,
    amount: amount === null ? null : amount.toString(),
    decimals,
    basis: basisOf(shape),
    priceUsd: priced.priceUsd,
    valueUsd,
    feedTimestamp: priced.feedTimestamp,
    stale: priced.stale,
    readAt,
    pricedToken: shape.kind === "lockbox" ? shape.token : watchedAddress,
    mintsOnArrival,
  };
}

/**
 * Scale a raw amount by its decimals without routing an astronomically large
 * integer through a single Number() cast — the same technique, and for the same
 * reason, as ftso.ts's own private helper: an 18-decimal token with a billions-
 * scale supply carries a ~10^27 raw value, far past Number.MAX_SAFE_INTEGER.
 */
function scaledToNumber(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(raw / scale) + Number(raw % scale) / Number(scale);
}

/**
 * Read what every watched asset on this instance's chain holds, and price it.
 *
 * NEVER REJECTS and never throws. Every failure — transport, timeout, a
 * malformed answer readExposure chose to refuse — degrades to an empty map, the
 * caller serves `exposure: null` for the affected rows, and every verdict still
 * publishes.
 *
 * Assets on any OTHER chain are left out rather than read against the wrong
 * node: one client speaks to one chain, and a balance answered by a different
 * chain is not a smaller number, it is a wrong one. They come back absent, which
 * the page states as unread.
 *
 * ⚠️ "This instance's chain" means the SENTINEL chain — where the AuditRegistry
 * lives — not the chain an asset is watched on. On Flare those are both 14, so
 * the two ideas look like one. They are not. A deployment that signs on one chain
 * and watches assets on others (the Mantle shape: registry on 5003, assets on
 * 5000 / 1 / 8453) matches nothing here and serves `exposure: null` for every row
 * forever, which the page renders as the transient-looking "not read this cycle".
 * The scoping below is still correct — reading a Mantle balance off a Flare node
 * would be worse — but a permanent condition must not wear a transient label, so
 * the mismatch now says so once instead of failing silently. Reading exposure on
 * a chain other than the sentinel chain needs a per-chain client, which is a
 * larger change than a scoping tweak and is tracked separately.
 */
/** Logged at most once per process. /status is polled every 60s by every open rail
 *  page, and a permanent misconfiguration must not become a per-request log flood —
 *  the operator needs to see it, not drown in it. */
let warnedChainMismatch = false;
function warnExposureChainMismatch(chainId: number, assets: ExposureAsset[]): void {
  if (warnedChainMismatch) return;
  warnedChainMismatch = true;
  const present = [...new Set(assets.map((a) => a.chainId))].sort((a, b) => a - b);
  console.warn(
    `[exposure] disabled: the sentinel chain is ${chainId}, but all ${assets.length} watched ` +
      `asset(s) are on chain(s) ${present.join(", ")}. Holdings are read through the sentinel ` +
      `chain's client only, so every row will publish exposure: null until an asset is watched ` +
      `on chain ${chainId}. This is a configuration mismatch, not a transient read failure.`,
  );
}

/** Test-only: the warning latch is module state, and a suite that asserts the
 *  mismatch path more than once needs to clear it between cases. */
export function __resetExposureChainMismatchWarning(): void {
  warnedChainMismatch = false;
}

export async function readFleetExposure(
  assets: ExposureAsset[],
  deps: {
    call?: (to: string, data: string) => Promise<string>;
    now?: () => number;
    /** Overridable so the never-settles case can be proved in milliseconds
     *  instead of holding the suite for the production ceiling. */
    timeoutMs?: number;
  } = {},
): Promise<Map<string, ExposureView>> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? EXPOSURE_TIMEOUT_MS;
  const chainId = sentinelChain().chainId;
  const inScope = assets.filter((a) => a.chainId === chainId);
  if (inScope.length === 0) {
    // Nothing to read is normal when the watchlist is empty. Having assets and
    // matching NONE of them is a configuration mismatch that will never resolve
    // on its own, so name both sides once rather than serving an unexplained
    // null on every row of every /status for the life of the process.
    if (assets.length > 0) warnExposureChainMismatch(chainId, assets);
    return new Map();
  }

  const keys = inScope.map((a) => exposureKey(a.chainId, a.address)).join(",");
  const at = now();
  // The key list is part of the cache identity: a watchlist that gained an asset
  // must not serve it from a read that never covered it.
  if (cache && cache.keys === keys && at - cache.at < EXPOSURE_TTL_MS) return cache.byKey;

  // Lowercased throughout. viem rejects a MIXED-case address whose checksum does
  // not verify, and that rejection happens while encoding the batch — so one
  // badly-cased watchlist entry would take the price read for the WHOLE fleet
  // down, not just its own row. An all-lowercase address is always accepted, and
  // the key this maps back to is lowercased too.
  const watchedAddresses = inScope.map((a) => a.address.toLowerCase());

  try {
    // INSIDE the try, deliberately. defaultCall() resolves the endpoint through
    // sentinelRpcUrl(), which THROWS for a sentinel chain with no configured RPC.
    // Built one line above the try, that throw escaped as a rejected promise and
    // made the "NEVER REJECTS and never throws" contract in this function's
    // docstring false — the caller in /status now creates this promise early and
    // awaits it late, so a rejection there is an unhandled rejection rather than
    // a caught one, and Node's default policy is to end the process. Trading a
    // null price for a dead server is exactly the bargain the contract exists to
    // forbid, so the construction belongs where every other failure already lands.
    const call = deps.call ?? defaultCall();
    const nativeDecimals = sentinelChain().nativeCurrency.decimals;
    const { priced, shapes, custodied } = await withTimeout(
      (async () => {
        const tokens = await resolveTokens(watchedAddresses, call);
        const shapes = watchedAddresses.map((oft, i) => classify(oft, tokens[i]));
        // The oracle read is aimed at the contract the shape names, so a
        // lockbox's price and DECIMALS come from the underlying rather than from
        // an adapter that answers neither. Its `supply` field is the
        // underlying's total supply and is used for exactly one thing: telling a
        // mint-on-arrival zero apart from a plain zero.
        const [priced, custodied] = await Promise.all([
          readExposure(
            inScope.map((a, i) => {
              const shape = shapes[i];
              return {
                address: shape.kind === "lockbox" ? shape.token : watchedAddresses[i],
                ticker: a.ticker ?? null,
              };
            }),
            { call, now },
          ),
          readCustodied(watchedAddresses, shapes, call),
        ]);
        return { priced, shapes, custodied };
      })(),
      timeoutMs,
    );
    const byKey = new Map<string, ExposureView>();
    priced.forEach((row, i) =>
      byKey.set(
        exposureKey(inScope[i].chainId, inScope[i].address),
        compose(row, shapes[i], custodied[i], nativeDecimals, watchedAddresses[i], at),
      ),
    );
    // Only a SUCCESSFUL read is cached. Caching a failure would keep the page
    // saying "not read this cycle" for a full TTL after the RPC recovered.
    cache = { keys, at, byKey };
    return byKey;
  } catch (e) {
    console.warn(
      `[exposure] price read failed, serving verdicts without it: ${(e as Error).message}`,
    );
    return new Map();
  }
}
