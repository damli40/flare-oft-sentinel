import { describe, it, expect } from "vitest";
import { assessSnapshot, RULES_VERSION } from "../services/drift.js";
import type { CustodyDeclaration, Finding, OftSnapshot } from "../types.js";

// Minimal snapshot: EOA owner, no routes — isolates the Owner Type rule.
const eoaOwnedSnapshot = (): OftSnapshot => ({
  oft: "0x1111111111111111111111111111111111111111",
  chainId: 5000,
  capturedAt: 1,
  owner: "0x2222222222222222222222222222222222222222",
  ownerIsContract: false,
  proxyAdmin: null,
  proxyAdminOwner: null,
  proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
  routes: [],
});

const declaration = (custodyType: CustodyDeclaration["custodyType"]): CustodyDeclaration => ({
  custodyType,
  declaredBy: "oft team (relayed)",
  declaredAt: "2026-07-07",
  verified: false,
});

const ownerFinding = (findings: Finding[]) =>
  findings.find((f) => f.check === "Owner Type");

describe("Owner Type rule with custody declarations", () => {
  it("keeps HIGH when no declaration exists (behavior unchanged)", async () => {
    const { findings } = await assessSnapshot(eoaOwnedSnapshot(), undefined, null);
    const f = ownerFinding(findings);
    expect(f).toBeDefined();
    expect(f!.severity).toBe("HIGH");
    expect(f!.detail).toBe("OFT owner is an EOA: config can be changed by a single private key.");
  });

  it("keeps HIGH when eoa_hot is declared", async () => {
    const decl = declaration("eoa_hot");
    const { findings } = await assessSnapshot(eoaOwnedSnapshot(), undefined, decl);
    const f = ownerFinding(findings);
    expect(f!.severity).toBe("HIGH");
    expect(f!.custodyDeclaration).toEqual(decl);
  });

  it("downgrades HIGH to LOW advisory when fireblocks_mpc is declared", async () => {
    const decl = declaration("fireblocks_mpc");
    const { findings, riskLevel, score, tis } = await assessSnapshot(eoaOwnedSnapshot(), undefined, decl);
    const f = ownerFinding(findings);
    expect(f!.severity).toBe("LOW");
    expect(f!.detail).toBe("owner is EOA on-chain; declared Fireblocks MPC custody (declared, unverified).");
    // Determinism: the declaration that influenced the verdict is embedded in the PDR finding.
    expect(f!.custodyDeclaration).toEqual(decl);
    // LOW is advisory: band stays PASS, only the -5 LOW deduction applies.
    expect(riskLevel).toBe("PASS");
    expect(score).toBe(95);
    // Advisory finding carries no ownership-transfer remediation demand.
    expect(tis.find((t) => t.intent === "transfer_ownership_to_multisig")).toBeUndefined();
  });

  it("keeps HIGH with a mismatch note when safe_multisig is declared but owner reads EOA", async () => {
    const decl = declaration("safe_multisig");
    const { findings } = await assessSnapshot(eoaOwnedSnapshot(), undefined, decl);
    const f = ownerFinding(findings);
    expect(f!.severity).toBe("HIGH");
    expect(f!.detail).toContain("declared Safe multisig custody contradicts chain state");
    expect(f!.custodyDeclaration).toEqual(decl);
  });

  it("treats an unknown declaration like no declaration (HIGH)", async () => {
    const decl = declaration("unknown");
    const { findings } = await assessSnapshot(eoaOwnedSnapshot(), undefined, decl);
    expect(ownerFinding(findings)!.severity).toBe("HIGH");
  });

  it("does not fire Owner Type at all when the owner is a contract, declaration or not", async () => {
    const snap = { ...eoaOwnedSnapshot(), ownerIsContract: true };
    const { findings } = await assessSnapshot(snap, undefined, declaration("fireblocks_mpc"));
    expect(ownerFinding(findings)).toBeUndefined();
  });
});

// rulesVersion is asserted in evidence.test.ts (single source of truth).
