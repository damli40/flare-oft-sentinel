const BASE = (import.meta.env.VITE_API_URL ?? "") + "/api";

export interface MantleOft {
  ticker: string;
  project: string;
  oftName: string;
  address?: string | null;
  messages: number;
  usdVolume: number;
  messagesFromMantle: number;
  messagesToMantle: number;
}

export interface MantleOftsResponse {
  queryId: string;
  source: string;
  count: number;
  ofts: MantleOft[];
}

export async function getMantleOfts(): Promise<MantleOftsResponse> {
  const res = await fetch(`${BASE}/mantle/ofts`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Failed to load OFTs");
  }
  return res.json();
}

// ── Sentinel ──────────────────────────────────────────────────────────────

export interface TransactionIntent {
  intent: string;
  action: string;
  corridors?: string[];
  dvnAddress?: string;
  dvnName?: string;
  currentState: string;
  targetState: string;
  reason: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "PASS";
  preflight?: {
    scoreBefore: number;
    riskBefore: "PASS" | "AT_RISK" | "CRITICAL";
    scoreAfter: number;
    riskAfter: "PASS" | "AT_RISK" | "CRITICAL";
  };
}

export interface PolicyDecisionRecord {
  oft: string;
  chainId: number;
  findings: Array<{ severity: string; check: string; detail: string }>;
  score: number;
  riskLevel: "PASS" | "AT_RISK" | "CRITICAL";
  evaluatedAt: number;
  agentId: number;
  rulesVersion: string;
}

export interface SentinelVerdict {
  oft: string;
  chainId: number;
  ticker: string;
  score: number;
  riskLevel: "PASS" | "AT_RISK" | "CRITICAL";
  verdict: string;
  reasons: string[];
  verdictHash: string;
  attestationId?: string;
  attestTxHash?: string;
  alertTxHash?: string;
  capturedAt: number;
  tis?: TransactionIntent[];
  pdr?: PolicyDecisionRecord;
}

/** One active route's verification set, as read on-chain this cycle. `/status`
 *  serves one of these per active corridor; `uln` is null when the route's ULN
 *  could not be read (never treat that as "no DVNs"). `dvnSummary` below is the
 *  same data collapsed to the FIRST readable corridor only — use this field
 *  when the per-route breakdown matters.
 *
 *  The message libraries sit outside `uln` because they are read from the
 *  endpoint rather than the ULN, so they survive an unreadable ULN. Any of the
 *  four is null when that read failed — render nothing for a null, never a
 *  placeholder: an unread library shown as "—" is absence displayed as a value. */
export interface DvnCorridor {
  corridor: string;
  eid: number;
  sendLibrary: string | null;
  sendLibIsDefault: boolean | null;
  receiveLibrary: string | null;
  receiveLibIsDefault: boolean | null;
  uln: {
    /** Block confirmations the route waits for. Optional only because the
     *  single-corridor `dvnSummary` fallback below carries no confirmations
     *  reading at all — a live per-route corridor always states it. Absent
     *  means unread: render nothing, never 0. */
    confirmations?: number;
    requiredCount: number;
    optionalThreshold: number;
    effectiveCount: number;
    requiredDVNs: string[];
    optionalDVNs: string[];
    names: Record<string, string>;
  } | null;
}

/** Which question an asset's number answers. The two are NOT interchangeable:
 *  `custodied` is what the watched contract itself holds — an adapter's balance
 *  of the token it locks, or a native-coin OFT's own coin balance — and
 *  `circulating` is a plain mint-and-burn OFT's own total supply. Serving one
 *  under the other's label overstates by whatever fraction of the supply is not
 *  actually locked here. */
export type HoldingBasis = "custodied" | "circulating";

/** What one watched asset holds, priced by the enshrined FTSOv2 oracle, as
 *  `/status` serves it.
 *
 *  Every field is nullable and the whole object is optional, because every one
 *  of them is a read that can fail on its own: `feed` is null when the ticker has
 *  no feed at all, `priceUsd` is null when the feed was not read or came back
 *  stale, and `valueUsd` is null unless amount, decimals AND price all resolved.
 *  Null means "not known", never zero — a `$0` printed for an unread balance is
 *  absence displayed as a value.
 *
 *  `amount` is a raw decimal string (JSON has no bigint) and is scaled by
 *  `decimals`. NOTHING here reaches the score: the rule engine reads the config
 *  snapshot and neither a price nor a balance is one of its inputs. */
export interface AssetExposure {
  feed: string | null;
  amount: string | null;
  decimals: number | null;
  basis: HoldingBasis | null;
  priceUsd: number | null;
  valueUsd: number | null;
  /** Seconds, as the feed itself reported it — not the time we read it. */
  feedTimestamp: number | null;
  stale: boolean;
  /** Milliseconds: when this instance read the feed. */
  readAt: number;
  /** The contract the amount was read from. A watched OFT and the ERC20 it moves
   *  are not always the same address, so a page stating a figure can say which
   *  contract it came from instead of leaving a reader to assume it was the one
   *  the row links to. */
  pricedToken: string | null;
  /** A lockbox-shaped OFT that custodies nothing because it mints on arrival.
   *  Served so a real $0 can be explained rather than read as a broken number. */
  mintsOnArrival: boolean;
}

export interface WatchedStatus {
  ticker: string;
  address: string;
  chainId: number;
  lastSnapshotAt: number | null;
  corridors?: string[];
  assessment: {
    score: number;
    riskLevel: "PASS" | "AT_RISK" | "CRITICAL";
    reasons: string[];
    tis: TransactionIntent[];
  } | null;
  latestVerdict: SentinelVerdict | null;
  dvnSummary: { requiredCount: number; optionalThreshold: number; effectiveCount: number; requiredDVNs: string[]; optionalDVNs: string[] } | null;
  dvnNames: Record<string, string> | null;
  dvnCorridors?: DvnCorridor[] | null;
  /** Optional: an older instance does not serve it, and an instance whose price
   *  read failed serves null. Both render as unread, never as zero. */
  exposure?: AssetExposure | null;
}

/** A chain the Sentinel currently watches — served by /status, derived from the
 *  backend chain registry. The ONLY source of chain names in the UI: never
 *  hardcode chain names in frontend copy, so adding a chain on the backend
 *  updates the whole frontend automatically. */
export interface WatchedChain {
  chainId: number;
  chainKey: string | null;
  name: string;
  count: number;
  /** null when we have no verified explorer for the chain — render no link. */
  explorer?: string | null;
}

/** Which chain this instance's contracts live on, and where to link them.
 *  Served by the backend from SENTINEL_CHAIN_ID / SENTINEL_CHAIN_NAME so the UI
 *  never hardcodes an explorer. `explorer` is null when the chain has no known
 *  one — render the bare hash, never a guessed link. */
export interface SentinelChain {
  chainId: number;
  name: string;
  explorer: string | null;
}

/** Provenance of the DVN metadata table the scores were computed against.
 *
 *  This is a THIRD-PARTY input: LayerZero's public DVN metadata, refetched on a
 *  cycle. The rule engine is deterministic given a fixed input, and this table
 *  is part of that input — its chain coverage changes over time, so a score can
 *  move with no on-chain change to the asset. A page that renders the verdicts
 *  without ever showing when this was read is overclaiming, which is why the
 *  rail page renders `fetchedAt` beside the fleet.
 *
 *  `stale` means the instance is serving a cached table because the live fetch
 *  failed — the verdicts are still real, just computed against older ground
 *  truth. Optional because an older instance does not serve the field at all;
 *  absent renders as "not reported", never as fresh. */
export interface DvnMetaStatus {
  hash: string;
  fetchedAt: number;
  stale: boolean;
}

export interface SentinelStatus {
  watched: WatchedStatus[];
  chains?: WatchedChain[];
  msi: number | null;
  msiBreakdown: { critical: number; atRisk: number; safe: number; unassessed: number } | null;
  registry?: string;
  alertBus?: string;
  chain?: SentinelChain;
  rulesVersion?: string;
  dvnMeta?: DvnMetaStatus;
}

export interface HistoryEntry {
  score: number;
  riskLevel: string;
  capturedAt: number;
}

export interface FeedEvent {
  // Mirrors backend snapshot-store.ts FeedEvent. "weak-config" and "finding"
  // exist so an unattested verdict is not mislabelled a drift.
  type: "drift" | "weak-config" | "finding" | "attest" | "poll";
  ticker: string;
  detail: string;
  timestamp: number;
  score?: number;
  riskLevel?: string;
  txHash?: string;
}

export async function getSentinelStatus(): Promise<SentinelStatus> {
  const res = await fetch(`${BASE}/sentinel/status`);
  if (!res.ok) throw new Error("Failed to load Sentinel status");
  return res.json();
}

export async function getSentinelVerdicts(): Promise<SentinelVerdict[]> {
  const res = await fetch(`${BASE}/sentinel/verdicts`);
  if (!res.ok) throw new Error("Failed to load verdicts");
  return (await res.json()).verdicts ?? [];
}



export async function getReport(address: string): Promise<{ ticker: string; markdown: string }> {
  const res = await fetch(`${BASE}/sentinel/report/${address}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Report generation failed");
  }
  return res.json();
}


export async function getOftHistory(address: string): Promise<HistoryEntry[]> {
  const res = await fetch(`${BASE}/sentinel/history/${address}`);
  if (!res.ok) return [];
  return (await res.json()).history ?? [];
}

/** Score history for every watched OFT in one call — keyed by lowercase address. */
export async function getAllHistories(): Promise<Record<string, HistoryEntry[]>> {
  const res = await fetch(`${BASE}/sentinel/history`);
  if (!res.ok) return {};
  return (await res.json()).histories ?? {};
}


export async function getFeed(): Promise<FeedEvent[]> {
  const res = await fetch(`${BASE}/sentinel/feed`);
  if (!res.ok) return [];
  return (await res.json()).events ?? [];
}

export interface CopilotResponse {
  answer: string;
  relevantOfts: string[];
  remaining?: number;
  limit?: number;
}

export async function askSecurityCopilot(question: string): Promise<CopilotResponse> {
  const res = await fetch(`${BASE}/sentinel/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Copilot request failed");
  }
  return res.json();
}
