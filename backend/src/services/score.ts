import type { Finding } from "../types.js";

const DEDUCTIONS: Record<string, number> = {
  CRITICAL: 40,
  HIGH: 20,
  MEDIUM: 10,
  LOW: 5,
  PASS: 0,
  UNKNOWN: 0,
};

/**
 * One deduction per distinct CHECK, at that check's worst observed severity.
 *
 * The previous version summed every finding. Findings are pushed PER ROUTE, so a
 * single uniform condition was deducted once per corridor and the score measured
 * breadth of deployment rather than depth of risk. Measured on ZRO/Base
 * 2026-07-29: six corridors, each raising the same two advisories —
 *
 *     2 effective DVNs (LayerZero Labs, Google) — minimal redundancy   MEDIUM × 6 = −60
 *     10 block confirmations (< 15, reorg risk)                        MEDIUM × 6 = −60
 *                                                                      → −120, floored to 0
 *
 * ZRO is configured to LayerZero's own defaults, verified by LayerZero Labs and
 * Google, and scored 0/100. Deduplicated it scores 80: two minor advisories,
 * uniformly applied. That is the honest reading.
 *
 * This is not a new idea in this file's neighbourhood — `drift.ts` already says
 * it, for exactly one finding type:
 *
 *     // Collected per route, emitted as ONE fleet-wide LOW finding after the loop —
 *     // a per-corridor deduction would let a low-severity advisory (−5 × N routes)
 *     // outweigh a CRITICAL on wide deployments.
 *
 * That reasoning was right and was never generalised. Enforced options were
 * aggregated; DVN Count, Confirmations, and the library checks were not. Doing it
 * here covers every check at once, including any added later, instead of relying
 * on each new rule remembering to aggregate itself.
 *
 * WORST severity per check, not first or last, so breadth can never mask depth:
 * five corridors at 2-of-2 plus one genuinely at 1-of-1 deducts the CRITICAL, not
 * the MEDIUM. That also restores a distinction the summing version had lost
 * entirely — "six benign" and "one exploitable plus five benign" both floored at
 * 0, so the number could not tell them apart. It now scores the same as a
 * single-corridor OFT in the same worst state, which is the point: a ten-corridor
 * OFT is not more dangerous for having ten corridors.
 *
 * How many corridors are affected is still real information. It belongs in the
 * finding's `detail`, which names them, not multiplied into the score.
 *
 * ⚠️ Scores computed here are NOT comparable to scores from RULES_VERSION < 5.0.0.
 * Attestations already signed on-chain keep their original numbers and their
 * original rules version; that is what the version field is for.
 */
export function computeScore(findings: Finding[]): number {
  const worstByCheck = new Map<string, number>();
  for (const f of findings) {
    const deduction = DEDUCTIONS[f.severity] ?? 0;
    const previous = worstByCheck.get(f.check);
    if (previous === undefined || deduction > previous) {
      worstByCheck.set(f.check, deduction);
    }
  }

  let total = 100;
  for (const deduction of worstByCheck.values()) total -= deduction;
  return Math.max(0, total);
}
