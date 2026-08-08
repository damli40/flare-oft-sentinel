// Dune service: Mantle queries plus per-chain active-OFT watchlists.
//
// Leaderboard query (7638642): all-time OFT volume on Mantle, used by /api/mantle/ofts.
// Sentinel query   (7664779): Mantle OFTs with 10+ messages in the past 7 days.
// Active-watchlist queries (per chain, see ACTIVE_WATCHLIST_QUERIES): the same
//   10+ msgs / 7-day rule applied to additional EVM chains, used by the polling
//   agent to build its multi-chain watchlist. Filters out dormant and test contracts.

const DUNE_API = "https://api.dune.com/api/v1";
const LEADERBOARD_QUERY_ID = process.env.MANTLE_OFT_QUERY_ID ?? "7638642";
const SENTINEL_QUERY_ID    = process.env.MANTLE_SENTINEL_QUERY_ID ?? "7664779";

// chainKey -> Dune query ID for the "active OFTs (10+ msgs, 7-day)" watchlist on that
// chain. Each mirrors the Mantle sentinel query 7664779 with the chain_key swapped.
// Overridable via env so a query can be re-pointed without a redeploy.
const ACTIVE_WATCHLIST_QUERIES: Record<string, string> = {
  ethereum: process.env.ETHEREUM_SENTINEL_QUERY_ID ?? "7919405",
  base:     process.env.BASE_SENTINEL_QUERY_ID ?? "7919411",
  flare:    process.env.FLARE_SENTINEL_QUERY_ID ?? "8185729",
};

const KEY = process.env.DUNE_API_KEY;
const TTL_MS = 10 * 60 * 1000;

export interface MantleOft {
  ticker: string;
  project: string;
  oftName: string;
  address: string | null; // V2 OFT contract on Mantle (null for V1-only OFTs)
  messages: number;
  usdVolume: number;
  messagesFromMantle: number;
  messagesToMantle: number;
}

let cache: { at: number; rows: MantleOft[] } | null = null;
let sentinelCache: { at: number; rows: MantleOft[] } | null = null;

function mapRow(r: Record<string, unknown>): MantleOft {
  return {
    ticker: String(r.ticker ?? ""),
    project: String(r.project ?? ""),
    oftName: String(r.oft_name ?? ""),
    address: r.oft_address ? String(r.oft_address) : null,
    messages: Number(r.messages ?? 0),
    usdVolume: Number(r.usd_volume ?? 0),
    messagesFromMantle: Number(r.messages_from_mantle ?? 0),
    messagesToMantle: Number(r.messages_to_mantle ?? 0),
  };
}

async function fetchRows(queryId: string): Promise<Record<string, unknown>[]> {
  if (!KEY) throw new Error("DUNE_API_KEY is not set");
  const res = await fetch(`${DUNE_API}/query/${queryId}/results?limit=200`, {
    headers: { "X-Dune-API-Key": KEY },
  });
  if (!res.ok) throw new Error(`Dune API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { result?: { rows?: Record<string, unknown>[] } };
  return json.result?.rows ?? [];
}

async function fetchQuery(queryId: string): Promise<MantleOft[]> {
  return (await fetchRows(queryId)).map(mapRow);
}

/** All-time Mantle OFT leaderboard, sorted by USD volume. Backs /api/mantle/ofts. */
export async function getMantleOfts(force = false): Promise<MantleOft[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await fetchQuery(LEADERBOARD_QUERY_ID);
  cache = { at: Date.now(), rows };
  return rows;
}

/**
 * Active watchlist for the Sentinel: OFTs with 10+ messages in the past 7 days.
 * Filters out dormant and test contracts so the agent only polls real bridges.
 */
export async function getSentinelWatchlist(force = false): Promise<MantleOft[]> {
  if (!force && sentinelCache && Date.now() - sentinelCache.at < TTL_MS) return sentinelCache.rows;
  const rows = await fetchQuery(SENTINEL_QUERY_ID);
  sentinelCache = { at: Date.now(), rows };
  return rows;
}

export const MANTLE_OFT_QUERY_ID = LEADERBOARD_QUERY_ID;
export const MANTLE_SENTINEL_QUERY_ID = SENTINEL_QUERY_ID;

// --- Additional-chain active-OFT watchlists -------------------------------

/** Active OFT on a non-Mantle chain (10+ msgs / 7-day rule). Chain-neutral shape:
 *  message-direction columns vary by chain and aren't needed for the watchlist. */
export interface ActiveOft {
  ticker: string;
  project: string;
  oftName: string;
  address: string | null; // V2 OFT contract on that chain (null for V1-only OFTs)
  messages: number;
  usdVolume: number;
}

function mapActiveRow(r: Record<string, unknown>): ActiveOft {
  return {
    ticker: String(r.ticker ?? ""),
    project: String(r.project ?? ""),
    oftName: String(r.oft_name ?? ""),
    address: r.oft_address ? String(r.oft_address) : null,
    messages: Number(r.messages ?? 0),
    usdVolume: Number(r.usd_volume ?? 0),
  };
}

const activeCache = new Map<string, { at: number; rows: ActiveOft[] }>();

/** Chain keys that have an active-OFT watchlist query configured. */
export function activeWatchlistChainKeys(): string[] {
  return Object.keys(ACTIVE_WATCHLIST_QUERIES);
}

/** Active OFTs on `chainKey` (10+ msgs / 7-day). Empty list if the chain has no
 *  query configured. Cached per chain for TTL_MS. */
export async function getActiveOftsForChain(chainKey: string, force = false): Promise<ActiveOft[]> {
  const queryId = ACTIVE_WATCHLIST_QUERIES[chainKey];
  if (!queryId) return [];
  const cached = activeCache.get(chainKey);
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.rows;
  const rows = (await fetchRows(queryId)).map(mapActiveRow);
  activeCache.set(chainKey, { at: Date.now(), rows });
  return rows;
}
