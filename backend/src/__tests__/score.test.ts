import { describe, it, expect } from "vitest";
import { computeScore } from "../services/score.js";
import type { Finding } from "../types.js";

/** A finding of a given severity. `check` defaults to a UNIQUE value per call so a
 *  test that means "several different problems" gets several different problems —
 *  the previous version of this file used one shared check name for every finding,
 *  which is exactly the case scoring gets wrong, so the suite could not see it. */
let n = 0;
const f = (severity: Finding["severity"], check?: string): Finding => ({
  severity,
  evidence: "observed", // scoring is severity-driven; evidence is capped upstream
  check: check ?? `check-${++n}`,
  detail: "test detail",
});

describe("computeScore — distinct checks accumulate", () => {
  it("returns 100 with no findings", () => {
    expect(computeScore([])).toBe(100);
  });

  it("returns 100 for all PASS findings", () => {
    expect(computeScore([f("PASS"), f("PASS"), f("PASS")])).toBe(100);
  });

  it("deducts 40 for one CRITICAL", () => {
    expect(computeScore([f("CRITICAL")])).toBe(60);
  });

  it("deducts 20 for one HIGH", () => {
    expect(computeScore([f("HIGH")])).toBe(80);
  });

  it("deducts 10 for one MEDIUM", () => {
    expect(computeScore([f("MEDIUM")])).toBe(90);
  });

  it("deducts 5 for one LOW", () => {
    expect(computeScore([f("LOW")])).toBe(95);
  });

  it("accumulates across DIFFERENT checks", () => {
    // CRITICAL(40) + HIGH(20) + MEDIUM(10) + LOW(5) = 75 deducted → 25
    expect(computeScore([f("CRITICAL"), f("HIGH"), f("MEDIUM"), f("LOW")])).toBe(25);
  });

  it("floors at 0 when distinct problems are catastrophic", () => {
    expect(computeScore([f("CRITICAL"), f("CRITICAL"), f("CRITICAL")])).toBe(0);
  });

  it("ignores PASS alongside real findings", () => {
    expect(computeScore([f("PASS"), f("HIGH"), f("PASS")])).toBe(80);
  });
});

describe("computeScore — the same check repeated counts ONCE", () => {
  it("does not punish a wide deployment for being wide", () => {
    // The measured six-corridor case, taken from a widely-deployed OFT: each
    // corridor raised the same two advisories, both of them LayerZero defaults.
    // Summing gave −120 → 0. One deduction per check gives 80.
    const findings: Finding[] = [];
    for (const corridor of ["optimism", "arbitrum", "bsc", "polygon", "ethereum", "avalanche"]) {
      findings.push({ severity: "MEDIUM", evidence: "observed", check: "DVN Count", detail: `${corridor}: 2 effective DVNs` });
      findings.push({ severity: "MEDIUM", evidence: "observed", check: "Confirmations", detail: `${corridor}: 10 block confirmations` });
    }
    expect(findings).toHaveLength(12);
    expect(computeScore(findings)).toBe(80);
  });

  it("scores a 1-corridor and a 10-corridor OFT the same for the same worst state", () => {
    const one: Finding[] = [{ severity: "MEDIUM", evidence: "observed", check: "DVN Count", detail: "a: 2 DVNs" }];
    const ten: Finding[] = Array.from({ length: 10 }, (_, i) => ({
      severity: "MEDIUM" as const, evidence: "observed" as const, check: "DVN Count", detail: `c${i}: 2 DVNs`,
    }));
    expect(computeScore(one)).toBe(computeScore(ten));
    expect(computeScore(ten)).toBe(90);
  });

  it("takes the WORST severity, so breadth cannot mask depth", () => {
    // Five benign corridors plus one genuinely single-verifier corridor. The
    // CRITICAL must drive the deduction, not the five MEDIUMs.
    const findings: Finding[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        severity: "MEDIUM" as const, evidence: "observed" as const, check: "DVN Count", detail: `c${i}: 2 DVNs`,
      })),
      { severity: "CRITICAL", evidence: "observed", check: "DVN Count", detail: "c5: 1 effective DVN" },
    ];
    expect(computeScore(findings)).toBe(60); // 100 − 40, not 100 − 50
  });

  it("worst severity wins regardless of order", () => {
    const worstFirst: Finding[] = [
      { severity: "CRITICAL", evidence: "observed", check: "DVN Count", detail: "x" },
      { severity: "MEDIUM", evidence: "observed", check: "DVN Count", detail: "y" },
    ];
    const worstLast = [...worstFirst].reverse();
    expect(computeScore(worstFirst)).toBe(60);
    expect(computeScore(worstLast)).toBe(60);
  });

  it("distinguishes six-benign from one-severe-plus-five-benign (both floored to 0 before)", () => {
    const sixBenign: Finding[] = Array.from({ length: 6 }, (_, i) => ({
      severity: "MEDIUM" as const, evidence: "observed" as const, check: "DVN Count", detail: `c${i}`,
    }));
    const oneSevere: Finding[] = [
      ...sixBenign.slice(0, 5),
      { severity: "CRITICAL", evidence: "observed", check: "DVN Count", detail: "c5" },
    ];
    expect(computeScore(sixBenign)).toBe(90);
    expect(computeScore(oneSevere)).toBe(60);
    expect(computeScore(sixBenign)).not.toBe(computeScore(oneSevere));
  });

  it("a PASS instance never cancels a real instance of the same check", () => {
    const findings: Finding[] = [
      { severity: "PASS", evidence: "observed", check: "DVN Count", detail: "clean corridor" },
      { severity: "HIGH", evidence: "observed", check: "DVN Count", detail: "bad corridor" },
    ];
    expect(computeScore(findings)).toBe(80);
  });
});
