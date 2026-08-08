import { encodeFunctionData, decodeFunctionResult, type Address } from "viem";
import { aggregate3Batch, type Call } from "./multicall.js";

// ── FTSOv2 — Flare's enshrined price oracle ──────────────────────────────────
// Flare Mainnet only. https://dev.flare.network/ftso/solidity-reference
export const FTSOV2_ADDRESS = "0x7BDE3Df0624114eDB3A67dFe6753e62f4e7c1d20" as Address;

/**
 * The documented 21-byte feed ID: a 1-byte category (hex, "01" = crypto)
 * followed by the feed name, UTF-8 encoded and right-padded with zero bytes
 * out to 20 bytes total. https://dev.flare.network/ftso/feeds
 *
 * Worked example from the docs:
 *   feedId("01", "FLR/USD") === "0x01464c522f55534400000000000000000000000000"
 */
export function feedId(category: string, name: string): `0x${string}` {
  // The category is 1 raw byte, always written as exactly 2 hex chars ("01" =
  // crypto). Anything else silently produces a differently-shaped ID rather
  // than failing, the same hazard the name-length guard below exists for.
  if (!/^[0-9a-fA-F]{2}$/.test(category)) {
    throw new Error(`feedId: category must be exactly 2 hex chars, got ${JSON.stringify(category)}`);
  }
  const nameHex = Array.from(new TextEncoder().encode(name))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // 20 bytes = 40 hex chars is all the encoding has room for. A name that
  // doesn't fit would silently truncate into a DIFFERENT feed's ID rather
  // than fail — refuse instead of guessing which feed the caller meant.
  if (nameHex.length > 40) {
    throw new Error(`feedId: name "${name}" exceeds 20 bytes`);
  }
  return `0x${category}${nameHex.padEnd(40, "0")}` as `0x${string}`;
}

/**
 * Ticker → FTSOv2 feed NAME, case-insensitive. Only the feeds this instance has
 * verified exist on Flare Mainnet — nothing speculative. A ticker with no entry
 * here returns null, and callers must treat that as "unpriceable", never as an
 * excuse to guess a feed by proximity of name.
 */
const TICKER_FEED: Record<string, string> = {
  FLR: "FLR/USD",
  WFLR: "FLR/USD",
  FXRP: "XRP/USD",
  XRP: "XRP/USD",
  USDT: "USDT/USD",
  USDT0: "USDT/USD",
  USDC: "USDC/USD",
  ETH: "ETH/USD",
  WETH: "ETH/USD",
};

export function feedForTicker(ticker: string | null | undefined): string | null {
  if (!ticker) return null;
  return TICKER_FEED[ticker.toUpperCase()] ?? null;
}

/**
 * Block-latency feeds update roughly every 1.8s. Ten minutes of silence past a
 * feed's own reported timestamp means the feed process stalled — a fault, not
 * lag — and the price it last reported must not be served as current.
 */
export const FEED_STALE_AFTER_S = 600;

export interface Exposure {
  address: string;
  ticker: string | null;
  feed: string | null; // "XRP/USD", or null when unpriceable
  supply: bigint | null; // raw totalSupply
  decimals: number | null; // token decimals
  priceUsd: number | null; // null when no feed, stale, or the read failed
  valueUsd: number | null; // null unless supply, decimals AND price resolved
  feedTimestamp: number | null;
  stale: boolean;
}

const ERC20_ABI = [
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/**
 * getFeedsById is declared `payable` and non-`view` on the real FtsoV2
 * interface (https://dev.flare.network/ftso/solidity-reference), so it can
 * only be answered via `eth_call` simulation — never viem's `readContract`,
 * which is for `view`/`pure` functions. Every sub-call inside an
 * `aggregate3Batch` invocation already IS an `eth_call` (Multicall3's
 * `aggregate3` is itself simulated, not sent), so routing this call through
 * `aggregate3Batch` satisfies that constraint for free. This ABI is used only
 * to encode the request and decode the response.
 */
const FTSOV2_ABI = [
  {
    name: "getFeedsById",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "_feedIds", type: "bytes21[]" }],
    outputs: [
      { name: "_values", type: "uint256[]" },
      { name: "_decimals", type: "int8[]" },
      { name: "_timestamp", type: "uint64" },
    ],
  },
] as const;

/**
 * Convert a raw token amount (uint256, up to ~10^77) to a human-scaled float
 * without ever routing the astronomically-large raw integer through a single
 * Number() cast. An 18-decimal token with a billions-scale supply already
 * carries a ~10^27 raw value — far past Number.MAX_SAFE_INTEGER (~9×10^15).
 *
 * Dividing by the decimal scale FIRST, in bigint arithmetic, brings the
 * whole-unit part down to a realistic token count before it ever becomes a
 * float; only the sub-unit remainder (always < scale) goes through Number(),
 * where any precision lost is a fraction of one token, not a fraction of a
 * quintillion.
 */
function scaledToNumber(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

/**
 * Price every watched asset off FTSOv2 and compute its USD exposure.
 *
 * `call` takes the exact shape `aggregate3Batch` already takes in
 * `multicall.ts` — this module never opens its own RPC connection, and it
 * never imports `lz-config.ts` (frozen; see ftso.test.ts's import-isolation
 * guard) even though that file has its own private `rawCall` with the same
 * signature.
 *
 * Every `totalSupply()` and `decimals()` read for every asset, PLUS one
 * `getFeedsById` call carrying the DISTINCT feed set, go through a single
 * `aggregate3Batch` invocation — a feed shared by two assets (FLR and WFLR
 * both price off FLR/USD) produces one price read, not two.
 *
 * "Single invocation" means one call into `aggregate3Batch`, not one round
 * trip: that function chunks internally at `MULTICALL_CHUNK_SIZE` (default
 * 50). With `N` assets this batch carries `2N + 1` sub-calls (or `2N` with no
 * priced asset at all), so it only stays inside one wire-level chunk while
 * `2N + 1 <= MULTICALL_CHUNK_SIZE` — true up to 24 assets at the default, false
 * at 25+. Index alignment is correct either way (aggregate3Batch guarantees
 * "one entry per input call, in input order" across chunk boundaries), so a
 * larger watchlist still prices correctly; it just costs more than one
 * eth_call.
 *
 * THROWS on transport failure, matching aggregate3Batch's documented
 * contract: "the chain said no" (a null row) must stay distinguishable from
 * "we failed to ask" (a throw), so a rate limit can never be misread as an
 * empty/unpriceable result. An undecodable but non-empty row (a misbehaving
 * RPC returning junk bytes for a real answer — see fake-rpc.ts's own note on
 * this hazard) is a THIRD case, distinct from both: the chain did answer, so
 * it must not surface as a transport failure either. It is handled per-row
 * below by treating a decode failure the same as an unread value, not by
 * letting it propagate and fail the whole batch.
 */
export async function readExposure(
  assets: Array<{ address: string; ticker?: string | null }>,
  deps: { call: (to: string, data: string) => Promise<string>; now?: () => number },
): Promise<Exposure[]> {
  const now = deps.now ?? Date.now;
  const feedNames = assets.map((a) => feedForTicker(a.ticker));

  // Distinct feeds, first-seen order.
  const distinctFeeds: string[] = [];
  for (const f of feedNames) {
    if (f && !distinctFeeds.includes(f)) distinctFeeds.push(f);
  }

  const calls: Call[] = [];
  for (const a of assets) {
    calls.push({
      target: a.address as Address,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: "totalSupply" }),
    });
    calls.push({
      target: a.address as Address,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }),
    });
  }
  const feedsCallIndex = calls.length;
  if (distinctFeeds.length > 0) {
    calls.push({
      target: FTSOV2_ADDRESS,
      callData: encodeFunctionData({
        abi: FTSOV2_ABI,
        functionName: "getFeedsById",
        args: [distinctFeeds.map((name) => feedId("01", name))],
      }),
    });
  }

  const results = await aggregate3Batch(
    deps.call as (to: Address, data: string) => Promise<string>,
    calls,
  );

  // feed name -> resolved price + the shared timestamp the batch returned.
  // Populated only when the getFeedsById row itself came back non-null AND
  // decoded cleanly to arrays as long as the request; a reverted/empty row,
  // an undecodable row, or a row that answered fewer/more feeds than asked
  // all leave every priced asset's priceUsd null below (see readExposure's
  // own docstring for why a decode failure must not throw here).
  const priceByFeed = new Map<string, { priceUsd: number; timestamp: number }>();
  if (distinctFeeds.length > 0) {
    const raw = results[feedsCallIndex];
    if (raw !== null) {
      try {
        const [values, decimalsArr, timestamp] = decodeFunctionResult({
          abi: FTSOV2_ABI,
          functionName: "getFeedsById",
          data: raw as `0x${string}`,
        }) as readonly [readonly bigint[], readonly number[], bigint];
        // Refuse to index a row that didn't answer every feed asked, the same
        // posture aggregate3Batch itself takes on a row-count mismatch
        // ("refuse the whole batch" rather than risk misattributing feed i's
        // price to a different feed at a shifted index).
        if (values.length === distinctFeeds.length && decimalsArr.length === distinctFeeds.length) {
          distinctFeeds.forEach((name, i) => {
            // Each feed carries its OWN decimals — never assume they match
            // across feeds, or match the token's own decimals (a different
            // axis entirely).
            priceByFeed.set(name, {
              priceUsd: Number(values[i]) / 10 ** decimalsArr[i],
              timestamp: Number(timestamp),
            });
          });
        }
      } catch {
        // Undecodable payload (a misbehaving RPC returning junk bytes for a
        // real answer). The chain DID answer — this is not a transport
        // failure — so it must not propagate and fail every asset in the
        // batch. priceByFeed stays empty for this call, same outcome as a
        // reverted row.
      }
    }
  }

  /** Decode one ERC20 sub-call result, or null on an undecodable (but
   *  non-empty) payload — never let a single junk row take down every other
   *  asset's otherwise-healthy read. */
  function decodeErc20<T>(functionName: "decimals" | "totalSupply", raw: string | null): T | null {
    if (raw === null) return null;
    try {
      return decodeFunctionResult({ abi: ERC20_ABI, functionName, data: raw as `0x${string}` }) as T;
    } catch {
      return null;
    }
  }

  return assets.map((a, i) => {
    const feed = feedNames[i];
    const supplyRaw = results[i * 2];
    const decimalsRaw = results[i * 2 + 1];

    const decodedDecimals = decodeErc20<number>("decimals", decimalsRaw);
    const decimals = decodedDecimals !== null ? Number(decodedDecimals) : null;
    const supply = decodeErc20<bigint>("totalSupply", supplyRaw);

    let priceUsd: number | null = null;
    let feedTimestamp: number | null = null;
    let stale = false;

    if (feed) {
      const p = priceByFeed.get(feed);
      if (p) {
        feedTimestamp = p.timestamp;
        const ageS = now() / 1000 - p.timestamp;
        if (ageS > FEED_STALE_AFTER_S) {
          stale = true; // priceUsd stays null: a price we cannot vouch for is worse than none
        } else {
          priceUsd = p.priceUsd;
        }
      }
    }

    // A raw supply with unknown decimals cannot be converted and must not be
    // guessed at 18 — every branch of this gate is a hard prerequisite.
    const valueUsd =
      supply !== null && decimals !== null && priceUsd !== null
        ? scaledToNumber(supply, decimals) * priceUsd
        : null;

    return {
      address: a.address,
      ticker: a.ticker ?? null,
      feed,
      supply,
      decimals,
      priceUsd,
      valueUsd,
      feedTimestamp,
      stale,
    };
  });
}
