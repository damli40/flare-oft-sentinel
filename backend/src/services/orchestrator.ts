import type { OftSnapshot, RouteSnapshot, WatchedOft, SentinelVerdict, Finding, RiskLevel, TransactionIntent, PolicyDecisionRecord } from "../types.js";
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
// evaluatedAt, so every cycle would look "new". Every time this identity moves, the
// asset buys a PAID mainnet attestation, so a false move is a real bill.
//
// Four dedup-defeating instabilities, all born of concurrent RPC reads:
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
//  3. HALF-READ (observed live 2026-08-11, rule rewritten 2026-08-12): (2) asked
//     only whether the NEAR side read. Half of what the engine says about a corridor
//     is read on the DESTINATION chain, and when that half fails the engine does not
//     go quiet — it re-words the finding from the send side, and five checks stop
//     firing altogether because they need a far-side read to exist. Both look like a
//     config change to a hash over full detail. One asset took seven records in two
//     days that way, every one an identical 10/CRITICAL. Fix: mergeWeakFindings now
//     asks BOTH sides (see there).
//  4. SENTINELS AND THE REST OF THE FAR SIDE (proved by adversarial probe against (3),
//     and present in every version before it too — these are holes (3) did not close,
//     not damage it did):
//       · a read-failure finding — severity UNKNOWN, meaning "we could not evaluate" —
//         was admitted into the identity, so a flake alone moved the hash and moved it
//         back. Fix: withoutUnknown, below.
//       · (3) took `receiveUln` as the whole far side. It is not: the reverse peer and
//         the delivered nonce are separately failable destination reads, and losing
//         either re-words or DELETES a finding while the corridor still looks read.
//         Fix: farSideAnswered, below, scoped per check.
//     Two further reads are still unwitnessed and are accepted, not fixed — see
//     "WHAT THE WITNESS COVERS, AND WHAT IT DOES NOT" on mergeWeakFindings.
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

// Severity ordering, worst first. Used for ONE thing: the escalation escape hatch
// in mergeWeakFindings, so carrying a corridor forward can never hide a worse reading.
const SEVERITY_RANK: Record<Finding["severity"], number> = {
  CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, UNKNOWN: 1, PASS: 0,
};
/** Rank of the worst finding in a set. -1 for an empty set — below PASS, so an empty
 *  set never out-ranks anything. In practice it is only ever called on a non-empty
 *  per-check bucket; "a check we had nothing for at all" is handled separately, by
 *  admitting it outright. */
const worst = (fs: Finding[]) => fs.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity]), -1);

/**
 * Drop the read-failure sentinels.
 *
 * UNKNOWN does not mean "nothing wrong". It means "we could not evaluate this" — the
 * one thing that must never be attested as a change. drift.ts emits it from two places
 * today and neither is a security reading:
 *
 *   ULN Unreadable        (drift.ts:547-552) — the near-side ULN read failed.
 *   Proxy Upgrade Control (drift.ts:1100-1105) — the proxy admin's bytecode read failed.
 *
 * Both are deliberately unscored there (they deduct nothing, drift.ts:544-546), and both
 * were nonetheless landing in the paid identity: the union's not-carried branch admits
 * any check nothing is carried under, so a clean corridor went [] → ["ULN Unreadable"]
 * on a flake and back to [] on recovery. Two mainnet writes per flake episode, bought
 * with an RPC hiccup that told us nothing.
 *
 * Filtered by SEVERITY CLASS, never by check name — there are already two sentinels and
 * a third costs one line in drift.ts. Nothing else is filtered: PASS means "evaluated,
 * and it is fine", which is a real reading and belongs in the record.
 */
const withoutUnknown = (fs: Finding[]) => fs.filter((f) => f.severity !== "UNKNOWN");

/**
 * The four checks whose detail text ENDS in blockClaim's delivery note
 * (drift.ts:232-277). Every one of them re-words — at an unchanged check and an
 * unchanged severity — the moment `delivered` goes null, because deliveryState()
 * collapses to UNKNOWN on exactly that (drift.ts:206).
 */
const DELIVERY_NOTED_CHECKS = new Set([
  "Half-Wired Corridor",         // drift.ts:602
  "Dead Receive DVN",            // drift.ts:648
  "Undeliverable Route",         // drift.ts:858
  "Block Confirmation Mismatch", // drift.ts:982
]);

/** The one check gated on the destination's reverse-peer read (drift.ts:601). */
const PEER_GATED_CHECK = "Half-Wired Corridor";

/**
 * Did the destination answer everything this corridor's findings actually depend on?
 *
 * `receiveUln` is the baseline witness and is required always. The other two are
 * demanded only when a check that MOVES WITH THEM is in play, because both are read
 * per-corridor and a blanket requirement would make far too many corridors
 * untrustworthy — and every untrustworthy cycle is a cycle in which a real fix cannot
 * be recorded.
 *
 * @param checksInPlay the `check` names carried for this corridor plus those in the
 *        current reading. Carried matters as much as current: the bug is a finding
 *        that DISAPPEARS from the current reading when its gating read fails.
 */
function farSideAnswered(route: RouteSnapshot, checksInPlay: Set<string>): boolean {
  // The receive ULN, read on the destination chain (lz-config.ts:1402).
  if (route.receiveUln === null) return false;

  // The delivered nonce is NOT part of the destination batch: it is a bare, un-retried
  // rawCall (lz-config.ts:1277-1286) whose own gating outbound leg is read on the
  // SOURCE client (lz-config.ts:1270). So it fails independently of receiveUln, and
  // when it does, all four block-claim checks re-word at an identical severity.
  if ((route.delivery?.delivered ?? null) === null &&
      [...checksInPlay].some((c) => DELIVERY_NOTED_CHECKS.has(c))) return false;

  // The reverse peer IS in the destination batch, but as its own sub-call: multicall3
  // runs allowFailure:true (multicall.ts:137) and the per-call fallback catches to null
  // (lz-config.ts:1007-1009). When it nulls, drift.ts:601 stops emitting Half-Wired
  // Corridor and drift.ts:618's `continue` stops suppressing the corridor's other
  // checks — so a real HIGH silently leaves a paid attestation.
  if ((route.peerSymmetric ?? null) === null && checksInPlay.has(PEER_GATED_CHECK)) return false;

  return true;
}

/**
 * Merge this cycle's findings over the last-fired per-corridor state.
 *
 * ── The rule ──────────────────────────────────────────────────────────────────
 * A corridor's reading is TRUSTWORTHY this cycle only if BOTH sides answered:
 *
 *     nearOk(route) = route.isActive && route.uln !== null   // send side, source chain
 *     farOk(route)  = route.receiveUln !== null                     // always required
 *                  && route.delivery.delivered !== null             // IF a block-claim
 *                                                                   //    check is in play
 *                  && route.peerSymmetric !== null                  // IF Half-Wired
 *                                                                   //    Corridor is in play
 *
 * "In play" means the check appears in the CARRIED state or in the CURRENT reading.
 * Carried matters as much as current, because the failure mode is a finding that
 * VANISHES from the current reading when its gating read fails. The two conditional
 * legs are deliberately conditional: see farSideAnswered() for what each read is and
 * why demanding it everywhere would be worse than not demanding it at all.
 *
 * UNKNOWN-severity findings are dropped before any of this (see withoutUnknown).
 *
 *   both sides read → replace with the current findings. A finding that clears has
 *                     genuinely cleared, and a custody declaration or a proxy-admin
 *                     transfer is recorded on the very next cycle.
 *   otherwise       → carry the last-known findings forward, unioned with any fresh
 *                     finding whose `check` is not already carried (dedupe by check,
 *                     never by full text), plus the escape hatch below for anything
 *                     that ESCALATED while we could not see straight.
 *
 * The global corridor (owner / custody / proxy findings) has no far side, so it keeps
 * its own test: the owner reads succeeded. A destination-chain outage must not freeze
 * the custody record. (Proxy-admin reads can flake independently; owner is the
 * dominant global signal.)
 *
 * ── Why the SNAPSHOT and not the finding's `evidence` label ───────────────────
 * The previous attempt (2026-08-12, replaced same day) kept, per check, whichever
 * reading carried the stronger `evidence` tag. It looked right and was wrong three
 * separate ways, all confirmed by executed probes:
 *
 *  1. It did not fix the headline case. drift.ts:711-716 deliberately keeps the
 *     send-side fallback `observed` when the sender pays ≤1 DVN — "receive config
 *     unreadable, but the sender pays only this one DVN — no larger quorum can
 *     exist" is a proof, not a proxy. So on the 1-of-1 single-verifier asset this
 *     product headlines, BOTH readings are `observed`: evidence ties, the current
 *     one wins, the sentence differs, the hash moves. Two paid writes per flake.
 *  2. Five checks do not degrade, they VANISH, because they cannot fire without a
 *     far-side read: Block Confirmation Mismatch (drift.ts:981), Dead Receive DVN
 *     (drift.ts:646), Undeliverable Route and Non-Blocking DVN Mismatch
 *     (drift.ts:835), Half-Wired Corridor (drift.ts:601). A rule that only walks
 *     the checks present in the CURRENT reading drops every one of them.
 *  3. It refused legitimate DOWNGRADES forever. A team files a Fireblocks custody
 *     declaration and Owner Type becomes `unverifiable` LOW (capped by
 *     drift.ts:124-139) — strictly weaker evidence than the stored `observed` HIGH,
 *     so the record never corrected. Same for a real EOA→timelock proxy transfer.
 *     Refusing to record a fix is worse than the flapping it was meant to stop.
 *
 * The snapshot states read quality structurally. The label does not. So ask the
 * snapshot.
 *
 * ── ESCALATION ESCAPE HATCH ───────────────────────────────────────────────────
 * A degraded cycle may only ADD or ESCALATE a check, never soften, re-word or clear
 * one. So a fresh finding is admitted when its check is not carried at all, OR when
 * it is strictly MORE severe than everything carried under that check. A bad read
 * must never hide an escalation.
 *
 * The comparison is PER CHECK, not per corridor, and that granularity is load-bearing.
 * A corridor-level test ("does this cycle contain anything worse than the corridor's
 * current worst?") goes blind exactly where it matters most: an unpinned receive
 * library already puts most corridors at CRITICAL (drift.ts:942-947), so a corridor
 * losing a DVN mid-outage — DVN Count MEDIUM → the CRITICAL 1-of-1 single-verifier shape, the
 * headline finding of this product — would not raise the corridor's maximum and would
 * be silently swallowed. A corridor-level hatch also had to REPLACE the whole corridor
 * to work, which drops carried findings that this cycle simply could not see and
 * breaks the older "a partial read must never drop a live finding" guarantee (there is
 * a test on that, and it is what caught it).
 *
 * This is keyed on severity alone, never on evidence. It has a LIVE path today:
 * Deprecated DVN (drift.ts:767-774) is read entirely on the send side and ships
 * `observed` CRITICAL, so it can appear mid-outage and outrank a carried MEDIUM.
 * What is NOT reachable today is an `inferred` CRITICAL — capByEvidence
 * (drift.ts:124-139) caps every inferred finding at MEDIUM, so that particular
 * shape cannot arrive from this engine. (The previous version's comment claimed it
 * could and used it to justify the severity clause; that claim was false. The hatch
 * is worth keeping anyway as a guard against a future rules change lifting the cap,
 * which is a different and weaker justification than the one it used to carry.)
 *
 * ── KNOWN, ACCEPTED COSTS ─────────────────────────────────────────────────────
 *  • THE RATCHET. A corridor whose far side NEVER reads keeps its last-known findings,
 *    so a finding there can never clear. That is honest for an attestation system — we
 *    cannot confirm what we cannot see — and it is strictly better than paying for
 *    a mainnet write on every flake. But it is NOT only a per-outage cost, and calling
 *    it one would be wrong: chain-registry.json ships four chains with ZERO RPCs —
 *    `arc`, `ault`, `concrete` and `plume`. lz-config.ts:1329 skips the whole
 *    destination batch when a chain has no RPC, so for corridors INTO those four,
 *    receiveUln, peerSymmetric and delivered are ALL permanently null. Those corridors
 *    are far-dark forever, not intermittently, and any finding recorded on one is
 *    frozen for good.
 *    The only escape is clearWeakAlerts() (snapshot-store.ts:119), reachable solely via
 *    the admin route POST /api/sentinel/reset-weak-alerts (routes/sentinel.ts:862). It
 *    drops EVERY asset's record, so every asset re-alerts and re-attests — a fleet-wide
 *    paid re-baseline to unstick one corridor. There is no per-asset form of it today.
 *  • A SEND-side DVN swap during a far-side outage stays suppressed: same `check`,
 *    no severity change, so neither the union nor the hatch admits it. The proper
 *    home for catching that is detectDrift's send-side comparison (drift.ts:395-415),
 *    which today catches a count drop, a confirmation drop and a newly-added
 *    DEPRECATED DVN — but not a same-count swap to an unrecognised address. Closing
 *    that gap is a drift.ts change, not a change here.
 *  • The union dedupes by CHECK, so a SECOND finding of a check already carried
 *    (two deprecated DVNs on one corridor) waits for a cycle that reads both sides.
 *    Deduping by full text instead would let the same check, worded differently on
 *    a degraded read, pile up next to its own earlier wording on every flake.
 *
 * ── WHAT THE WITNESS COVERS, AND WHAT IT DOES NOT ─────────────────────────────
 * A previous version of this note claimed the far-side reads "fail together, because
 * they fail with the destination RPC", and used that to justify testing `receiveUln`
 * alone. That claim is structurally false and an adversarial review proved it by
 * executed probe. Three of the reads it covered are separately failable, and one of
 * them is not even a destination read. So, precisely:
 *
 *   WITNESSED — a failure makes the corridor untrustworthy and the carried state stands:
 *     · route.uln            near side, source chain, via the retry+fallback chain.
 *     · route.receiveUln     destination batch (lz-config.ts:1402). Always required.
 *     · delivery.delivered   destination inboundNonce (lz-config.ts:1277-1286).
 *                            Required only when a block-claim check is in play.
 *     · route.peerSymmetric  destination reverse peer (lz-config.ts:1388).
 *                            Required only when Half-Wired Corridor is in play.
 *
 *   NOT WITNESSED — these can fail while the corridor still looks fully read, and the
 *   resulting move IS attested. Both are accepted here and neither is fixable in this
 *   function, because in both cases the snapshot field the engine keys on is simply
 *   absent and this rule has nothing to test:
 *
 *     · P3 — SENDABILITY. `sendability` is a SOURCE-side quoteSend walk
 *       (lz-config.ts:162-176), nothing to do with the destination. A transport failure
 *       returns UNKNOWN rather than UNSENDABLE, and UNKNOWN deliberately never caps
 *       (drift.ts:160-164), so the MEDIUM ceiling an UNSENDABLE corridor was sitting
 *       under is released. CONSEQUENCE: DVN Count flips MEDIUM → CRITICAL with no config
 *       change, on a corridor this rule calls trustworthy. It is an escalation, so the
 *       escape hatch admits it by design — a paid write plus a CRITICAL page, bought
 *       with a failed source-side probe. It flips back when the probe next succeeds:
 *       a second write. Closing it needs a "the probe failed" flag distinct from
 *       UNKNOWN, which is a lz-config.ts/drift.ts change.
 *     · P4 — PROXY ADMIN. `proxyAdmin` comes from a single-shot getStorageAt on the
 *       EIP-1967 admin slot (lz-config.ts:1423), on the GLOBAL corridor. If that one
 *       read fails, proxyAdmin stays null, drift.ts:1070 does not fire at all, and the
 *       global corridor's own witness — the OWNER read — is a DIFFERENT call that
 *       succeeded, so the corridor is trusted and replaced. CONSEQUENCE: a carried
 *       Proxy Upgrade Control HIGH silently leaves a paid attestation and returns on
 *       the next cycle. Two writes, and in between, a record that understates the
 *       upgrade risk. Closing it needs a per-field global witness.
 *
 *   (The receive-side LIBRARY is not on either list: `receiveLibIsDefault` is read on
 *   the SOURCE endpoint through the resilient retry+fallback path, lz-config.ts:1137
 *   and 1161-1162. The old note filed it as a destination read; it never was one.)
 *
 * Widening the witness to demand every field unconditionally was rejected: it makes a
 * corridor untrustworthy far more often, and every extra untrustworthy cycle is a cycle
 * in which a real fix cannot be recorded. Hence the two conditional legs, scoped to the
 * checks whose text actually moves with the read.
 */
export function mergeWeakFindings(
  findings: Finding[],
  snapshot: OftSnapshot,
  last: WeakAlertCorridors | null,
): WeakAlertCorridors {
  const corridorNames = new Set(snapshot.routes.map((r) => r.chainName));

  // Group first: the far-side witness below is per corridor and needs to know which
  // checks are in play there. UNKNOWN sentinels are dropped on the way in, so they
  // reach neither the identity nor the witness.
  const current: WeakAlertCorridors = {};
  for (const f of withoutUnknown(findings)) {
    const c = findingCorridor(f, corridorNames);
    (current[c] ??= []).push(f);
  }

  const trusted = new Set<string>();
  for (const route of snapshot.routes) {
    if (!route.isActive || route.uln === null) continue; // near side did not answer
    const checksInPlay = new Set<string>([
      ...withoutUnknown(last?.[route.chainName] ?? []).map((f) => f.check),
      ...(current[route.chainName] ?? []).map((f) => f.check),
    ]);
    if (farSideAnswered(route, checksInPlay)) trusted.add(route.chainName);
  }
  // The global corridor (owner / custody / proxy findings) has no far side, so its
  // witness is the owner read. See P4 above for what that misses.
  if (snapshot.owner !== null && snapshot.ownerIsContract !== null) trusted.add(GLOBAL_CORRIDOR);

  const merged: WeakAlertCorridors = {};
  for (const c of new Set([...Object.keys(last ?? {}), ...Object.keys(current), ...trusted])) {
    // Filtered on the way out too, so a sentinel stored by an earlier build leaves the
    // state on the first cycle after this ships rather than being carried forever.
    const carried = withoutUnknown(last?.[c] ?? []);
    const now = current[c] ?? [];
    if (trusted.has(c)) {
      merged[c] = [...now];
      continue;
    }

    // Half-read or absent corridor. The carried state stands, and this cycle may only
    // ADD or ESCALATE — never soften, re-word or clear, because we could not see the
    // far side. Three cases, keyed on CHECK:
    //
    //   check not carried at all   → admit it. A partial read still found something
    //                                (a library read can succeed while the ULN read
    //                                fails); never drop a live finding.
    //   strictly MORE severe than  → admit it, replacing that check's carried
    //     everything carried for      readings. THIS IS THE ESCAPE HATCH: an
    //     that check                  escalation is never hidden behind a bad read.
    //   anything else              → keep what is carried. This is the flap.
    //
    // Dedupe is by CHECK, never by full text: the same check worded differently on a
    // degraded read would otherwise pile up next to its own earlier wording on every
    // flake and grow the stored state without bound.
    const carriedByCheck = new Map<string, Finding[]>();
    for (const f of carried) {
      const bucket = carriedByCheck.get(f.check);
      bucket ? bucket.push(f) : carriedByCheck.set(f.check, [f]);
    }
    const admitted = now.filter((f) => {
      const prior = carriedByCheck.get(f.check);
      return !prior || SEVERITY_RANK[f.severity] > worst(prior);
    });
    // Only a check that actually escalated displaces its carried readings.
    const escalated = new Set(admitted.map((f) => f.check).filter((k) => carriedByCheck.has(k)));
    merged[c] = [...carried.filter((f) => !escalated.has(f.check)), ...admitted];
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
 * let a HALF-READ cycle overwrite a fully-read one: a corridor is replaced only
 * when both its send side and its receive side answered. That kills the noise
 * without blinding the hash — two fully-readable cycles still compare in full
 * detail, which is exactly what catches the swap above. See the rule note there.
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
