import type { OftSnapshot, RouteSnapshot, UlnSnapshot, DriftResult, Finding, RiskLevel, TransactionIntent, Severity, Evidence, Sendability, PreflightResult, CustodyDeclaration } from "../types.js";
import { computeScore } from "./score.js";
import { loadDvnMeta, resolveDvn, isDvnDeprecated, isDeadDvn, isSelfDvn } from "./lz-config.js";
import { getCustodyDeclaration } from "./custody.js";
import { getChainRef } from "./chain-registry.js";

/** The LZ chainKey of the snapshot's OWN chain. DVN names, ids and deprecation are all
 *  per-chain: the same address is a different operator on different chains. This was
 *  hardcoded to "mantle", which meant every ethereum/base asset resolved its DVNs
 *  against Mantle's table. Returns null (→ address fragments, no self-DVN credit,
 *  no deprecation claim) rather than guess a chain we don't recognize. */
function chainKeyOf(snap: OftSnapshot): string | null {
  return getChainRef(snap.chainId)?.chainKey ?? null;
}

// Bumped 1.0.0 → 1.1.0: Owner Type rule now consumes custody declarations
// (fireblocks_mpc downgrade).
// Bumped 1.1.0 → 1.2.0: pathways whose required DVN set is entirely an LZ Dead DVN
// placeholder are classified as unconfigured/blocked (LOW advisory), not scored as a
// live 1-of-1 / default-library CRITICAL — an un-wired placeholder is not a security
// posture the team chose (weETH Base→Zircuit false positive). A real single DVN still
// fires CRITICAL. Attestations made under earlier versions stay valid as recorded.
// Bumped 1.3.0 → 2.0.0 (MAJOR): every Finding now carries an `evidence` tag, which
// changes the Finding schema and therefore the PDR shape and its verdictHash.
// Attestations made under 1.x hash under the old schema and stay valid as recorded;
// recomputation of a 1.x verdict must use the 1.x PDR as stored.
//
// The evidence law replaces three hand-written severity downgrades (Fireblocks MPC,
// non-Safe proxy owner, and the general "we can't see custody" problem) with one rule.
//
// Bumped 2.0.0 → 2.1.0 (MINOR): no schema change, but finding CONTENT changes, so the
// PDR hash of a re-assessed snapshot moves.
//   1. srcChainKey is derived from the snapshot's own chain instead of the hardcoded
//      "mantle". DVN names, ids and deprecation are per-chain — the same address is a
//      different operator on different chains — so every non-Mantle asset was resolving
//      its DVN names against Mantle's table.
//   2. Self-DVN is identified by a curated ticker → operator-id allowlist rather than a
//      name substring test (which credited ticker "O" with operating "LayerZero Labs"),
//      and is therefore `observed` rather than `inferred`.
//   3. A failed proxyAdmin.owner() read no longer interpolates the string "undefined"
//      into the finding detail.
//
// Bumped 2.1.0 → 3.0.0 (MAJOR): the PDR gains `dvnMetaHash` + `dvnMetaFetchedAt`, so the
// shape and the verdictHash both change. 2.x attestations hash under the old schema and
// stay valid as recorded; recomputing a 2.x verdict must use the 2.x PDR as stored.
//
// Why the PDR had to grow: assessSnapshot() was never a pure function of
// (config, declarations). It also reads the LZ DVN metadata table, and a DVN deprecated
// upstream flips a severity with no config change at all. Now that we deliberately serve a
// stale table rather than an empty one on an API outage, that third input is a real
// variable and the determinism invariant ("same config → same verdict") is only honest if
// the verdict names the table it was computed against.
//
// Dead-DVN detection is also now strictly per-chain. `deadAddresses` was a flat
// cross-chain address union, but 14 addresses are an LZ Dead DVN placeholder on one chain
// and a live DVN on another (0x28b6140e… is dead on flare and "LayerZero Labs" on mantle).
// A flat union classifies a genuine 1-of-1 on such a DVN as an unconfigured dead pathway
// and SUPPRESSES its CRITICAL — the exact Kelp shape this rule exists to preserve. That is
// a severity change, hence MAJOR: a route that scored LOW/Dead Pathway may now score
// CRITICAL, correctly.
//
// Bumped 3.0.0 → 4.0.0 (MAJOR): the PDR shape is unchanged, but severities move on real
// assets in both directions, which by the precedent above is a MAJOR change. Three fixes,
// all forced by taking a corridor the engine called "permanently blocked" and verifying it
// on-chain, where it turned out to be live, delivering, and healthy:
//
//   1. SECURITY IS SCORED ON THE RECEIVE SIDE. The DVN Count rule read `uln` — the SEND
//      config — but the sender only decides who gets PAID to verify. The receiver decides
//      who must ATTEST for a message to be accepted, and that quorum is the only thing an
//      attacker has to defeat. An OFT can pay three DVNs on the source chain and score
//      clean while accepting on one at the destination — so an OFT whose RECEIVE side is
//      1-of-1 would have scored PASS. That is a MISSED Kelp, the inverse of the false
//      positive that started this, and the more dangerous of the two. Sentinel now scores
//      the enforcement boundary.
//
//   2. DVN MISMATCH IS A DELIVERABILITY TEST, NOT A SECURITY TEST — and it is a SUBSET
//      test, not an equality test. Delivery needs the sender to pay for everything the
//      receiver requires; paying for MORE is legal and common (LZ's documented
//      "non-blocking mismatch"). The old rule demanded the two sets be equal and declared
//      every difference a permanent block. In practice the difference is usually the
//      receiver's OPTIONAL set, which the old comparison ignored entirely — so the two
//      sides were identical in identity space and nothing was ever blocked. A genuine
//      block (receiver requires a DVN the sender does not pay) still fires HIGH.
//
//   3. SENDABILITY BOUNDS EVERY CLAIM. Teams pre-wire destination chains months before
//      they open them, so a corridor can carry a full config no message has ever crossed.
//      A CRITICAL about money that cannot even be sent is noise. quoteSend() now gates
//      severity (see capBySendability). An UNSENDABLE corridor caps at MEDIUM and pops to
//      its true severity the day it opens; UNKNOWN never caps, so an RPC failure can never
//      suppress a real finding.
//
//      ⚠️ SENDABLE IS NOT DELIVERABLE. quoteSend is priced on the SOURCE chain and knows
//      nothing about the destination's receive config, so it proves only that a corridor
//      ACCEPTS a send. A corridor can be SENDABLE and permanently undeliverable — send
//      confirmations below the destination's requirement, a destination requiring a DVN
//      the sender never pays, a destination whose required DVN set is a dead placeholder.
//      In all three, tokens leave the source and never arrive. That is a FUNDS TRAP, and
//      it is strictly worse than an unsendable route, which at least declines the money.
//      Sendability therefore does two jobs: it caps claims on corridors nothing can enter,
//      and it is what distinguishes a harmless dormant misconfiguration from a live trap.
//
// The through-line, and the same lesson as the evidence law: the engine was asserting a
// risk it had not measured. It measured the send side and claimed the receive side; it
// measured a set difference and claimed a permanent block; it measured a config and
// claimed value was at risk without checking that value could move at all.
// 5.0.0 — MAJOR because the meaning of a score changed, not because a rule did.
// computeScore now deducts once per distinct CHECK at its worst severity instead
// of once per finding. Findings are raised per route, so the old sum measured how
// many corridors an OFT has as much as how exposed it is: ZRO/Base scored 0/100
// for six corridors carrying the same two LayerZero-default advisories. No rule
// here was added, removed or re-labelled. Scores are NOT comparable across this
// boundary, which is precisely why the version moves.
export const RULES_VERSION = "5.0.0";

// ── The evidence law ─────────────────────────────────────────────────────────
// CRITICAL and HIGH require directly observed evidence. An inferred finding caps at
// MEDIUM; an unverifiable one caps at LOW. This makes a false CRITICAL structurally
// impossible rather than merely unlikely: a rule cannot assert more than the reader
// measured. Rules propose (severity, evidence); this function is the only thing that
// decides the severity that ships.
const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, PASS: 4, UNKNOWN: 5,
};
const EVIDENCE_CEILING: Record<Evidence, Severity> = {
  observed: "CRITICAL",   // no cap
  inferred: "MEDIUM",
  unverifiable: "LOW",
};

/** Clamp a finding's severity to what its evidence can support. Never raises. */
export function capByEvidence(f: Finding): Finding {
  const ceiling = EVIDENCE_CEILING[f.evidence];
  // Lower rank number = more severe. Only weaken, never strengthen; PASS/UNKNOWN
  // (ranks 4/5) sit below every ceiling and are left untouched.
  if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[ceiling]) {
    return { ...f, severity: ceiling };
  }
  return f;
}

// ── The sendability law ──────────────────────────────────────────────────────
// A security claim about money that cannot even be SENT is not a security claim. Teams
// pre-wire destination chains long before they open them, so a corridor can carry a
// fully-formed config that no message has ever traversed — and a CRITICAL on it is noise
// that costs exactly as much credibility as a false one.
//
// UNSENDABLE therefore caps route findings at MEDIUM: still recorded, still in the digest,
// never paged. The cap is not suppression — it lifts by itself the day quoteSend starts
// succeeding, so a dangerous pre-wired corridor pops to its true severity the moment it
// opens, which is the moment it starts mattering.
//
// UNKNOWN must NEVER cap. UNKNOWN means the probe failed, not that the corridor is shut;
// letting an RPC hiccup downgrade a CRITICAL would turn Sentinel into a machine for
// suppressing findings under load — a worse failure than the one it replaces.
//
// ⚠️ AND SENDABLE NEVER IMPLIES DELIVERABLE. This ceiling is a CAP, never a licence: it may
// only weaken a finding on a corridor nothing can enter. It must never be read as evidence
// that a SENDABLE corridor is healthy. A corridor that accepts a send and then never
// delivers is a funds trap and is the worst state of all (see the receive-side rules).
const SENDABILITY_CEILING: Record<Sendability, Severity> = {
  SENDABLE: "CRITICAL",   // no cap — and no credit either
  UNSENDABLE: "MEDIUM",   // nothing can even enter this corridor
  UNKNOWN: "CRITICAL",    // we failed to ask — never hold that against the finding
};

/** Clamp a route finding's severity to what its corridor's sendability can support. */
export function capBySendability(f: Finding, sendability: Sendability): Finding {
  const ceiling = SENDABILITY_CEILING[sendability];
  if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[ceiling]) {
    return { ...f, severity: ceiling };
  }
  return f;
}

// ── The delivery law ─────────────────────────────────────────────────────────
// THE lesson of this project, and it took three false findings to learn it:
//
//     the engine kept measuring a CONFIG property and asserting a CONSEQUENCE.
//
// It saw a send/receive DVN set difference and said "permanently blocked" — the corridor
// was delivering. It saw a confirmation asymmetry and said "permanently blocked" — the
// corridor had delivered every message ever sent through it. It saw a dead receive-side
// DVN set and said "funds are stranded" — nobody had ever sent a message into it.
//
// The evidence law did not catch any of these, because it governs how confidently a rule
// may SPEAK, not whether the thing it speaks about was ever OBSERVED. A rule earned
// `observed` by observing the config, then spent it asserting the outcome.
//
// So delivery is now counted, never inferred. `outboundNonce` says what left;
// `inboundNonce` says what landed. No rule may claim a message does not get through
// without them — and the two laws compose: an unmeasured block claim is `inferred`, which
// the evidence law already caps at MEDIUM. A false CRITICAL becomes structurally
// impossible for this whole family of findings, rather than merely discouraged.
export type DeliveryState =
  | "STRANDING"   // sent > delivered: messages left and did not land. Value is stuck.
  | "DELIVERING"  // everything sent has landed — and the last send happened under the
                  // config we score (or we could not rule it out; the note says which).
  | "UNTESTED"    // the corridor has delivered before, but the config CHANGED after the
                  // last send (verified by archival read): nothing has ever crossed
                  // under what we score. Delivery history is stale evidence here.
  | "UNUSED"      // nothing has ever been sent. Nobody is exposed yet.
  | "UNKNOWN";    // not measured. Never assume.

export function deliveryState(route: RouteSnapshot): DeliveryState {
  const d = route.delivery;
  if (!d || d.delivered === null) return "UNKNOWN";
  if (d.sent === 0) return "UNUSED";
  if (d.sent > d.delivered) return "STRANDING";
  return d.sentUnderCurrentConfig === false ? "UNTESTED" : "DELIVERING";
}

/**
 * THE DELIVERY LAW (corrected 2026-07-15; the first version of this function encoded
 * the opposite and shipped a downgrade):
 *
 *   Delivery evidence is HISTORICAL; config is CURRENT. Nonces can never SOFTEN a
 *   config-derived block claim. They can only ESCALATE it (funds observably stranded)
 *   or CONTRADICT it (messages crossing under the exact config that says they cannot —
 *   which means one of our reads is wrong: a sensor-integrity flag, not a downgrade).
 *
 * Why softening was wrong, empirically: a live corridor showed sent == delivered, which
 * the old law read as "the corridor works despite the config → MEDIUM". Every delivery
 * predated the config change by more than a year. Nothing had ever crossed under the
 * config we scored — and the first message sent after the change is BLOCKED on
 * LayerZero Scan to this day. `sent == delivered` was stale evidence, and the
 * downgrade it bought was a false MEDIUM on a real HIGH.
 *
 * So: severity comes from CONFIG + DOCS and is passed in by the rule; delivery supplies
 * EXPOSURE, spoken in the note. The finding's evidence is `observed` in every state —
 * what is observed is the misconfiguration itself, on-chain, against LZ's own docs.
 */
export function blockClaim(state: DeliveryState, d: RouteSnapshot["delivery"], configSeverity: Severity): {
  severity: Severity; evidence: Evidence; note: string;
} {
  switch (state) {
    case "STRANDING": {
      const stuck = (d!.sent - d!.delivered!);
      return {
        severity: configSeverity, evidence: "observed",
        note: `${stuck} message${stuck === 1 ? "" : "s"} sent that the destination never accepted (${d!.sent} sent, ${d!.delivered} delivered): value is observably stranded`,
      };
    }
    case "DELIVERING":
      if (d!.sentUnderCurrentConfig === true) {
        // Verified contradiction: the last send crossed under the exact config we read
        // as blocking. The world wins — but that impeaches our READ, not the law. Flag
        // it for sensor investigation; do not downgrade (a wrong read could just as
        // easily be hiding something worse).
        return {
          severity: configSeverity, evidence: "observed",
          note: `⚠ SENSOR CONTRADICTION: messages are crossing under the exact config we read as blocking (${d!.sent} sent, ${d!.delivered} delivered, last send under the current config) — one of our reads is wrong; investigate the pipeline before trusting either claim`,
        };
      }
      // Delivery history exists, but whether ANY of it happened under the CURRENT config
      // is unverified (the archival discriminator has not run here). History must not
      // soften a claim about the present — that is exactly the stale-evidence mistake.
      return {
        severity: configSeverity, evidence: "observed",
        note: `the corridor has delivered before (${d!.sent} sent, ${d!.delivered} delivered), but whether any message has crossed under the CURRENT config is unverified — past delivery does not clear a present misconfiguration`,
      };
    case "UNTESTED":
      return {
        severity: configSeverity, evidence: "observed",
        note: `the corridor's delivery history (${d!.sent} sent, ${d!.delivered} delivered) all predates the current config (verified by archival read): nothing has ever crossed under what we score — the next send is the experiment`,
      };
    case "UNUSED":
      return {
        severity: configSeverity, evidence: "observed",
        note: "no message has ever been sent through this corridor — no funds exposed yet, and the first send is the one that strands",
      };
    case "UNKNOWN":
      return {
        severity: configSeverity, evidence: "observed",
        note: "delivery accounting unavailable for this corridor; the claim rests on the observed config and LZ's documented behaviour alone",
      };
  }
}

/** How many distinct verifiers must attest before this side accepts a message.
 *  Required DVNs must ALL sign; `optionalDVNThreshold` of the optional set must also
 *  sign. Forging a message means defeating every one of them. */
export function effectiveDvns(uln: UlnSnapshot): number {
  return uln.requiredDVNCount + (uln.optionalDVNThreshold ?? 0);
}

export interface Deliverability {
  /** True = no message can be delivered. The receiver demands a verifier the sender
   *  does not pay, so the quorum can never be met. This is a real permanent block. */
  blocked: boolean;
  /** Receiver-required verifiers the sender does not pay for. */
  missingRequired: string[];
  /** How far short the sender falls of the receiver's optional-DVN threshold. */
  optionalShortfall: number;
  /** Verifiers the sender pays for that the receiver neither requires nor counts. Safe —
   *  they cannot block or weaken anything — but not free: every DVN in the send config is
   *  paid on every message, so these are burning fees on attestations nobody reads. */
  overpaid: string[];
}

/**
 * Can a message verified under the SEND config satisfy the RECEIVE config?
 *
 * This is a SUBSET test, not an equality test. LayerZero delivers whenever the sender
 * pays for everything the receiver demands; paying for more is legal, common, and
 * documented ("non-blocking mismatch"). The old equality test called every difference a
 * permanent block, and produced a HIGH on a corridor that had been delivering the whole
 * time — verified by quoting a real message through it.
 *
 * The economics are what make the subset test the right one. EVERY DVN in the send config
 * is paid on every message — required and optional alike; the threshold decides who must
 * SIGN, never who gets PAID. So the sender's paid set is exactly the set of attestations
 * that can exist, and the receiver can only ever demand a subset of it. (It also means
 * optional DVNs are not free redundancy: you cannot stack an unbounded optional set,
 * because each one bills on every message.)
 *
 * Compares canonical operator identities, never raw addresses: the same operator has a
 * different address on every chain (BitGo is 0xc9ca319f… on ethereum and 0xf55E9dAe… on
 * hyperliquid), so an address diff reports a mismatch between a DVN and itself.
 */
export function assessDeliverability(
  sendNames: string[],
  sendOptionalNames: string[],
  recvRequiredNames: string[],
  recvOptionalNames: string[],
  recvOptionalThreshold: number,
): Deliverability {
  const paid = new Set([...sendNames, ...sendOptionalNames]);
  const missingRequired = recvRequiredNames.filter((n) => !paid.has(n));
  const optionalCovered = recvOptionalNames.filter((n) => paid.has(n)).length;
  const optionalShortfall = Math.max(0, recvOptionalThreshold - optionalCovered);
  const counted = new Set([...recvRequiredNames, ...recvOptionalNames]);
  return {
    blocked: missingRequired.length > 0 || optionalShortfall > 0,
    missingRequired,
    optionalShortfall,
    overpaid: [...paid].filter((n) => !counted.has(n)),
  };
}

function activeRoutes(snap: OftSnapshot): RouteSnapshot[] {
  return snap.routes.filter((r) => r.isActive);
}

function routeByEid(snap: OftSnapshot, eid: number): RouteSnapshot | undefined {
  return snap.routes.find((r) => r.eid === eid);
}

/**
 * Diff a fresh snapshot against the last-known-good one. Drift = the config moved
 * in a security-relevant direction on a live route: fewer required DVNs, lower
 * confirmations, a pinned library reverting to the upgradeable default,
 * a deprecated DVN newly appearing in the required set, or a new 1-of-1 route.
 */
export async function detectDrift(prev: OftSnapshot, next: OftSnapshot): Promise<DriftResult> {
  const reasons: string[] = [];
  const dvnMeta = await loadDvnMeta();
  const srcChainKey = chainKeyOf(next);

  for (const route of activeRoutes(next)) {
    const before = routeByEid(prev, route.eid);

    if (!before) {
      // Newly active route: flag if it starts in a risky state.
      // Skip unconfigured/dead pathways (required set entirely LZ Dead DVN) — a new
      // placeholder route is message-blocked, not a live 1-of-1 (see assessSnapshot's
      // Dead Pathway rule). Attesting it as a new SPOF would be a false alarm.
      if (route.uln && route.uln.requiredDVNs.length > 0 &&
          route.uln.requiredDVNs.every((a) => isDeadDvn(a, srcChainKey, dvnMeta))) {
        continue;
      }
      if (route.uln) {
        const newEffective = route.uln.requiredDVNCount + (route.uln.optionalDVNThreshold ?? 0);
        if (newEffective <= 1) {
          reasons.push(`${route.chainName}: new route added with 1-of-1 effective DVN: single point of failure`);
        }
        for (const dvnAddr of route.uln.requiredDVNs) {
          if (isDvnDeprecated(dvnAddr, srcChainKey, dvnMeta)) {
            const name = resolveDvn(dvnAddr, srcChainKey, dvnMeta);
            reasons.push(`${route.chainName}: new route added with deprecated required DVN "${name}"`);
          }
        }
      }
      continue;
    }

    // RPC source-conflict: newly detected disagreement between providers on this route.
    if (!before?.rpcConflict && route.rpcConflict) {
      reasons.push(`${route.chainName}: RPC providers disagree on required DVN configuration: possible source manipulation`);
    }

    // Only compare DVN count / confirmations when BOTH snapshots carry a real ULN
    // read. A null `uln` means the on-chain read failed (transient RPC) — coercing
    // "missing" to 0 would read as a downgrade and fire a false CRITICAL that gets
    // attested on-chain (real tx + MNT spend). Skip the comparison instead of guessing.
    if (before.uln && route.uln) {
      const prevEffective = before.uln.requiredDVNCount + (before.uln.optionalDVNThreshold ?? 0);
      const nextEffective = route.uln.requiredDVNCount + (route.uln.optionalDVNThreshold ?? 0);
      if (nextEffective < prevEffective) {
        reasons.push(`${route.chainName}: effective DVN count dropped ${prevEffective} → ${nextEffective}`);
      } else if (route.uln.requiredDVNCount < before.uln.requiredDVNCount) {
        reasons.push(`${route.chainName}: required DVN count dropped ${before.uln.requiredDVNCount} → ${route.uln.requiredDVNCount}`);
      }
      if (route.uln.confirmations < before.uln.confirmations) {
        reasons.push(`${route.chainName}: confirmations fell ${before.uln.confirmations} → ${route.uln.confirmations}`);
      }

      // DVN identity check: a same-count swap can silently replace a good DVN with a
      // deprecated one. Flag any DVN address newly in the required set that is deprecated.
      const prevSet = new Set(before.uln.requiredDVNs.map((a) => a.toLowerCase()));
      for (const dvnAddr of route.uln.requiredDVNs) {
        if (!prevSet.has(dvnAddr.toLowerCase()) && isDvnDeprecated(dvnAddr, srcChainKey, dvnMeta)) {
          const name = resolveDvn(dvnAddr, srcChainKey, dvnMeta);
          reasons.push(`${route.chainName}: deprecated DVN "${name}" newly added to required set`);
        }
      }
    }

    if (before.sendLibIsDefault === false && route.sendLibIsDefault === true) {
      reasons.push(`${route.chainName}: send library reverted to the upgradeable default`);
    }
    if (before.receiveLibIsDefault === false && route.receiveLibIsDefault === true) {
      reasons.push(`${route.chainName}: receive library reverted to the upgradeable default`);
    }
  }

  return { drifted: reasons.length > 0, reasons };
}

const RISK_RANK: Record<RiskLevel, number> = { PASS: 0, AT_RISK: 1, CRITICAL: 2 };

// UNKNOWN behaves like PASS for risk banding: an unevaluated check is not evidence
// of risk. LOW is advisory — it deducts score but doesn't flip the band (mirrors
// /oft-review, where LOW notes never change the verdict on their own).
function deriveRiskLevel(fs: Finding[]): RiskLevel {
  let risk: RiskLevel = "PASS";
  for (const f of fs) {
    const level: RiskLevel =
      f.severity === "CRITICAL" ? "CRITICAL"
      : f.severity === "HIGH" || f.severity === "MEDIUM" ? "AT_RISK"
      : "PASS";
    if (RISK_RANK[level] > RISK_RANK[risk]) risk = level;
  }
  return risk;
}

// Apply the AuditRegistry risk-band clamps (CRITICAL ≤25, AT_RISK ≤84).
function clampScore(raw: number, risk: RiskLevel): number {
  if (risk === "CRITICAL") return Math.min(raw, 25);
  if (risk === "AT_RISK") return Math.min(raw, 84);
  return raw;
}

/**
 * Deterministic risk assessment of a single snapshot.
 *
 * Checks (ported from /oft-review fetch_oft_config.py rule set):
 *   CRITICAL: 1-of-1 required DVN (Kelp rsETH exploit pattern)
 *   CRITICAL: deprecated DVN in required set (per LZ metadata)
 *   HIGH:     cross-chain DVN name mismatch (send vs receive — permanent message block)
 *   HIGH:     OFT owner is an EOA (LOW advisory if Fireblocks MPC custody is declared)
 *   HIGH:     proxy upgrade controlled by EOA (not a multisig)
 *   MEDIUM:   2-of-2 required DVNs (no redundancy)
 *   MEDIUM:   block confirmations < 15
 *   MEDIUM:   send library is the upgradeable default (not pinned)
 *   MEDIUM:   proxy upgrade controlled by a multisig (better than EOA, still notable)
 */
export async function assessSnapshot(
  snap: OftSnapshot,
  ticker?: string,
  // Custody declaration for this OFT's owner key. `undefined` = look it up from
  // the declarations store; `null` = explicitly none (tests / callers that
  // already resolved it). Declarations are an engine input and get embedded in
  // the findings they influence, so the PDR hash stays recomputable.
  custody?: CustodyDeclaration | null,
): Promise<{
  findings: Finding[];
  score: number;
  riskLevel: RiskLevel;
  tis: TransactionIntent[];
}> {
  const custodyDecl = custody !== undefined ? custody : getCustodyDeclaration(snap.oft, snap.chainId);
  const findings: Finding[] = [];
  // TIS: keyed by "intent|dvnAddress" to collapse identical issues across corridors into one entry.
  const tisMap = new Map<string, TransactionIntent>();
  // Pre-flight links: which findings each intent resolves, and the successor
  // finding (if any) the fixed config lands in — e.g. fixing 1-of-1 yields a
  // 2-of-2 config, which itself scores MEDIUM. Simulating the successor state
  // is what makes pre-flight deterministic instead of a naive deduction reversal.
  const tisLinks = new Map<string, { resolves: Finding[]; successors: Finding[] }>();

  function addTIS(
    key: string,
    corridor: string | null,
    entry: Omit<TransactionIntent, "corridors">,
    resolves?: Finding,
    successor?: Finding,
  ): void {
    if (!tisMap.has(key)) {
      tisMap.set(key, { ...entry, corridors: corridor ? [corridor] : undefined });
    } else if (corridor) {
      const ex = tisMap.get(key)!;
      if (!ex.corridors) ex.corridors = [];
      if (!ex.corridors.includes(corridor)) ex.corridors.push(corridor);
    }
    const link = tisLinks.get(key) ?? { resolves: [], successors: [] };
    if (resolves) link.resolves.push(resolves);
    if (successor) link.successors.push(successor);
    tisLinks.set(key, link);
  }

  const dvnMeta = await loadDvnMeta();
  // DVN names are keyed by LZ chainKey string ("mantle"), not numeric chain ID ("5000").
  const srcChainKey = chainKeyOf(snap);

  // Corridors with no enforced options — collapsed into one LOW finding below.
  const missingEnfOpts: string[] = [];

  for (const route of activeRoutes(snap)) {
    // ── RPC source conflict ─────────────────────────────────────────────────
    // Flagged by lz-config.ts when a secondary Mantle RPC returns different
    // requiredDVNs / counts. Either a compromised primary RPC is hiding a
    // security downgrade, or there is a genuine data inconsistency — both
    // require manual verification before trusting any automated verdict.
    if (route.rpcConflict) {
      const f: Finding = {
        severity: "CRITICAL",
        evidence: "observed",
        check: "RPC Source Conflict",
        detail: `${route.chainName}: multiple RPC providers disagree on the required DVN configuration: possible node manipulation or data inconsistency.`,
      };
      findings.push(f);
      addTIS("resolve_rpc_conflict", route.chainName, {
        intent: "resolve_rpc_conflict",
        action: "Manually verify DVN configuration on-chain before trusting this verdict",
        currentState: "Multiple RPC sources return conflicting DVN configs",
        targetState: "All RPC sources agree on the same DVN configuration",
        reason: "RPC disagreement may indicate node manipulation, stale data, or a mid-block state read",
        severity: "CRITICAL",
      }, f);
    }

    const uln = route.uln;
    if (!uln) {
      // UNKNOWN: read failed after retry + secondary-RPC fallback. Surfaced for
      // transparency but never deducts score — a transient infra failure must
      // not read as a security downgrade (USDT0 scored 50 from exactly this).
      findings.push({
        severity: "UNKNOWN",
        evidence: "unverifiable",
        check: "ULN Unreadable",
        detail: `${route.chainName}: ${route.sendLibrary ? "ULN config could not be read" : "send library not configured on endpoint"}. DVN and confirmation settings unverifiable on this corridor (not scored).`,
      });
      continue;
    }

    // ── Dead / unconfigured pathway ──────────────────────────────────────────
    // A required DVN set consisting entirely of LZ Dead DVN placeholders (0x…dEaD,
    // zero address, or a metadata-flagged "LZ Dead DVN") can never verify a message:
    // the pathway is unconfigured and message-blocked (LZ "Default Config D"), not a
    // live 1-of-1. A dead DVN cannot be compromised to forge messages (the Kelp
    // pattern) — it cannot attest at all — so scoring this route's 1-of-1 / default
    // libraries as CRITICAL is a false positive (weETH Base→Zircuit). Emit one visible
    // LOW advisory and skip this route's remaining rules. A real DVN in the required
    // set (functional count > 0) is unaffected and still scores normally below.
    if (uln.requiredDVNs.length > 0 && uln.requiredDVNs.every((a) => isDeadDvn(a, srcChainKey, dvnMeta))) {
      findings.push({
        severity: "LOW",
        evidence: "observed",
        check: "Dead Pathway",
        detail: `${route.chainName}: required DVN set is entirely an LZ Dead DVN placeholder — pathway not configured; messages are blocked and cannot be delivered. Not a live route (funds bridged here would be stuck until the OApp sets real DVNs).`,
      });
      continue;
    }

    const dstChainKey = route.chainKey; // destination chainKey — for DVN name lookup on dst
    const sendability: Sendability = route.sendability ?? "UNKNOWN";

    // Route-scoped SECURITY findings are bounded by whether the corridor will accept a
    // send at all (see the sendability law). Sensor-integrity findings — RPC Source
    // Conflict, ULN Unreadable — are deliberately NOT routed through this: they say our
    // reading is untrustworthy, and that is true whether or not the corridor carries
    // traffic. Push those directly.
    const pushRoute = (f: Finding): Finding => {
      const capped = capBySendability(f, sendability);
      if (capped.severity !== f.severity) f.severity = capped.severity;
      findings.push(f);
      return f;
    };

    const recvUln = route.receiveUln;
    // What actually crossed. Gates every claim below that messages do not get through.
    const delivery = deliveryState(route);

    // ── Half-wired corridor: the destination does not peer back ──────────────
    // setPeer is one-directional. quoteSend only reads the SOURCE's peer mapping, so a
    // corridor with no peer back still quotes, still debits the sender, still emits — and
    // then lzReceive reverts on _getPeerOrRevert, forever. LZ files this under
    // "NotInitializable" / Blocked. Teams wire chains one direction at a time, which makes
    // this the most likely trap in the fleet and the one no other check can see.
    // peerSymmetric === null means we could not read it: say nothing.
    if (route.peerSymmetric === false) {
      const c = blockClaim(delivery, route.delivery, "HIGH");
      const f: Finding = {
        severity: c.severity,
        evidence: c.evidence,
        check: "Half-Wired Corridor",
        detail: `${route.chainName}: this OFT peers to the destination, but the destination does NOT peer back (${route.reversePeer ? `it points at ${route.reversePeer.slice(0, 10)}…` : "no peer set"}). The corridor still accepts sends — quoteSend only reads the source's own peer mapping — but lzReceive reverts on the destination and can never succeed. ${c.note}.`,
      };
      pushRoute(f);
      addTIS("fix_peer_asymmetry", route.chainName, {
        intent: "fix_peer_asymmetry",
        action: "Call setPeer on the DESTINATION so it points back at this OFT (or unset the source peer to close the pathway)",
        currentState: "Source peers to the destination; the destination does not peer back",
        targetState: "Both sides peer to each other, or neither does",
        reason: "A one-directional peer lets the corridor accept sends it can never deliver",
        severity: c.severity,
      }, f);
      continue;
    }

    // ── Dead DVN set on the RECEIVE side ─────────────────────────────────────
    // Only reachable from 4.0.0: scoring the receive side is what first exposes us to a
    // dead RECEIVE config, which the send-side Dead Pathway rule above never guarded.
    //
    // A destination whose required DVN set is entirely an LZ Dead DVN placeholder can
    // never verify anything. That is NOT a live 1-of-1: a dead DVN cannot be compromised
    // into forging a message, because it cannot attest at all. Scoring it as the Kelp
    // pattern asserts a forgery risk the config does not support — precisely the class of
    // false CRITICAL this release exists to remove, so introducing a new one would be a
    // poor joke. (Caught by A/B-ing 4.0.0 against 3.0.0 over the live fleet, which
    // surfaced it as a NEW CRITICAL. Every unit test passed; only the fleet diff found it.)
    //
    // ⚠️ BUT IT IS NOT THE HARMLESS TWIN OF THE SEND-SIDE RULE, and treating it as one was
    // this rule's second bug. The two are asymmetric, and sendability is what separates them:
    //
    //   send side dead    → quoteSend REVERTS → nothing can enter → genuinely harmless
    //   receive side dead → quoteSend SUCCEEDS → the corridor still ACCEPTS SENDS, still
    //                       debits the user, still emits the message — and the destination
    //                       can never verify it. Tokens leave and never arrive.
    //
    // quoteSend is priced on the source chain and cannot see the destination's config, so
    // it happily quotes a route that will strand every token sent through it. That is a
    // FUNDS TRAP: strictly worse than a dead route, which at least declines the money. It
    // gets HIGH, and the detail says plainly where the funds go, so no reader can mistake
    // it for an advisory. Only when the corridor also refuses sends is it the quiet LOW.
    if (recvUln && recvUln.requiredDVNs.length > 0 &&
        recvUln.requiredDVNs.every((a) => isDeadDvn(a, dstChainKey, dvnMeta))) {
      const c = blockClaim(delivery, route.delivery, "HIGH");
      const f: Finding = {
        severity: c.severity,
        evidence: c.evidence,
        check: "Dead Receive DVN",
        detail: `${route.chainName}: the DESTINATION's required DVN set is entirely an LZ Dead DVN placeholder, so the receive side can verify nothing — and the corridor still accepts sends (quoteSend prices one). ${c.note}. Not a forgeable 1-of-1: a dead DVN cannot attest at all, so it cannot be compromised to forge.`,
      };
      pushRoute(f);
      addTIS("resolve_dead_receive_dvn", route.chainName, {
        intent: "resolve_dead_receive_dvn",
        action: "Set real DVNs on the destination's receive config, or close the pathway so it stops accepting sends",
        currentState: "Destination requires only an LZ Dead DVN placeholder, yet the corridor still accepts sends",
        targetState: "Destination verifies on real DVNs the sender pays, or the corridor refuses sends",
        reason: "The corridor debits the sender and emits a message the destination can never verify",
        severity: c.severity,
      }, f);
      continue;
    }

    // ── DVN count: score the RECEIVE side, the enforcement boundary ──────────
    // A message is accepted where it LANDS. The destination's required set plus its
    // optional threshold is the quorum an attacker must defeat to forge a transfer.
    // Whatever else the sender paid for has no bearing on acceptance — so scoring the
    // send side, as this rule did until 4.0.0, measures who PAYS rather than who GUARDS.
    const recvIsReadable = !!recvUln && effectiveDvns(recvUln) >= 1;
    const sendPaidCount = uln.requiredDVNCount + uln.optionalDVNCount;

    let effectiveDvnCount: number;
    let dvnEvidence: Evidence;
    let dvnNames: string;
    let quorumNote: string;

    if (recvIsReadable) {
      // The enforcement boundary itself, read from the destination chain.
      effectiveDvnCount = effectiveDvns(recvUln!);
      dvnEvidence = "observed";
      dvnNames = [...recvUln!.requiredDVNs, ...recvUln!.optionalDVNs]
        .map((a) => resolveDvn(a, dstChainKey, dvnMeta)).join(", ");
      quorumNote = recvUln!.optionalDVNCount > 0
        ? `${recvUln!.requiredDVNCount} required + ${recvUln!.optionalDVNThreshold}-of-${recvUln!.optionalDVNCount} optional, on the receive side`
        : `${recvUln!.requiredDVNCount} required, on the receive side`;
    } else {
      // Destination config unreadable, so we are reading the send side and reasoning
      // about the receive side. Usually that is a PROXY, not the boundary — the receiver
      // may demand a different quorum than the sender pays for — so the evidence law caps
      // it at MEDIUM and it can never ship a false CRITICAL.
      //
      // ONE case is a proof rather than a proxy, and it is the case that matters. If the
      // sender pays exactly one DVN, then exactly one attestation can ever exist for this
      // corridor, so the receiver CANNOT require more than that one — there is nothing
      // else for it to require. Every message that lands here is secured by a single
      // verifier. The config admits no other reading:
      //
      //     sender pays ≤1 DVN  ⟹  (corridor is dead)  OR  (boundary is a real 1-of-1)
      //
      // There is no third branch, and the dead branch is not the evidence law's job — it
      // is exactly what capBySendability handles. So this stays `observed`, and the Kelp
      // 1-of-1 keeps firing CRITICAL on a corridor we cannot see the far side of.
      //
      // Note this keys on how many DVNs are PAID, not the send-side effective count. A
      // sender paying 3 optional DVNs with a threshold of 1 has an effective count of 1
      // but produces three attestations, and the receiver may well require two of them —
      // that is a genuine proxy, and it is correctly capped as inferred.
      effectiveDvnCount = effectiveDvns(uln);
      dvnEvidence = sendPaidCount <= 1 ? "observed" : "inferred";
      dvnNames = uln.requiredDVNs.map((a) => resolveDvn(a, srcChainKey, dvnMeta)).join(", ");
      quorumNote = sendPaidCount <= 1
        ? "receive config unreadable, but the sender pays only this one DVN — no larger quorum can exist"
        : "receive config unreadable — send side used as a proxy";
    }

    const fixTarget = recvIsReadable ? "the destination's receive config" : "the send configuration";

    if (effectiveDvnCount <= 1) {
      const f: Finding = {
        severity: "CRITICAL",
        evidence: dvnEvidence,
        check: "DVN Count",
        detail: `${route.chainName}: 1 effective DVN (${dvnNames || "unresolved"}; ${quorumNote}): a single compromised verifier can forge a message the destination will accept (Kelp rsETH exploit pattern).`,
      };
      pushRoute(f);
      // Successor: adding one DVN lands in the 2-of-2 state, which itself
      // scores MEDIUM — pre-flight must predict 84/AT_RISK, not 100/PASS.
      const successor: Finding = {
        severity: "MEDIUM",
        evidence: dvnEvidence,
        check: "DVN Count",
        detail: `${route.chainName}: 2 effective DVNs after fix: minimal redundancy.`,
      };
      addTIS("restore_dvn_redundancy", route.chainName, {
        intent: "restore_dvn_redundancy",
        action: `Add a second independent required DVN to ${fixTarget}`,
        dvnAddress: uln.requiredDVNs[0],
        dvnName: uln.requiredDVNs[0] ? resolveDvn(uln.requiredDVNs[0], srcChainKey, dvnMeta) : undefined,
        currentState: `1 effective DVN (${dvnNames || "unresolved"}): single point of failure`,
        targetState: "≥2 independent verifiers in the accepting quorum",
        reason: "1-of-1 DVN config matches the Kelp rsETH exploit pattern. Single DVN compromise enables message forgery.",
        severity: "CRITICAL",
      }, f, successor);
    } else if (effectiveDvnCount === 2) {
      const f: Finding = {
        severity: "MEDIUM",
        evidence: dvnEvidence,
        check: "DVN Count",
        detail: `${route.chainName}: 2 effective DVNs (${dvnNames}; ${quorumNote}): minimal redundancy.`,
      };
      pushRoute(f);
      addTIS("increase_dvn_redundancy", route.chainName, {
        intent: "increase_dvn_redundancy",
        action: `Add a third independent required DVN to ${fixTarget}`,
        currentState: `2 effective DVNs (${dvnNames}): one compromise breaks the quorum`,
        targetState: "≥3 independent verifiers in the accepting quorum",
        reason: "2-of-2 DVN config means a single DVN compromise or outage halts all messages",
        severity: "MEDIUM",
      }, f);
    }

    // ── Deprecated DVNs ─────────────────────────────────────────────────────
    // Send config lives on the source chain (Mantle) — look up by srcChainKey.
    for (const dvnAddr of uln.requiredDVNs) {
      if (isDvnDeprecated(dvnAddr, srcChainKey, dvnMeta)) {
        const name = resolveDvn(dvnAddr, srcChainKey, dvnMeta);
        const f: Finding = {
          severity: "CRITICAL",
          evidence: "observed",
          check: "Deprecated DVN",
          detail: `${route.chainName}: required DVN "${name}" is deprecated: messages may halt.`,
        };
        pushRoute(f);
        addTIS(`replace_deprecated_dvn|${dvnAddr.toLowerCase()}`, route.chainName, {
          intent: "replace_deprecated_dvn",
          action: `Replace deprecated DVN "${name}" with an active supported alternative`,
          dvnAddress: dvnAddr,
          dvnName: name,
          currentState: `"${name}" is deprecated: messages may permanently halt`,
          targetState: "Active, supported DVN in required set",
          reason: "Deprecated DVNs stop attesting messages, permanently blocking the route",
          severity: "CRITICAL",
        }, f);
      }
    }

    // ── Self-DVN detection (informational — NOT a deduction) ─────────────────
    // A protocol running its own DVN is ADDITIVE security: they verify on top of the
    // independent set, and they are the party with the most to lose from a forged
    // message. It is a plus, not a flaw, so this finding never deducts score.
    //
    // The "only one independent verifier" concern in a 2-of-2 set is a property of the
    // COUNT, not of who operates the DVN — and it is already scored by the DVN Count
    // 2-of-2 MEDIUM above. Deducting here too would double-count the same fact and
    // penalise the protocols doing the extra work.
    //
    // Kept as PASS so it still appears in the record (and in the PDR) as a positive
    // signal a reader can see.
    //
    // Identification is a curated ticker → DVN-operator-`id` allowlist (isSelfDvn), NOT
    // a name match. The previous substring test made ticker "O" match "LayerZero Labs"
    // and credited the O protocol with operating LayerZero's own DVN. An address that is
    // in the required set is read from the chain, and the address→operator mapping comes
    // from LZ's own published registry, so this is `observed`. (Evidence never raises a
    // PASS regardless; the tag is descriptive here.)
    if (ticker && effectiveDvnCount >= 2) {
      for (const dvnAddr of uln.requiredDVNs) {
        if (isSelfDvn(dvnAddr, ticker, srcChainKey, dvnMeta)) {
          findings.push({
            severity: "PASS",
            evidence: "observed",
            check: "Self-DVN",
            detail: `${route.chainName}: "${resolveDvn(dvnAddr, srcChainKey, dvnMeta)}" is operated by the protocol and sits in the required set: additive verification by the party with the most at stake.`,
          });
          break;
        }
      }
    }

    // ── Deliverability: can the send config satisfy the receive config? ──────
    // Formerly "DVN Mismatch", which demanded the two sets be EQUAL and called every
    // difference a permanent block. Both halves of that were wrong. LayerZero delivers
    // whenever the sender pays for everything the receiver requires; paying for MORE is
    // legal and routine (LZ's documented "non-blocking mismatch"). The test is a SUBSET
    // test, and the only thing at stake is deliverability — never security, which is
    // settled entirely on the receive side by the DVN Count rule above.
    //
    // Guard retained: only compare when EVERY DVN on BOTH sides resolves to a canonical
    // name. An unresolved address fragment compares unequal to everything by definition,
    // which is a resolution gap, not a mismatch. Linea has no entry in the DVN metadata
    // API; those routes fall through here safely.
    if (uln.requiredDVNs.length > 0 && recvUln?.requiredDVNs?.length) {
      const isResolved = (name: string) => !name.endsWith("…"); // address fragment = unresolved
      const sendReq = uln.requiredDVNs.map((a) => resolveDvn(a, srcChainKey, dvnMeta));
      const sendOpt = uln.optionalDVNs.map((a) => resolveDvn(a, srcChainKey, dvnMeta));
      const recvReq = recvUln.requiredDVNs.map((a) => resolveDvn(a, dstChainKey, dvnMeta));
      const recvOpt = recvUln.optionalDVNs.map((a) => resolveDvn(a, dstChainKey, dvnMeta));

      if ([...sendReq, ...sendOpt, ...recvReq, ...recvOpt].every(isResolved)) {
        const d = assessDeliverability(sendReq, sendOpt, recvReq, recvOpt, recvUln.optionalDVNThreshold ?? 0);
        const paidList = [...sendReq, ...sendOpt].join(", ");
        const recvList = recvOpt.length
          ? `${recvReq.join(", ")} + ${recvUln.optionalDVNThreshold}-of-[${recvOpt.join(", ")}]`
          : recvReq.join(", ");

        if (d.blocked) {
          // The destination demands a verifier the sender does not pay, so on paper its
          // quorum can never be met. On paper. Whether messages ACTUALLY fail to land is a
          // measurement, not a deduction — see the delivery law. This rule shipped a HIGH
          // "permanently blocked" on a corridor that was delivering; it does not get to
          // make that claim again without counting.
          const why = d.missingRequired.length
            ? `destination requires [${d.missingRequired.join(", ")}], which the sender does not pay`
            : `sender covers ${d.optionalShortfall} too few of the destination's optional DVNs (needs ${recvUln.optionalDVNThreshold})`;
          const c = blockClaim(delivery, route.delivery, "HIGH");
          const f: Finding = {
            severity: c.severity,
            evidence: c.evidence,
            check: "Undeliverable Route",
            detail: `${route.chainName}: sender pays [${paidList}] but the destination accepts on [${recvList}] — ${why}. ${c.note}.`,
          };
          pushRoute(f);
          addTIS(`resolve_dvn_mismatch`, route.chainName, {
            intent: "resolve_dvn_mismatch",
            action: "Add the destination's required DVNs to the send config (or drop them from the receive config)",
            currentState: `Sender pays [${paidList}]; destination accepts on [${recvList}]`,
            targetState: "Sender pays for every DVN the destination requires",
            reason: "The destination's verification quorum cannot be met by the DVNs the sender pays",
            severity: c.severity,
          }, f);
        } else if (d.overpaid.length > 0) {
          // Non-blocking mismatch. Messages flow — the sender simply pays verifiers the
          // destination does not count. Not a vulnerability, so it must not carry a
          // severity; recorded as a PASS so the drift signal stays visible in the PDR
          // without deducting score or firing an alert. This is the exact shape that
          // produced the false "permanently blocked" HIGH under 3.0.0.
          findings.push({
            severity: "PASS",
            evidence: "observed",
            check: "Non-Blocking DVN Mismatch",
            detail: `${route.chainName}: sender pays [${paidList}] but the destination only accepts on [${recvList}] — extra DVNs [${d.overpaid.join(", ")}] are paid for and ignored. Messages deliver normally; security is set by the receive side. Fees are higher than necessary.`,
          });
        }
      }
    }

    // ── Block confirmations ──────────────────────────────────────────────────
    if (uln.confirmations > 0 && uln.confirmations < 15) {
      const f: Finding = {
        severity: "MEDIUM",
        evidence: "observed",
        check: "Confirmations",
        detail: `${route.chainName}: ${uln.confirmations} block confirmations (< 15, reorg risk).`,
      };
      pushRoute(f);
      addTIS("increase_confirmations", route.chainName, {
        intent: "increase_confirmations",
        action: "Raise confirmation threshold to ≥15 blocks",
        currentState: `${uln.confirmations} block confirmation${uln.confirmations !== 1 ? "s" : ""}`,
        targetState: "≥15 block confirmations",
        reason: "Low confirmations expose the route to chain re-org attacks",
        severity: "MEDIUM",
      }, f);
    }

    // ── Enforced options ────────────────────────────────────────────────────
    // Collected per route, emitted as ONE fleet-wide LOW finding after the loop —
    // a per-corridor deduction would let a low-severity advisory (−5 × N routes)
    // outweigh a CRITICAL on wide deployments.
    if (route.hasEnforcedOptions === false) {
      missingEnfOpts.push(route.chainName);
    }

    // ── Send library pinning ─────────────────────────────────────────────────
    // Reference says HIGH: LZ Labs OneSig (3-of-5 EOAs) can redirect outbound
    // verification to a different library without the OFT team's involvement.
    if (route.sendLibIsDefault === true) {
      const f: Finding = {
        severity: "HIGH",
        evidence: "observed",
        check: "Send Library Pinning",
        detail: `${route.chainName}: send library is the upgradeable default. LZ Labs OneSig can redirect outbound verification unilaterally.`,
      };
      pushRoute(f);
      addTIS("pin_send_library", route.chainName, {
        intent: "pin_send_library",
        action: "Pin the send library to a specific version",
        currentState: "Upgradeable default (LZ Labs-controlled)",
        targetState: "Pinned library address immutable to LZ Labs upgrades",
        reason: "Unpinned send library lets LZ Labs OneSig redirect outbound message verification",
        severity: "HIGH",
      }, f);
    }

    // ── Receive library pinning ──────────────────────────────────────────────
    // CRITICAL: inbound message acceptance path is controlled by LZ Labs, not
    // the OFT team. A library upgrade can accept forged messages regardless of
    // DVN config — this trust vector sits below DVN verification in the stack.
    if (route.receiveLibIsDefault === true) {
      const f: Finding = {
        severity: "CRITICAL",
        evidence: "observed",
        check: "Receive Library",
        detail: `${route.chainName}: receive library is the upgradeable default. LZ Labs can change inbound message acceptance rules unilaterally, bypassing DVN config.`,
      };
      pushRoute(f);
      addTIS("pin_receive_library", route.chainName, {
        intent: "pin_receive_library",
        action: "Pin the receive library to a specific version",
        currentState: "Upgradeable default (LZ Labs-controlled)",
        targetState: "Pinned library address immutable to LZ Labs upgrades",
        reason: "Unpinned receive library lets LZ Labs change inbound acceptance rules, bypassing DVN config entirely",
        severity: "CRITICAL",
      }, f);
    }

    // ── Block confirmation mismatch (send < receive required) ────────────────
    // Named for LZ's own section: docs.layerzero.network /v2/developers/evm/configuration/
    // dvn-executor-config#block-confirmation-mismatch — "Messages will be blocked until
    // either the sending OApp has increased the outbound block confirmations, or the
    // receiving OApp decreases the inbound block confirmation threshold." The FAQ and the
    // debugging-messages page both list this mismatch as a cause of the "Blocked" status:
    // "Outbound confirmations must be ≥ inbound confirmations."
    //
    // History, because this rule has been wrong in BOTH directions:
    //   v1 said "permanently blocked" off two integers with no delivery measurement.
    //   v2 (never shipped) DOWNGRADED it to MEDIUM because `sent == delivered` — built on
    //   the DVN-implementer guide (build-dvns step 4: the DVN waits per the RECEIVE
    //   config), which is not the page that governs OApp risk, and on delivery history
    //   that entirely predated the config change (every send landed over a year before
    //   the raised receive-confirmation config existed).
    // The empirical settle: the first message sent AFTER that config change, on a
    // sibling corridor with the same asymmetry, sits BLOCKED on LayerZero Scan —
    // months old when checked.
    // Whatever an individual DVN implementation waits for, the protocol blocks the
    // message. Docs are the oracle; on-chain state is the check; mechanism intuition is
    // neither. This is HIGH per the docs, and delivery evidence may only escalate it.
    if (route.uln && route.receiveUln && route.receiveUln.confirmations > route.uln.confirmations) {
      const c = blockClaim(delivery, route.delivery, "HIGH");
      const f: Finding = {
        severity: c.severity,
        evidence: c.evidence,
        check: "Block Confirmation Mismatch",
        detail: `${route.chainName}: send confirmations (${route.uln.confirmations}) < receive required (${route.receiveUln.confirmations}). LZ integrator docs ("Block Confirmation Mismatch", dvn-executor-config): messages will be blocked until the outbound confirmations are raised or the inbound threshold is lowered. ${c.note}.`,
      };
      pushRoute(f);
      addTIS(`resolve_confirmation_mismatch`, route.chainName, {
        intent: "resolve_confirmation_mismatch",
        action: `Pin confirmations explicitly on BOTH sides; raise send confirmations to at least the destination's ${route.receiveUln.confirmations}`,
        currentState: `Send ${route.uln.confirmations} < receive required ${route.receiveUln.confirmations}`,
        targetState: `Send confirmations ≥ ${route.receiveUln.confirmations}, pinned on both sides`,
        reason: "Send confirmations below the receive threshold block delivery per LZ docs — messages strand until the config is corrected",
        severity: c.severity,
      }, f);
    }
  }

  // ── Enforced options (fleet-wide) ────────────────────────────────────────
  if (missingEnfOpts.length > 0) {
    const f: Finding = {
      severity: "LOW",
      evidence: "observed",
      check: "Enforced Options",
      detail: `No enforced options set on ${missingEnfOpts.length} corridor${missingEnfOpts.length > 1 ? "s" : ""} (${missingEnfOpts.join(", ")}): zero-gas messages can permanently stick channel nonces.`,
    };
    findings.push(f);
    addTIS("set_enforced_options", null, {
      intent: "set_enforced_options",
      action: "Call setEnforcedOptions() with an lzReceive gas floor (≥65k) for each destination EID",
      currentState: `No enforced options on ${missingEnfOpts.length} corridor${missingEnfOpts.length > 1 ? "s" : ""}`,
      targetState: "Enforced lzReceive gas floor on every active corridor",
      reason: "Without enforced options, zero-gas messages can permanently stick channel nonces",
      severity: "LOW",
    }, f);
    tisMap.get("set_enforced_options")!.corridors = [...missingEnfOpts];
  }

  // ── Owner type ───────────────────────────────────────────────────────────
  // On-chain data cannot distinguish an MPC-custodied EOA (e.g. Fireblocks)
  // from a raw hot wallet, so a declared custody type modulates this rule:
  //   fireblocks_mpc → LOW advisory, marked declared-unverified
  //   safe_multisig  → HIGH + mismatch note (a real Safe is a contract, not an EOA)
  //   eoa_hot / unknown / none → HIGH, unchanged
  if (snap.ownerIsContract === false) {
    // The chain observes: the owner address has no bytecode. What it CANNOT observe is
    // who holds the key. A declared MPC custodian (Fireblocks) makes the "single private
    // key" claim unverifiable, so the law caps it at LOW — no hand-written downgrade.
    // A declared Safe is contradicted by chain state (a Safe has bytecode), so that
    // claim stays observed, and stays HIGH.
    const mpcDeclared = custodyDecl?.custodyType === "fireblocks_mpc";
    const mismatch = custodyDecl?.custodyType === "safe_multisig";
    const f: Finding = {
      severity: "HIGH",
      evidence: mpcDeclared ? "unverifiable" : "observed",
      check: "Owner Type",
      detail: mpcDeclared
        ? "owner is EOA on-chain; declared Fireblocks MPC custody (declared, unverified)."
        : mismatch
          ? "OFT owner is an EOA: config can be changed by a single private key. Note: declared Safe multisig custody contradicts chain state (a Safe is a contract, not an EOA)."
          : "OFT owner is an EOA: config can be changed by a single private key.",
      ...(custodyDecl ? { custodyDeclaration: custodyDecl } : {}),
    };
    findings.push(f);
    // No ownership-transfer remediation demanded for declared MPC (advisory only).
    if (!mpcDeclared) {
      addTIS("transfer_ownership_to_multisig", null, {
        intent: "transfer_ownership_to_multisig",
        action: "Transfer OFT ownership to a multisig (e.g. Gnosis Safe)",
        currentState: "EOA owner: single private key controls all configuration",
        targetState: "Multisig owner: M-of-N signers required for config changes",
        reason: "EOA ownership means a single key compromise can alter DVN config, message libraries, or peer addresses",
        severity: "HIGH",
      }, f);
    }
  }

  // ── Proxy upgrade path ───────────────────────────────────────────────────
  // A failed GnosisSafe probe (getThreshold() reverts) does NOT mean the owner is an
  // EOA — timelocks, custom multisigs and governance contracts all revert it while
  // being contracts. Claiming "EOA" on those is an over-assertion of the same class as
  // the Fireblocks/EOA custody false positive: on-chain data cannot see governance.
  // Branch on bytecode, and only say "EOA" when the owner genuinely has none.
  // `proxyAdminOwner` is null when the ProxyAdmin's owner() read itself failed. Never
  // interpolate the raw value: `undefined.slice()` short-circuits to the string
  // "undefined" and ships "Proxy admin owner (undefined...)" into the PDR.
  const owner10 = snap.proxyAdminOwner ? `${snap.proxyAdminOwner.slice(0, 10)}...` : "owner() unreadable";
  if (snap.proxyAdmin !== null && snap.proxyAdminIsMultisig !== true) {
    if (snap.proxyAdminOwnerIsContract === false) {
      // Genuine EOA: no bytecode. A single private key really can upgrade.
      const f: Finding = {
        severity: "HIGH",
        evidence: "observed",
        check: "Proxy Upgrade Control",
        detail: `Proxy admin owner is an EOA (${owner10}): a single key can upgrade the implementation.`,
      };
      findings.push(f);
      addTIS("transfer_proxy_admin_to_multisig", null, {
        intent: "transfer_proxy_admin_to_multisig",
        action: "Transfer proxy admin control to a multisig",
        currentState: `EOA proxy admin (${owner10})`,
        targetState: "Multisig-controlled proxy upgrade path",
        reason: "EOA proxy admin means a single key can upgrade the OFT implementation",
        severity: "HIGH",
      }, f);
    } else if (snap.proxyAdminOwnerIsContract === true) {
      // Contract owner that isn't a recognized Safe (e.g. OZ TimelockController).
      // Strictly better than an EOA. Its governance (proposer set, delay) is not on
      // chain-readable, so the claim is unverifiable and the law caps it at LOW.
      findings.push({
        severity: "HIGH",
        evidence: "unverifiable",
        check: "Proxy Upgrade Control",
        detail: `Proxy admin owner (${owner10}) is a contract but not a recognized Gnosis Safe (e.g. a timelock or custom multisig). Upgrade governance is not verifiable on-chain (unverified).`,
      });
    } else {
      // Bytecode unreadable — never score an unevaluated check (mirrors ULN Unreadable).
      findings.push({
        severity: "UNKNOWN",
        evidence: "unverifiable",
        check: "Proxy Upgrade Control",
        detail: `Proxy admin owner (${owner10}) bytecode could not be read: upgrade control unverifiable on this snapshot (not scored).`,
      });
    }
  }
  // Multisig-controlled proxy is the recommended configuration — no deduction.

  // If every active corridor was unreadable, the posture is unverified — surface
  // one MEDIUM so the OFT reads AT_RISK rather than a false 100/PASS.
  const active = activeRoutes(snap);
  if (active.length > 0 && active.every((r) => !r.uln)) {
    findings.push({
      severity: "MEDIUM",
      evidence: "observed",
      check: "Coverage",
      detail: "All corridors unreadable after retries: security posture cannot be verified.",
    });
  }

  // ── Enforce the evidence law ─────────────────────────────────────────────
  // Single choke point: no rule above can ship a severity its evidence doesn't
  // support. Mutated in place (not mapped to new objects) because the pre-flight
  // simulation below matches findings by object identity.
  for (const f of findings) {
    const capped = capByEvidence(f);
    if (capped.severity !== f.severity) f.severity = capped.severity;
  }

  const riskLevel = deriveRiskLevel(findings);
  // Keep the attested score coherent with AuditRegistry's documented risk bands.
  const score = clampScore(computeScore(findings), riskLevel);

  const SEV_ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, PASS: 4, UNKNOWN: 5 };
  const tis = [...tisMap.values()].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

  // Pre-flight: simulate the post-fix findings set (resolved findings removed,
  // successor findings added) and re-run the exact same deterministic scoring +
  // clamps. Fixing a 1-of-1 thus correctly predicts the 2-of-2 successor state
  // (84/AT_RISK), not a naive deduction reversal (100/PASS).
  for (const [key, intent] of tisMap) {
    const link = tisLinks.get(key);
    const resolved = new Set(link?.resolves ?? []);
    const simulated = findings.filter((f) => !resolved.has(f)).concat(link?.successors ?? []);
    const riskAfter = deriveRiskLevel(simulated);
    const preflight: PreflightResult = {
      scoreBefore: score,
      riskBefore: riskLevel,
      scoreAfter: clampScore(computeScore(simulated), riskAfter),
      riskAfter,
    };
    intent.preflight = preflight;
  }

  return { findings, score, riskLevel, tis };
}
