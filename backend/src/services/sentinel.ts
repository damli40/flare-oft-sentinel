import type { OftSnapshot, RouteSnapshot, WatchedOft, SentinelVerdict } from "../types.js";
import { readSnapshot, loadDvnMeta, MetadataUnavailableError } from "./lz-config.js";
import { sendTelegram } from "./alerts.js";
import { assessSnapshot } from "./drift.js";
import { runCheck, produceWeakConfigAttestation } from "./orchestrator.js";
import { getSnapshot, putSnapshot, appendScoreHistory, hideVerdictsBefore } from "./snapshot-store.js";
import { getMantleOfts, getActiveOftsForChain, activeWatchlistChainKeys } from "./dune.js";
import { getChainRef, getChainRefByKey } from "./chain-registry.js";
import { chainAllowed, pinnedAssets } from "./watch-scope.js";

const MANTLE_CHAIN_ID = Number(process.env.MANTLE_CHAIN_ID ?? 5000);
const POLL_CONCURRENCY = 3; // OFTs read in parallel per cycle (bounds RPC load)

// Synthetic OFT used exclusively for the Kelp replay demo.
// Never polled for real on-chain config — snapshot is injected by runKelpReplay.
const KELP_DEMO_OFT: WatchedOft = {
  ticker: "DEMO",
  address: "0x0000000000000000000000000000000000001337",
  chainId: MANTLE_CHAIN_ID,
};

// Mantle watchlist: all-time OFTs with ≥$1M USD volume from the leaderboard query
// (7638642). Value-at-risk, not recent activity, decides who we watch on Mantle — a
// high-value bridge that has gone quiet is exactly where a config drift goes unnoticed.
// Additional EVM chains use the active-OFT rule (10+ msgs / 7-day) instead: on chains
// with a broad OFT universe, recent activity is the right dormancy/test filter.
const WATCHLIST_MIN_VOLUME = 1_000_000;
let watchedCache: { at: number; list: WatchedOft[] } | null = null;
const WATCHED_TTL = 10 * 60_000;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// A watchlist source failing must surface as an incident, never as a silently
// smaller fleet: a Dune outage on a cold cache used to mean "poll nothing" with
// the dashboard still showing yesterday's tiles — a monitoring blackout displayed
// as safety, the same bug class the DVN-metadata preflight exists to kill.
export interface WatchlistHealth {
  degraded: boolean;
  reasons: string[]; // one per failed source, e.g. "ethereum watchlist fetch failed: dune 500"
  lastRefreshAt: number | null; // last time every source resolved
  servedStaleAt: number | null; // set when the last good list is served past a failed refresh
}

let watchlistHealth: WatchlistHealth = {
  degraded: false,
  reasons: [],
  lastRefreshAt: null,
  servedStaleAt: null,
};

export function getWatchlistHealth(): WatchlistHealth {
  return { ...watchlistHealth };
}

// One-shot latch, same shape as metadataBlackoutAlerted: alert on the transition
// into a degraded watchlist, re-arm on the first clean refresh.
let watchlistDegradedAlerted = false;

async function alertWatchlistDegraded(reasons: string[]): Promise<void> {
  if (watchlistDegradedAlerted) return;
  watchlistDegradedAlerted = true;
  await sendTelegram(
    process.env.TELEGRAM_CHAT_ID ?? null,
    `🚨 <b>Sentinel watchlist DEGRADED</b>\n${reasons.join("\n")}\nAffected chains are not being refreshed; serving the last good list where one exists. Monitoring coverage is reduced until this clears.`,
    "watchlist-degraded",
  ).catch((err) => console.error("[sentinel] watchlist-degraded alert failed:", err?.message));
}

export async function getWatched(force = false): Promise<WatchedOft[]> {
  // The replay demo asset is Mantle-scoped: an instance scoped away from Mantle
  // must not carry it, or a single-chain fleet reports a contract it never polls.
  const maybeDemo = chainAllowed("mantle") ? [KELP_DEMO_OFT] : [];

  if (!force && watchedCache && Date.now() - watchedCache.at < WATCHED_TTL)
    return [...watchedCache.list, ...maybeDemo];

  const seen = new Set<string>(); // dedupe by chainId:address — the same OFT address
                                  // deploys to the same address on multiple chains, so
                                  // dedupe must be per-chain, not address-only.
  const list: WatchedOft[] = [];
  const add = (ticker: string, address: string, chainId: number) => {
    const key = `${chainId}:${address.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ ticker, address, chainId });
  };
  const failures: string[] = [];

  // Mantle: all-time leaderboard, ≥$1M volume (behavior unchanged).
  // Skipped entirely when WATCH_CHAINS scopes this instance away from Mantle —
  // a chain we don't watch must not cost a Dune call, and a source we never
  // asked for must not be able to mark the watchlist degraded.
  if (chainAllowed("mantle")) {
    try {
      const mantleOfts = await getMantleOfts(force);
      for (const o of mantleOfts) {
        if (!o.address || !ADDR_RE.test(o.address)) continue;
        if (o.usdVolume < WATCHLIST_MIN_VOLUME) continue;
        add(o.ticker, o.address, MANTLE_CHAIN_ID);
      }
    } catch (e: any) {
      failures.push(`mantle watchlist fetch failed: ${e?.message ?? e}`);
    }
  }

  // Additional EVM chains: active-OFT rule (10+ msgs / 7-day), no volume floor.
  // Only watch a chain the registry can quorum-read; skip unknown/ineligible silently.
  for (const chainKey of activeWatchlistChainKeys()) {
    if (!chainAllowed(chainKey)) continue;
    const ref = getChainRefByKey(chainKey);
    if (!ref || !ref.eligible) continue;
    try {
      const ofts = await getActiveOftsForChain(chainKey, force);
      for (const o of ofts) {
        if (!o.address || !ADDR_RE.test(o.address)) continue;
        add(o.ticker, o.address, ref.chainId);
      }
    } catch (e: any) {
      failures.push(`${chainKey} watchlist fetch failed: ${e?.message ?? e}`);
    }
  }

  // Pinned assets (WATCH_PINNED): watched because the operator said so, not
  // because Dune found them. A day-one deployment has no 7-day activity history,
  // so the activity rule alone would leave a live OFT unmonitored. Pins therefore
  // bypass chainAllowed and the volume/activity thresholds — but NEVER the
  // registry eligibility check: the multi-RPC quorum invariant is not something
  // an env var gets to scope away. Deduped by the same chainId:address key, so a
  // pin that Dune also returned stays one entry.
  for (const pin of pinnedAssets()) {
    const ref = getChainRefByKey(pin.chainKey);
    if (!ref || !ref.eligible) {
      console.warn(`[sentinel] WATCH_PINNED: no eligible registry ref for "${pin.chainKey}" — skipped`);
      continue;
    }
    add(pin.ticker, pin.address, ref.chainId);
  }

  if (failures.length === 0) {
    // Clean refresh: cache it, clear degradation, re-arm the blackout latch.
    if (list.length) watchedCache = { at: Date.now(), list };
    watchlistHealth = { degraded: false, reasons: [], lastRefreshAt: Date.now(), servedStaleAt: null };
    watchlistDegradedAlerted = false;
    return [...list, ...maybeDemo];
  }

  // Degraded refresh. If everything failed, the last good list beats an empty fleet:
  // stale coverage keeps monitoring alive while the status flag says exactly how stale.
  const serveStale = list.length === 0 && watchedCache !== null;
  watchlistHealth = {
    degraded: true,
    reasons: failures,
    lastRefreshAt: watchlistHealth.lastRefreshAt,
    servedStaleAt: serveStale ? watchedCache!.at : null,
  };
  for (const f of failures) console.error(`[sentinel] ${f}`);
  await alertWatchlistDegraded(failures);
  if (serveStale) return [...watchedCache!.list, ...maybeDemo];
  // Partial coverage: serve what resolved this cycle without overwriting the
  // (possibly fuller) cached list — the failed chains recover from cache next refresh.
  return [...list, ...maybeDemo];
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

let polling = false;
// One-shot latch: alert on the transition into a metadata blackout, not once per cycle.
// Re-armed as soon as a load succeeds, so a second outage alerts again.
let metadataBlackoutAlerted = false;

/** Poll every watched OFT once: read live config → run the drift check. */
export async function pollOnce(): Promise<void> {
  if (polling) {
    console.log("[sentinel] poll already in progress — skipping this tick");
    return;
  }
  polling = true;
  try {
    // Preflight the DVN table ONCE per cycle. Without it every asset fails identically in
    // its own catch, 174 times, as an indistinguishable "poll failed" line — and the fleet
    // silently stops being monitored while the dashboard keeps showing yesterday's PASS
    // tiles. A metadata blackout is an incident, not a log line: alert, then skip the
    // cycle without reading, scoring or attesting anything.
    try {
      await loadDvnMeta();
    } catch (e) {
      if (e instanceof MetadataUnavailableError) {
        console.error("[sentinel] DVN metadata unavailable — skipping poll cycle, nothing assessed or attested");
        if (!metadataBlackoutAlerted) {
          metadataBlackoutAlerted = true;
          await sendTelegram(
            process.env.TELEGRAM_CHAT_ID ?? null,
            "🚨 <b>Sentinel monitoring STOPPED</b>\nDVN metadata unavailable from the LayerZero API and no cached copy on disk. No configs are being assessed and no verdicts are being attested until this clears.",
            "metadata-blackout",
          ).catch((err) => console.error("[sentinel] blackout alert failed:", err?.message));
        }
        return;
      }
      throw e;
    }
    // Recovered: re-arm the one-shot so the next blackout alerts again.
    metadataBlackoutAlerted = false;

    const watched = await getWatched();
    const chainCount = new Set(watched.filter((w) => w.ticker !== "DEMO").map((w) => w.chainId)).size;
    console.log(`[sentinel] polling ${watched.length} OFTs across ${chainCount} chain(s)`);
    await mapLimit(watched.filter((w) => w.ticker !== "DEMO"), POLL_CONCURRENCY, async (w) => {
      try {
        // Resolve the OFT's source chain from the registry (keyed-provider
        // ordering is applied inside getChainRef). An unknown or ineligible
        // chain is logged and skipped — never crash the poller over one
        // asset's config.
        const chainRef = getChainRef(w.chainId);
        if (!chainRef || !chainRef.eligible) {
          console.warn(`[sentinel] ${w.ticker}: chain ${w.chainId} not in registry or ineligible — skipping`);
          return;
        }
        const snap = await readSnapshot(w.address, chainRef);
        // Never store or score a snapshot with 0 active routes. Either the peer sweep
        // failed under RPC load (transient) or the OFT genuinely has no peers — in both
        // cases storing it would either wipe a good baseline OR, on a first-ever poll,
        // publish a false "100 / SAFE" verdict for an OFT we never actually read. A
        // security monitor must never claim an unread config is safe. Skip; a later
        // cycle with a clean read establishes the real baseline (tile shows pending).
        const hasActiveRoutes = snap.routes.some(r => r.isActive);
        if (!hasActiveRoutes) {
          const existing = getSnapshot(w.address, w.chainId);
          const note = existing?.routes.some(r => r.isActive) ? "protecting baseline" : "no false PASS";
          console.warn(`[sentinel] ${w.ticker}: 0 active routes this cycle — skipping (${note})`);
          return;
        }
        // Skip storing if every active route returned a null ULN — indicates a failed
        // RPC read. Storing would overwrite a good baseline with incomplete data.
        const hasAnyUln = snap.routes.some(r => r.isActive && r.uln !== null);
        if (!hasAnyUln && snap.routes.some(r => r.isActive)) {
          console.warn(`[sentinel] ${w.ticker}: all ULN reads returned null — skipping putSnapshot`);
          return;
        }
        // Record score history on every poll cycle.
        const { score, riskLevel, findings, tis } = await assessSnapshot(snap, w.ticker);
        appendScoreHistory({ oft: w.address, chainId: w.chainId, score, riskLevel, capturedAt: snap.capturedAt });
        // Run drift check first — it attests+alerts when the config changed.
        // Only fire the weak-config attest path when there was NO drift this cycle:
        // drift events are already handled by runCheck→produceVerdict, and calling
        // both paths in the same tick would land two on-chain attestations for the
        // same config change.
        const driftVerdict = await runCheck(w, snap);
        if (!driftVerdict && riskLevel === "CRITICAL") {
          await produceWeakConfigAttestation(w, snap, findings, score, riskLevel, tis);
        }
      } catch (e: any) {
        console.error(`[sentinel] poll failed for ${w.ticker}:`, e.shortMessage ?? e.message);
      }
    });
  } finally {
    polling = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Seed (or re-seed) the DEMO OFT's healthy 2-of-2 baseline so the fleet grid
 * shows its standing config before a replay flips it to CRITICAL. Prior replay
 * verdicts are hidden from the tile/overlay; the attestation ledger (and the
 * on-chain txs it mirrors) stays intact. */
export function resetDemo(): void {
  putSnapshot(makeSnapshot(KELP_DEMO_OFT.address, KELP_DEMO_OFT.chainId, 2));
  hideVerdictsBefore(KELP_DEMO_OFT.address, KELP_DEMO_OFT.chainId);
}

// Hourly by default: a full fleet sweep is ~20 min of continuous RPC reads and config
// changes are rare — the 5-min timer mostly skipped into the still-running previous
// sweep anyway. POLL_INTERVAL_MS overrides (event-driven detection is the real fix).
const DEFAULT_POLL_INTERVAL_MS = 60 * 60_000;

export function startSentinel(intervalMs = Number(process.env.POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS): void {
  // The poller is not Mantle-specific — it sweeps every chain in the watchlist,
  // so naming one chain here was false on any other instance.
  console.log(`[sentinel] starting fleet poll, every ${intervalMs / 1000}s`);
  // DEMO shows its healthy baseline from boot — but never clobber a replayed
  // state on restart; the dashboard's "Reset demo" button does that explicitly.
  if (!getSnapshot(KELP_DEMO_OFT.address, KELP_DEMO_OFT.chainId)) resetDemo();
  pollOnce().catch(console.error);
  timer = setInterval(() => pollOnce().catch(console.error), intervalMs);
}

export function stopSentinel(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── Demo: Kelp replay ───────────────────────────────────────────────────────
// Models the single-DVN failure shape: a route running 1-of-1. We can't alter
// a live mainnet config, so the replay seeds a healthy 2-of-2 baseline, then
// feeds the loop a crafted 1-of-1 snapshot to show the verdict flip to CRITICAL
// and a real attestation land on Mantle.

function route(eid: number, chainName: string, requiredDVNCount: number, confirmations: number): RouteSnapshot {
  const dvns = ["0x589dEDbD617e0CBcB916A9223F4d1300c294236b", "0x8ddF05F9A5c488b4973897E278B58895bF87Cb24"];
  return {
    eid,
    chainName,
    chainKey: "ethereum",
    sendLibrary: "0x1234567890123456789012345678901234567890",
    sendLibIsDefault: false,
    receiveLibrary: "0x1234567890123456789012345678901234567890",
    receiveLibIsDefault: false,
    uln: {
      confirmations,
      requiredDVNCount,
      requiredDVNs: dvns.slice(0, requiredDVNCount),
      optionalDVNCount: 0,
      optionalDVNThreshold: 0,
      optionalDVNs: [],
    },
    receiveUln: null, // synthetic — no destination-side read in the replay
    peer: "0x000000000000000000000000" + "ab".repeat(20),
    peerAddress: "0x" + "ab".repeat(20),
    hasEnforcedOptions: null,
    isActive: true,
  };
}

function makeSnapshot(oft: string, chainId: number, requiredDVNCount: number): OftSnapshot {
  return {
    oft,
    chainId,
    capturedAt: Date.now(),
    owner: "0x000000000000000000000000000000000000dEaD",
    ownerIsContract: true,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes: [route(30101, "ethereum", requiredDVNCount, 15)],
  };
}

export async function runKelpReplay(): Promise<SentinelVerdict> {
  const w = KELP_DEMO_OFT;

  // 1. Seed a healthy 2-of-2 baseline.
  putSnapshot(makeSnapshot(w.address, w.chainId, 2));

  // 2. Feed the crafted 1-of-1 drift through the live loop logic.
  const drifted = makeSnapshot(w.address, w.chainId, 1);
  const verdict = await runCheck(w, drifted);
  if (!verdict) throw new Error("Kelp replay did not trigger drift — check baseline seeding");
  return verdict;
}

// ── Demo: Library revert replay ─────────────────────────────────────────────
// Replays the "receive library reverted to default" attack pattern:
// LZ Labs can change inbound message acceptance rules unilaterally,
// bypassing DVN config entirely. Drifts a pinned-library baseline to
// CRITICAL and lands a real attestation on Mantle Sepolia.

function routeLibRevert(eid: number, chainName: string): RouteSnapshot {
  return { ...route(eid, chainName, 2, 15), receiveLibIsDefault: true };
}

function makeSnapshotLibRevert(oft: string, chainId: number): OftSnapshot {
  return {
    oft,
    chainId,
    capturedAt: Date.now(),
    owner: "0x000000000000000000000000000000000000dEaD",
    ownerIsContract: true,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes: [routeLibRevert(30101, "ethereum")],
  };
}

export async function runLibraryRevertReplay(): Promise<SentinelVerdict> {
  const w = KELP_DEMO_OFT;

  // 1. Seed a healthy baseline (both libraries pinned).
  putSnapshot(makeSnapshot(w.address, w.chainId, 2));

  // 2. Feed a snapshot where receive library reverted to default — CRITICAL.
  const drifted = makeSnapshotLibRevert(w.address, w.chainId);
  const verdict = await runCheck(w, drifted);
  if (!verdict) throw new Error("Library revert replay did not trigger drift — check baseline seeding");
  return verdict;
}

// ── Demo: RPC source-conflict replay ───────────────────────────────────────
// Demonstrates multi-RPC source diversity: proves the Sentinel cannot be blinded
// by a single compromised RPC. Seeds a healthy 2-of-2 baseline, then injects a
// snapshot where a secondary RPC disagreed on the DVN config — the SOURCE_CONFLICT
// finding escalates to CRITICAL and lands a real attestation on Mantle Sepolia.

function makeSnapshotRpcConflict(oft: string, chainId: number): OftSnapshot {
  const base = makeSnapshot(oft, chainId, 2);
  base.routes = base.routes.map((r) => ({ ...r, rpcConflict: true }));
  return base;
}

export async function runRpcConflictReplay(): Promise<SentinelVerdict> {
  const w = KELP_DEMO_OFT;

  // 1. Seed a healthy baseline (no RPC conflict).
  putSnapshot(makeSnapshot(w.address, w.chainId, 2));

  // 2. Feed a snapshot flagged with an RPC conflict — CRITICAL SOURCE_CONFLICT verdict.
  const drifted = makeSnapshotRpcConflict(w.address, w.chainId);
  const verdict = await runCheck(w, drifted);
  if (!verdict) throw new Error("RPC conflict replay did not trigger drift — check baseline seeding");
  return verdict;
}
