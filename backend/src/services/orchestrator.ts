import type { OftSnapshot, WatchedOft, SentinelVerdict, Finding, RiskLevel, TransactionIntent, PolicyDecisionRecord } from "../types.js";
import { detectDrift, assessSnapshot, RULES_VERSION } from "./drift.js";
import { verdictHash, attest, attestInScope } from "./attestor.js";
import { dispatchAlert } from "./alerts.js";
import { getSnapshot, putSnapshot, recordVerdict, getWeakAlertFingerprint, getWeakAlertCorridors, putWeakAlertFingerprint } from "./snapshot-store.js";
import { loadDvnMeta, dvnMetaHash } from "./lz-config.js";

/** Async because the PDR now pins the DVN table that decided the findings. loadDvnMeta()
 *  is cached in-memory for 24h, so this is a map lookup on every call after the first. */
async function buildPdr(
  oft: string,
  chainId: number,
  findings: Finding[],
  score: number,
  riskLevel: RiskLevel,
  evaluatedAt: number,
): Promise<PolicyDecisionRecord> {
  const meta = await loadDvnMeta();
  return {
    oft, chainId, findings, score, riskLevel, evaluatedAt,
    agentId: Number(process.env.SENTINEL_AGENT_ID ?? 1),
    rulesVersion: RULES_VERSION,
    dvnMetaHash: dvnMetaHash(meta),
    dvnMetaFetchedAt: meta.fetchedAt,
  };
}

// Identity of a weak-config alert: the findings that would be disclosed, not the
// moment they were computed. The full verdictHash can't dedupe here — the PDR pins
// evaluatedAt, so every cycle would look "new".
//
// Two dedup-defeating instabilities, both born of concurrent RPC reads:
//  1. ORDER (fixed 2026-07-15): set-equal findings arrive reordered between polls —
//     hash a sorted copy.
//  2. SET (observed live 2026-07-17): per-corridor/per-field reads fail
//     intermittently, so a corridor's findings vanish when its reads flake and
//     reappear next cycle. Every partial read looked like a material change and
//     re-fired attest (gas) + Telegram hourly. Fix: per-corridor state — a corridor
//     that was NOT readable this cycle carries forward its last-known findings
//     before hashing, so a failed read is never mistaken for a config change.
//     Identity excludes score/risk: both derive from the (possibly partial)
//     finding set and would reintroduce the flicker.
export type WeakAlertCorridors = Record<string, Finding[]>;

const GLOBAL_CORRIDOR = "global";

/** Corridor a finding belongs to: route findings carry a "<chainName>: " detail
 *  prefix by engine convention; everything else (owner/custody/proxy) is global. */
function findingCorridor(finding: Finding, corridorNames: Set<string>): string {
  const sep = finding.detail.indexOf(": ");
  if (sep > 0) {
    const prefix = finding.detail.slice(0, sep);
    if (corridorNames.has(prefix)) return prefix;
  }
  return GLOBAL_CORRIDOR;
}

const findingKey = (f: Finding) => `${f.check}\u0000${f.severity}\u0000${f.detail}`;
const sortFindings = (fs: Finding[]) =>
  [...fs].sort((a, b) => (findingKey(a) < findingKey(b) ? -1 : findingKey(a) > findingKey(b) ? 1 : 0));

/**
 * Merge this cycle's findings over the last-fired per-corridor state.
 *  - readable corridor (route present, active, ULN read succeeded): current findings
 *    replace last-known, so a genuinely cleaned corridor goes quiet;
 *  - unreadable/absent corridor: last-known findings carry forward, unioned with any
 *    findings the partial read still produced (a library read can succeed while the
 *    ULN read fails; never drop a live finding);
 *  - the global corridor is readable iff the owner reads succeeded this cycle.
 *    (Proxy-admin reads can flake independently; owner is the dominant global signal.)
 */
export function mergeWeakFindings(
  findings: Finding[],
  snapshot: OftSnapshot,
  last: WeakAlertCorridors | null,
): WeakAlertCorridors {
  const corridorNames = new Set(snapshot.routes.map((r) => r.chainName));
  const readable = new Set(
    snapshot.routes.filter((r) => r.isActive && r.uln !== null).map((r) => r.chainName),
  );
  if (snapshot.owner !== null && snapshot.ownerIsContract !== null) readable.add(GLOBAL_CORRIDOR);

  const current: WeakAlertCorridors = {};
  for (const f of findings) {
    const c = findingCorridor(f, corridorNames);
    (current[c] ??= []).push(f);
  }

  const merged: WeakAlertCorridors = {};
  for (const c of new Set([...Object.keys(last ?? {}), ...Object.keys(current), ...readable])) {
    if (readable.has(c)) {
      merged[c] = current[c] ?? [];
      continue;
    }
    const carried = last?.[c] ?? [];
    const fresh = (current[c] ?? []).filter((f) => !carried.some((k) => findingKey(k) === findingKey(f)));
    merged[c] = [...carried, ...fresh];
  }
  return merged;
}

/** Canonical hash of the merged per-corridor state: corridors and findings sorted. */
export function weakCorridorsFingerprint(corridors: WeakAlertCorridors): string {
  const canonical = Object.keys(corridors)
    .sort()
    .map((c) => ({ corridor: c, findings: sortFindings(corridors[c]) }));
  return verdictHash({ kind: "weak-config-v2", corridors: canonical, rulesVersion: RULES_VERSION });
}

/**
 * Full alert pipeline for a persistently CRITICAL config that hasn't drifted:
 * attests to AuditRegistry, fires AlertBus (with OFT address + tx links in Telegram),
 * then stores the fingerprint (persisted, keyed chainId:address) so neither later
 * cycles nor a backend restart re-fires it while the findings are unchanged.
 */
export async function produceWeakConfigAttestation(
  watched: WatchedOft,
  snapshot: OftSnapshot,
  findings: Finding[],
  score: number,
  riskLevel: RiskLevel,
  tis: TransactionIntent[],
): Promise<void> {
  const merged = mergeWeakFindings(findings, snapshot, getWeakAlertCorridors(watched.address, watched.chainId));
  const fingerprint = weakCorridorsFingerprint(merged);
  if (getWeakAlertFingerprint(watched.address, watched.chainId) === fingerprint) return;

  const reasons = findings.filter(f => f.severity !== "PASS").map(f => f.detail);
  const pdr = await buildPdr(snapshot.oft, watched.chainId, findings, score, riskLevel, Date.now());
  const hash = verdictHash(pdr);

  const verdict: SentinelVerdict = {
    oft: snapshot.oft,
    chainId: watched.chainId,
    ticker: watched.ticker,
    score,
    riskLevel,
    verdict: `Persistent CRITICAL config — pre-existing risk, no drift (score ${score}/100)`,
    reasons,
    verdictHash: hash,
    verdictPath: "weak-config",
    capturedAt: snapshot.capturedAt,
    tis,
    pdr,
  };

  if (!attestInScope(snapshot.oft, watched.chainId)) {
    console.log(`[sentinel] ATTEST_SCOPE=${process.env.ATTEST_SCOPE} — not in ATTEST_PINNED, attestation skipped for ${watched.ticker} (${snapshot.oft})`);
  } else {
    try {
      const { txHash, attestationId } = await attest(snapshot.oft, watched.chainId, hash, score, riskLevel);
      verdict.attestTxHash = txHash;
      verdict.attestationId = attestationId;
      console.log(`[sentinel] weak-config attest ${watched.ticker} score=${score} (id ${attestationId}) — ${txHash}`);
    } catch (e: any) {
      console.error(`[sentinel] weak-config attest failed for ${watched.ticker}:`, e.shortMessage ?? e.message);
    }
  }

  try {
    verdict.alertTxHash = await dispatchAlert(verdict, snapshot.owner ?? null);
  } catch (e: any) {
    console.error(`[sentinel] weak-config alert failed for ${watched.ticker}:`, e.shortMessage ?? e.message);
  }
  recordVerdict(verdict);
  putWeakAlertFingerprint(watched.address, watched.chainId, fingerprint, merged);
}

function synthVerdict(reasons: string[], score: number, riskLevel: string): string {
  if (reasons.length === 0) return `Config assessed ${riskLevel} (score ${score}/100).`;
  return `Config drifted into ${riskLevel} (score ${score}/100): ${reasons[0]}.`;
}

/**
 * The deep-audit pipeline for a single snapshot: deterministic assessment →
 * on-chain attestation → tiered alert → persisted verdict. Score and risk are
 * derived from the snapshot (no LLM in the critical path), so the verdict that
 * gets attested is exactly the config that triggered it.
 */
export async function produceVerdict(
  watched: WatchedOft,
  snapshot: OftSnapshot,
  driftReasons: string[]
): Promise<SentinelVerdict> {
  const { score, riskLevel, findings, tis } = await assessSnapshot(snapshot, watched.ticker);
  const reasons = driftReasons.length ? driftReasons : findings.map((f) => `${f.check}: ${f.detail}`);

  const pdr = await buildPdr(snapshot.oft, watched.chainId, findings, score, riskLevel, Date.now());
  const hash = verdictHash(pdr);

  const verdict: SentinelVerdict = {
    oft: snapshot.oft,
    chainId: watched.chainId,
    ticker: watched.ticker,
    score,
    riskLevel,
    verdict: synthVerdict(reasons, score, riskLevel),
    reasons,
    verdictHash: hash,
    verdictPath: "drift",
    capturedAt: snapshot.capturedAt,
    tis,
    pdr,
  };

  if (!attestInScope(snapshot.oft, watched.chainId)) {
    console.log(`[sentinel] ATTEST_SCOPE=${process.env.ATTEST_SCOPE} — not in ATTEST_PINNED, attestation skipped for ${watched.ticker} (${snapshot.oft})`);
  } else {
    try {
      const { txHash, attestationId } = await attest(snapshot.oft, watched.chainId, hash, score, riskLevel);
      verdict.attestTxHash = txHash;
      verdict.attestationId = attestationId;
      console.log(`[sentinel] attested ${watched.ticker} ${riskLevel} (id ${attestationId}) — ${txHash}`);
    } catch (e: any) {
      console.error(`[sentinel] attest failed for ${watched.ticker}:`, e.shortMessage ?? e.message);
    }
  }

  try {
    verdict.alertTxHash = await dispatchAlert(verdict, snapshot.owner);
  } catch (e: any) {
    console.error(`[sentinel] alert failed for ${watched.ticker}:`, e.shortMessage ?? e.message);
  }
  recordVerdict(verdict);
  return verdict;
}

/**
 * One Sentinel check step against an observed snapshot (live OR injected).
 * Compares to the stored baseline; on drift, runs the deep-audit pipeline and
 * advances the baseline. First sighting just stores the baseline.
 */
export async function runCheck(
  watched: WatchedOft,
  observed: OftSnapshot
): Promise<SentinelVerdict | null> {
  const baseline = getSnapshot(observed.oft, observed.chainId);

  if (!baseline) {
    putSnapshot(observed);
    console.log(`[sentinel] baseline captured for ${watched.ticker} (${observed.oft})`);
    return null;
  }

  const drift = await detectDrift(baseline, observed);
  if (!drift.drifted) {
    putSnapshot(observed); // advance timestamp; config unchanged in security-relevant ways
    return null;
  }

  console.log(`[sentinel] DRIFT on ${watched.ticker}: ${drift.reasons.join("; ")}`);
  const verdict = await produceVerdict(watched, observed, drift.reasons);
  putSnapshot(observed); // new state becomes the baseline so we don't re-fire every poll
  return verdict;
}
