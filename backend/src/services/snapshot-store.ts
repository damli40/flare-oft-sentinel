import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Finding, OftSnapshot, SentinelVerdict } from "../types.js";

// DATA_DIR can be overridden via env var — set to /data on Railway (persistent volume).
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const STATE_FILE = join(DATA_DIR, "sentinel-state.json");
const HISTORY_FILE = join(DATA_DIR, "score-history.jsonl");

interface State {
  snapshots: Record<string, OftSnapshot>; // key → last-known-good snapshot
  verdicts: SentinelVerdict[]; // newest last
  // key → timestamp: verdicts captured at/before this moment are hidden from
  // latestVerdict() (tile/overlay) but stay in the ledger — the on-chain
  // attestations are immutable. Set by "Reset demo".
  verdictsClearedAt?: Record<string, number>;
  // key → fingerprint of the last weak-config (persistent CRITICAL, no drift)
  // attestation fired. Persisted so a backend restart cannot re-attest and
  // re-alert the whole CRITICAL band; a changed fingerprint re-fires.
  // corridors = the per-corridor finding sets behind that fingerprint, so a
  // corridor whose reads flake next cycle carries forward instead of re-firing.
  weakAlerts?: Record<string, { fingerprint: string; firedAt: number; corridors?: Record<string, Finding[]> }>;
}

let memState: State | null = null;

function key(oft: string, chainId: number): string {
  return `${chainId}:${oft.toLowerCase()}`;
}

function load(): State {
  if (memState) return memState;
  if (!existsSync(STATE_FILE)) {
    memState = { snapshots: {}, verdicts: [] };
    return memState;
  }
  try {
    memState = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    return memState;
  } catch {
    memState = { snapshots: {}, verdicts: [] };
    return memState;
  }
}

function save(state: State): void {
  memState = state;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getSnapshot(oft: string, chainId: number): OftSnapshot | null {
  return load().snapshots[key(oft, chainId)] ?? null;
}

export function putSnapshot(snap: OftSnapshot): void {
  const state = load();
  state.snapshots[key(snap.oft, snap.chainId)] = snap;
  save(state);
}

export function recordVerdict(v: SentinelVerdict): void {
  const state = load();
  state.verdicts.push(v);
  save(state);
}

export function getVerdicts(): SentinelVerdict[] {
  return load().verdicts;
}

export function latestVerdict(oft: string, chainId: number): SentinelVerdict | null {
  const k = key(oft, chainId);
  const state = load();
  const clearedAt = state.verdictsClearedAt?.[k] ?? 0;
  const matching = state.verdicts.filter((v) => key(v.oft, v.chainId) === k && v.capturedAt > clearedAt);
  return matching.length ? matching[matching.length - 1] : null;
}

/** Hide an OFT's existing verdicts from latestVerdict() without touching the
 * ledger. Used by "Reset demo" so the tile/overlay return to the standing
 * assessment while the attestation history (and on-chain txs) stay intact. */
export function hideVerdictsBefore(oft: string, chainId: number, ts = Date.now()): void {
  const state = load();
  state.verdictsClearedAt = { ...state.verdictsClearedAt, [key(oft, chainId)]: ts };
  save(state);
}

export function getWeakAlertFingerprint(oft: string, chainId: number): string | null {
  return load().weakAlerts?.[key(oft, chainId)]?.fingerprint ?? null;
}

/** Per-corridor findings behind the last-fired fingerprint. null for records written
 *  before the corridor-merge dedup existed — those re-fire once, then store corridors. */
export function getWeakAlertCorridors(oft: string, chainId: number): Record<string, Finding[]> | null {
  return load().weakAlerts?.[key(oft, chainId)]?.corridors ?? null;
}

/** When the last weak-config alert for this asset actually went out. Drives the
 *  re-ping cadence: the fingerprint says WHETHER the findings changed, this says
 *  HOW LONG a caller has been sitting on an unchanged one. null means never. */
export function getWeakAlertFiredAt(oft: string, chainId: number): number | null {
  return load().weakAlerts?.[key(oft, chainId)]?.firedAt ?? null;
}

/** Forget every weak-config alert record, so the next cycle treats each asset as
 *  first-sight: it re-alerts and, crucially, re-attests.
 *
 *  This exists because suppression and attestation shared one gate. A cycle that
 *  was blocked from signing still wrote the fingerprint on its way out, so when
 *  the signing scope widened on 2026-08-09 the assets it now covered were
 *  already marked "seen" and would never have been signed at all. Opening the
 *  scope does not retroactively unwrite that. This does.
 *
 *  Returns how many records were dropped. */
export function clearWeakAlerts(): number {
  const state = load();
  const n = Object.keys(state.weakAlerts ?? {}).length;
  state.weakAlerts = {};
  save(state);
  return n;
}

export function putWeakAlertFingerprint(
  oft: string,
  chainId: number,
  fingerprint: string,
  corridors?: Record<string, Finding[]>,
): void {
  const state = load();
  state.weakAlerts = { ...state.weakAlerts, [key(oft, chainId)]: { fingerprint, firedAt: Date.now(), corridors } };
  save(state);
}

// ── Score history ─────────────────────────────────────────────────────────────
// Append-only JSONL: one line per poll per OFT.

export interface HistoryEntry {
  oft: string;
  chainId: number;
  score: number;
  riskLevel: string;
  capturedAt: number;
}

let histIndex: Map<string, HistoryEntry[]> | null = null;

function loadHistIndex(): Map<string, HistoryEntry[]> {
  if (histIndex) return histIndex;
  histIndex = new Map();
  if (!existsSync(HISTORY_FILE)) return histIndex;
  for (const line of readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean)) {
    try {
      const e = JSON.parse(line) as HistoryEntry;
      const k = key(e.oft, e.chainId);
      if (!histIndex.has(k)) histIndex.set(k, []);
      histIndex.get(k)!.push(e);
    } catch { /* skip malformed */ }
  }
  return histIndex;
}

export function appendScoreHistory(entry: HistoryEntry): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
  const idx = loadHistIndex();
  const k = key(entry.oft, entry.chainId);
  if (!idx.has(k)) idx.set(k, []);
  idx.get(k)!.push(entry);
}

export function getScoreHistory(oft: string, chainId: number, limit = 100): HistoryEntry[] {
  const entries = loadHistIndex().get(key(oft, chainId)) ?? [];
  return entries.slice(-limit);
}

// ── Feed events ───────────────────────────────────────────────────────────────
// Derive a time-ordered feed from stored verdicts.

export interface FeedEvent {
  type: "drift" | "weak-config" | "finding" | "attest" | "poll";
  ticker: string;
  detail: string;
  timestamp: number;
  score?: number;
  riskLevel?: string;
  txHash?: string;
}

/** Label a verdict for the feed. "attest" only when a transaction backs it;
 *  otherwise the producer that made it, from the verdict's own field. The old
 *  `attestTxHash ? "attest" : "drift"` labelled every unattested verdict a
 *  drift, so a persistent-CRITICAL finding on a third-party token surfaced in
 *  the public feed as a config change that never happened. */
function feedType(v: SentinelVerdict): FeedEvent["type"] {
  if (v.attestTxHash) return "attest";
  if (v.verdictPath === "drift") return "drift";
  if (v.verdictPath === "weak-config") return "weak-config";
  return "finding";
}

export function getFeedEvents(limit = 40): FeedEvent[] {
  const verdicts = getVerdicts();
  const events: FeedEvent[] = verdicts.map((v) => ({
    type: feedType(v),
    ticker: v.ticker,
    detail: v.reasons.slice(0, 2).join("; ") || v.verdict,
    timestamp: v.capturedAt,
    score: v.score,
    riskLevel: v.riskLevel,
    txHash: v.attestTxHash,
  }));
  return events.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}
