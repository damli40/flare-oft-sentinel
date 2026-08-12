import type { OftSnapshot, WatchedOft, SentinelVerdict, Finding, RiskLevel, TransactionIntent, PolicyDecisionRecord } from "../types.js";
import { detectDrift, assessSnapshot, RULES_VERSION } from "./drift.js";
import { verdictHash, attest, attestInScope } from "./attestor.js";
import { dispatchAlert } from "./alerts.js";
import { getSnapshot, putSnapshot, recordVerdict, getWeakAlertFingerprint, getWeakAlertFiredAt, getWeakAlertCorridors, putWeakAlertFingerprint } from "./snapshot-store.js";
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

// How much a reading is worth as EVIDENCE. drift.ts sets this per finding: a check
// answered from the enforcement boundary itself is "observed"; one answered by
// reasoning from the near side because the far side would not read is "inferred".
const EVIDENCE_RANK: Record<Finding["evidence"], number> = {
  observed: 2,
  inferred: 1,
  unverifiable: 0,
};

const strongest = (fs: Finding[]) => Math.max(...fs.map((f) => EVIDENCE_RANK[f.evidence]));

// Severity ordering, worst first. Used for ONE thing: making sure the evidence
// rule below can never hide an escalation.
const SEVERITY_RANK: Record<Finding["severity"], number> = {
  CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, UNKNOWN: 1, PASS: 0,
};
const worst = (fs: Finding[]) => Math.max(...fs.map((f) => SEVERITY_RANK[f.severity]));

/**
 * Per check, keep the reading taken with the STRONGEST evidence. Ties go to the
 * current cycle, because a fresh reading of equal quality is the better one.
 *
 * THIS IS THE FIX FOR THE RE-SIGN FLAPPING, and it is deliberately here rather
 * than in the fingerprint. When a destination's receive config will not read,
 * drift.ts does not go quiet — it falls back to the send side, marks the finding
 * `inferred`, and SAYS SO IN THE TEXT: the quorum note becomes "receive config
 * unreadable — send side used as a proxy", and the DVN names now resolve on the
 * source chain, so the names themselves differ. Same config, same severity,
 * different sentence.
 *
 * The corridor still counts as "readable" for the carry-forward above, because
 * that tests the SEND-side uln and the send side read fine. So the degraded
 * reading replaced the good one, the hash moved, and the asset re-signed. DINERO
 * collected seven records in two days that way, every one an identical
 * 10/CRITICAL, two of them three minutes apart, and `total()` reached 18.
 *
 * Refusing the downgrade fixes it at the source and costs nothing elsewhere: an
 * observed→observed change still moves the hash, so a receive-side DVN swap, a
 * delivery state turning from "unused" to "stranded", or a proxy-admin transfer
 * between two EOAs are all still caught in full detail.
 *
 * The one thing it cannot do is notice a change on a corridor whose far side has
 * NEVER read. That is honest rather than unfortunate: this system attests to what
 * it can see, and it has never been able to see that corridor.
 */
function bestEvidencePerCheck(current: Finding[], carried: Finding[]): Finding[] {
  const byCheck = (fs: Finding[]) => {
    const m = new Map<string, Finding[]>();
    for (const f of fs) {
      const bucket = m.get(f.check);
      bucket ? bucket.push(f) : m.set(f.check, [f]);
    }
    return m;
  };
  const before = byCheck(carried);
  const out: Finding[] = [];
  // Only checks the CURRENT reading still produces survive. A check that stopped
  // firing on a readable corridor genuinely stopped, and that is a change worth
  // recording — this must not become a ratchet that never lets a finding clear.
  for (const [check, now] of byCheck(current)) {
    const prior = before.get(check);
    // Keep the prior reading only when it is BOTH better evidenced AND not less
    // severe than what we just read.
    //
    // The severity half is not defensive padding, it closes a hole the evidence
    // rule opens on its own: a cycle where the far side degrades AND the check
    // escalates arrives as `inferred CRITICAL` against a stored `observed
    // MEDIUM`. On evidence alone the MEDIUM wins and the escalation is silently
    // dropped — the exact failure this whole mechanism exists to prevent. A worse
    // reading is always worth surfacing, however weakly it is evidenced; a milder
    // one on weaker evidence is the flap, and gets refused.
    const keepPrior = prior && strongest(prior) > strongest(now) && worst(now) <= worst(prior);
    out.push(...(keepPrior ? prior : now));
  }
  return out;
}

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
    const carried = last?.[c] ?? [];
    if (readable.has(c)) {
      merged[c] = bestEvidencePerCheck(current[c] ?? [], carried);
      continue;
    }
    // Corridor not readable at all this cycle: carry the last-known findings and
    // union anything the partial read still produced. Deduped by CHECK rather
    // than by full text, or the same check worded differently on a degraded read
    // gets appended alongside its own earlier wording and the stored state grows
    // on every flake.
    const seen = new Set(carried.map((f) => f.check));
    merged[c] = [...carried, ...(current[c] ?? []).filter((f) => !seen.has(f.check))];
  }
  return merged;
}

/**
 * Canonical hash of the merged per-corridor state: corridors and findings sorted,
 * hashed IN FULL — check, severity and detail text.
 *
 * ⚠️ Do not "fix" the flapping by dropping `detail` from this hash. That was tried
 * on 2026-08-12 and reverted the same day, because it opens a hole on the exact
 * threat this project exists to catch:
 *
 *   detectDrift (drift.ts) compares the SEND-side uln, the two library-default
 *   booleans and rpcConflict. It never reads receiveUln, and it never compares
 *   peers. So a receive-side DVN swap at an UNCHANGED COUNT — [A,B] -> [A,EVIL],
 *   an owner-key attacker substituting their own verifier at the enforcement
 *   boundary — produces no drift at all. Its only signature anywhere in the
 *   system is the DVN names inside this finding's detail text. Hash check and
 *   severity alone and that attack is silent forever.
 *
 *   Same shape for two more: the delivery state moving from "no funds exposed
 *   yet" to "value is observably stranded" keeps its severity and changes only
 *   the note, and a proxy-admin transfer between two EOAs lives only in the
 *   owner fragment of the detail string.
 *
 * The flapping is real and is fixed in mergeWeakFindings instead, by refusing to
 * let a DEGRADED reading overwrite a good one. That kills the noise without
 * blinding the hash. See the evidence note there.
 */
export function weakCorridorsFingerprint(corridors: WeakAlertCorridors): string {
  const canonical = Object.keys(corridors)
    .sort()
    .map((c) => ({ corridor: c, findings: sortFindings(corridors[c]) }));
  return verdictHash({ kind: "weak-config-v3", corridors: canonical, rulesVersion: RULES_VERSION });
}

// How long an UNCHANGED finding stays quiet before it is worth saying again.
// A risk level absent from this map never re-pings, which is why PASS is not
// here: there is nothing to be reminded of. PASS still reaches this producer
// and still gets its one attestation — this map governs the REPEAT, not the
// first write, and the two are different questions.
//
// Env-overridable in minutes so an operator can tune the cadence without a
// deploy, and so tests do not have to wait twelve hours.
//
// Read at CALL time, not at module load. Every other env read in this instance
// moved to call-time for the same reason: a value captured at import cannot be
// changed by the operator route that exists to change it, so pairing a cadence
// change with a reset needed a redeploy.
const REPEAT_DEFAULT_MINUTES: Record<string, number> = {
  CRITICAL: 12 * 60,
  AT_RISK: 7 * 24 * 60,
};

/** Minutes for a level, from env when the operator set something usable.
 *  Returns null to mean "this level never re-pings".
 *
 *  Three cases, and the difference between the last two is the whole point:
 *
 *   unset or ""   → the default. Silent, because that is not a decision.
 *   0 or negative → OFF. An explicit, honoured mute.
 *   unparseable   → the default, WITH a warning. A typo is not a decision either.
 *
 *  The bug being fixed: Number("12h") is NaN, NaN * 60_000 is NaN, and the old
 *  `!every` guard treated NaN as falsy — so `REPING_CRITICAL_MINUTES=12h`
 *  silently disabled re-pings entirely and logged nothing. Silence is the worst
 *  possible response to a cadence the operator was actively trying to set.
 *
 *  Why 0 still means off, rather than falling back to the default like the typo
 *  case: under the old code 0, negative and NaN ALL disabled re-pings, so an
 *  operator may have set 0 as a mute and it worked. Treating it as "unusable"
 *  would silently un-mute them on the next deploy — trading one silent surprise
 *  for another. A typo cannot be honoured because there is no sane reading of it;
 *  a zero can be, so it is. (The documented kill switch is still ALERTS_DISABLED,
 *  which mutes everything rather than one band.) */
function repeatAfterMs(riskLevel: string): number | null {
  const fallback = REPEAT_DEFAULT_MINUTES[riskLevel];
  if (fallback === undefined) return null; // no cadence for this level (e.g. PASS)
  const envKey = riskLevel === "CRITICAL" ? "REPING_CRITICAL_MINUTES" : "REPING_AT_RISK_MINUTES";
  const raw = process.env[envKey];
  if (raw === undefined || raw.trim() === "") return fallback * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) {
    console.warn(
      `[orchestrator] ${envKey}="${raw}" is not a number of minutes — ignoring it and using the ` +
        `${fallback}-minute default. Set a plain integer (e.g. ${fallback}), or 0 to stop ` +
        `${riskLevel} re-pings entirely.`,
    );
    return fallback * 60_000;
  }
  if (minutes <= 0) {
    console.warn(`[orchestrator] ${envKey}="${raw}" — ${riskLevel} re-pings are OFF.`);
    return null;
  }
  return minutes * 60_000;
}

/** Is an unchanged finding at this risk level due to be said again? */
export function dueForRepeat(riskLevel: string, firedAt: number | null, now = Date.now()): boolean {
  const every = repeatAfterMs(riskLevel);
  // No cadence for this level, or no record of ever having fired, means the
  // repeat path is not the one that should handle it.
  if (every == null || firedAt == null) return false;
  return now - firedAt >= every;
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

  // Three outcomes, not two. The fingerprint answers "did the findings change";
  // it never answered "how long has someone been ignoring this".
  //
  //   changed          → alert AND attest. A new verdict deserves a new record.
  //   unchanged, due   → alert only. A re-ping is a reminder that nobody acted,
  //                      not a new finding, and re-signing an identical verdict
  //                      every cycle would fill the registry with duplicates
  //                      that say nothing and cost gas to say it.
  //   unchanged, quiet → return, as before.
  // Compare the STORED HASH STRING, not a re-hash of the stored state.
  //
  // Re-hashing the old state under today's scheme was tried on 2026-08-12, to skip
  // the one-off re-sign that the v2 -> v3 rename forces. It was reverted within the
  // hour: computing both sides in the same process cancels `kind` AND
  // `rulesVersion` out by construction, which silently destroys the only mechanism
  // that refreshes a stale score in the registry after a rules release. Precedent
  // is rules 5.0.0 itself — identical findings, different scores. Under the re-hash
  // every asset would have kept its 4.1.0 score on-chain forever, because the
  // findings never moved.
  //
  // So the version string is load-bearing and the compare stays a string compare.
  // The cost is one re-sign per asset on the deploy that changes the scheme, which
  // is correct rather than wasteful: the definition of "changed" changed, so every
  // asset re-baselines once and the new record is the first one written under the
  // new rules.
  const stored = getWeakAlertFingerprint(watched.address, watched.chainId);
  const unchanged = stored === fingerprint;
  const firedAt = getWeakAlertFiredAt(watched.address, watched.chainId);
  const isRepeat = unchanged && dueForRepeat(riskLevel, firedAt);
  if (unchanged && !isRepeat) return;

  const reasons = findings.filter(f => f.severity !== "PASS").map(f => f.detail);
  const pdr = await buildPdr(snapshot.oft, watched.chainId, findings, score, riskLevel, Date.now());
  const hash = verdictHash(pdr);

  const verdict: SentinelVerdict = {
    oft: snapshot.oft,
    chainId: watched.chainId,
    ticker: watched.ticker,
    score,
    riskLevel,
    // Hardcoding CRITICAL here was safe only while CRITICAL was the sole band
    // that reached this producer. It has not been since AT_RISK was let in, and
    // PASS makes it plainly false: this string is the feed's `detail` whenever a
    // verdict carries no findings to show instead, so a 100/100 asset would have
    // announced itself on the judge-facing page as a persistent CRITICAL config.
    // Say the band that was actually assessed.
    verdict:
      riskLevel === "PASS"
        ? `Config read clean, no drift (score ${score}/100)`
        : `Persistent ${riskLevel} config — pre-existing risk, no drift (score ${score}/100)`,
    reasons,
    verdictHash: hash,
    verdictPath: "weak-config",
    capturedAt: snapshot.capturedAt,
    tis,
    pdr,
  };

  if (isRepeat) {
    console.log(`[sentinel] weak-config re-ping ${watched.ticker} ${riskLevel} — findings unchanged, alert only, no attestation`);
  } else if (!attestInScope(snapshot.oft, watched.chainId)) {
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
    verdict.alertTxHash = await dispatchAlert(verdict, snapshot.owner ?? null, { isRepeat });
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
