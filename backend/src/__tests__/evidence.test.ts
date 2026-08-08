import { describe, it, expect, vi } from "vitest";

vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
  };
});

import { assessSnapshot, capByEvidence, RULES_VERSION } from "../services/drift.js";
import type { Finding, OftSnapshot } from "../types.js";

const REAL_DVN = "0x589dEDbD617e0CBcB916A9223F4d1300c294236b";
const NETHERMIND = "0x4444444444444444444444444444444444444444";
const TIMELOCK = "0x851Dd540f4D2Ec78120De0a0cc87B21EdE5Df5C6";
const EOA = "0x1111111111111111111111111111111111111111";

function snap(over: Partial<OftSnapshot> = {}): OftSnapshot {
  return {
    oft: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A",
    chainId: 8453,
    capturedAt: Date.now(),
    owner: "0x3333333333333333333333333333333333333333",
    ownerIsContract: true,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes: [],
    ...over,
  };
}

const f = (severity: Finding["severity"], evidence: Finding["evidence"]): Finding => ({
  severity,
  evidence,
  check: "test",
  detail: "d",
});

describe("rulesVersion", () => {
  // 4.0.0 was MAJOR: receive-side scoring, subset deliverability, liveness gate.
  // 4.1.0 is the corrected delivery law: delivery evidence (historical) may never soften
  // a config-derived block claim (current) — it only escalates (STRANDING), contradicts
  // (sensor flag), or annotates (UNTESTED/UNUSED/UNKNOWN keep config severity). Also
  // renames Confirmation Asymmetry → Block Confirmation Mismatch (LZ docs' own name) and
  // scores it HIGH per those docs. Minor, not major: no quorum semantics change, but
  // severities on delivery-gated findings move UP on real assets — fleet A/B required
  // before this ships (START HERE item 4).
  // 5.0.0 is MAJOR because the meaning of a SCORE changed, while no rule did.
  // computeScore deducts once per distinct check at its worst severity instead of
  // once per finding. Findings are raised per route, so the old sum measured how
  // many corridors an OFT has as much as how exposed it is: a widely-deployed OFT
  // scored 0/100 on six corridors carrying the same two LayerZero-default
  // advisories (a 2-of-2 required DVN set, 10 confirmations), which is 80 read
  // honestly — the deployment was wide, not weak. Nothing was
  // added, removed or re-labelled — but scores do NOT compare across this
  // boundary, and attestations already signed keep their own version. That
  // incomparability is the whole reason the major digit moves.
  it("is 5.0.0 — one deduction per check: breadth of deployment is not depth of risk", () => {
    expect(RULES_VERSION).toBe("5.0.0");
  });
});

// THE LAW: CRITICAL/HIGH require observed. inferred caps at MEDIUM. unverifiable caps at LOW.
describe("capByEvidence — the law", () => {
  it("observed passes every severity through untouched", () => {
    expect(capByEvidence(f("CRITICAL", "observed")).severity).toBe("CRITICAL");
    expect(capByEvidence(f("HIGH", "observed")).severity).toBe("HIGH");
    expect(capByEvidence(f("LOW", "observed")).severity).toBe("LOW");
  });

  it("inferred can never be CRITICAL or HIGH — caps at MEDIUM", () => {
    expect(capByEvidence(f("CRITICAL", "inferred")).severity).toBe("MEDIUM");
    expect(capByEvidence(f("HIGH", "inferred")).severity).toBe("MEDIUM");
    // does not RAISE a weaker finding
    expect(capByEvidence(f("LOW", "inferred")).severity).toBe("LOW");
  });

  it("unverifiable can never exceed LOW", () => {
    expect(capByEvidence(f("CRITICAL", "unverifiable")).severity).toBe("LOW");
    expect(capByEvidence(f("HIGH", "unverifiable")).severity).toBe("LOW");
    expect(capByEvidence(f("MEDIUM", "unverifiable")).severity).toBe("LOW");
  });

  it("never raises PASS or UNKNOWN", () => {
    expect(capByEvidence(f("UNKNOWN", "unverifiable")).severity).toBe("UNKNOWN");
    expect(capByEvidence(f("PASS", "inferred")).severity).toBe("PASS");
  });
});

// FALSIFIABILITY TEST (advisor): the hand-written downgrades must fall out of the law
// for free. If a rule has to special-case severity, the law is wrong.
describe("the three hand-written downgrades fall out of the law", () => {
  it("Fireblocks MPC: EOA owner + declared MPC → unverifiable → LOW (was a special case)", async () => {
    const { findings } = await assessSnapshot(
      snap({ ownerIsContract: false }),
      undefined,
      { custodyType: "fireblocks_mpc", declaredBy: "t", declaredAt: "2026-07-01", verified: false },
    );
    const owner = findings.find((x) => x.check === "Owner Type")!;
    expect(owner.evidence).toBe("unverifiable");
    expect(owner.severity).toBe("LOW");
  });

  it("undeclared EOA owner is OBSERVED → stays HIGH (real teeth preserved)", async () => {
    const { findings } = await assessSnapshot(snap({ ownerIsContract: false }), undefined, null);
    const owner = findings.find((x) => x.check === "Owner Type")!;
    expect(owner.evidence).toBe("observed");
    expect(owner.severity).toBe("HIGH");
  });

  it("declared Safe contradicted by chain state is OBSERVED → stays HIGH", async () => {
    const { findings } = await assessSnapshot(
      snap({ ownerIsContract: false }),
      undefined,
      { custodyType: "safe_multisig", declaredBy: "t", declaredAt: "2026-07-01", verified: false },
    );
    const owner = findings.find((x) => x.check === "Owner Type")!;
    expect(owner.evidence).toBe("observed");
    expect(owner.severity).toBe("HIGH");
  });

  it("Timelock proxy owner: contract, not a Safe → unverifiable → LOW (was a special case)", async () => {
    const { findings } = await assessSnapshot(
      snap({ proxyAdmin: "0x2F6f3cc4a275C7951FB79199F01eD82421eDFb68", proxyAdminOwner: TIMELOCK, proxyAdminIsMultisig: false, proxyAdminOwnerIsContract: true }),
      undefined,
      null,
    );
    const p = findings.find((x) => x.check === "Proxy Upgrade Control")!;
    expect(p.evidence).toBe("unverifiable");
    expect(p.severity).toBe("LOW");
    expect(p.detail).not.toMatch(/\bEOA\b/i);
  });

  it("genuine EOA proxy owner (no bytecode) is OBSERVED → stays HIGH", async () => {
    const { findings } = await assessSnapshot(
      snap({ proxyAdmin: "0x2F6f3cc4a275C7951FB79199F01eD82421eDFb68", proxyAdminOwner: EOA, proxyAdminIsMultisig: false, proxyAdminOwnerIsContract: false }),
      undefined,
      null,
    );
    const p = findings.find((x) => x.check === "Proxy Upgrade Control")!;
    expect(p.evidence).toBe("observed");
    expect(p.severity).toBe("HIGH");
  });
});

// A protocol running its own DVN is additive security, not a defect.
describe("Self-DVN is a plus, not a flaw", () => {
  const selfDvnRoute = (dvns: string[]) => ({
    eid: 30101, chainName: "ethereum", chainKey: "ethereum",
    sendLibrary: "0x1", sendLibIsDefault: false,
    receiveLibrary: "0x2", receiveLibIsDefault: false,
    uln: { confirmations: 64, requiredDVNCount: dvns.length, requiredDVNs: dvns, optionalDVNCount: 0, optionalDVNThreshold: 0, optionalDVNs: [] },
    receiveUln: null, peer: "0x3", peerAddress: "0x3",
    hasEnforcedOptions: true, isActive: true,
  }) as any;

  // Identification is a curated ticker → operator-`id` allowlist, resolved PER CHAIN.
  // The snapshot's chainId is 8453, so the engine derives srcChainKey "base" and looks
  // the DVN up in byChain.base. "usdt0" / "ccip" are real ids published by LZ.
  const withMeta = async (entries: Record<string, { name: string; id: string }>) => {
    const byChain = {
      base: Object.fromEntries(
        Object.entries(entries).map(([addr, v]) => [addr.toLowerCase(), { name: v.name, deprecated: false, id: v.id }]),
      ),
    };
    vi.resetModules();
    vi.doMock("../services/lz-config.js", async (importActual) => {
      const actual = await importActual<typeof import("../services/lz-config.js")>();
      return {
        ...actual,
        loadDvnMeta: vi.fn(async () => ({ byChain, deadByChain: {}, fetchedAt: Date.now() })),
      };
    });
    return (await import("../services/drift.js")).assessSnapshot;
  };

  const NETH = { name: "Nethermind", id: "nethermind" };

  it("does not deduct score and is not a LOW", async () => {
    const assess = await withMeta({ [REAL_DVN]: { name: "USDT0", id: "usdt0" }, [NETHERMIND]: NETH });
    const { findings } = await assess(snap({ routes: [selfDvnRoute([REAL_DVN, NETHERMIND])] }), "USDT0", null);
    const self = findings.find((x: Finding) => x.check === "Self-DVN");
    expect(self).toBeDefined();
    expect(self!.severity).toBe("PASS"); // zero deduction
    expect(self!.severity).not.toBe("LOW");
    expect(self!.detail).toMatch(/additive/i);
  });

  // REGRESSION: ticker "O" is a substring of "layerzero labs". The old name-substring
  // matcher credited the O protocol with operating LayerZero's own DVN.
  it("does NOT credit a one-letter ticker that is a substring of another operator's name", async () => {
    const assess = await withMeta({ [REAL_DVN]: { name: "LayerZero Labs", id: "layerzero-labs" }, [NETHERMIND]: NETH });
    const { findings } = await assess(snap({ routes: [selfDvnRoute([REAL_DVN, NETHERMIND])] }), "O", null);
    expect(findings.find((x: Finding) => x.check === "Self-DVN")).toBeUndefined();
  });

  // The allowlist is directional: ccip is self-operated for LINK, third-party for others.
  it("credits ccip to LINK but not to a protocol that merely uses Chainlink's DVN", async () => {
    const entries = { [REAL_DVN]: { name: "Chainlink", id: "ccip" }, [NETHERMIND]: NETH };
    const route = () => [selfDvnRoute([REAL_DVN, NETHERMIND])];

    let assess = await withMeta(entries);
    expect((await assess(snap({ routes: route() }), "LINK", null)).findings.find((x: Finding) => x.check === "Self-DVN")).toBeDefined();

    assess = await withMeta(entries);
    expect((await assess(snap({ routes: route() }), "OTHERTKN", null)).findings.find((x: Finding) => x.check === "Self-DVN")).toBeUndefined();
  });

  it("an unlisted protocol gets no credit rather than a wrong one", async () => {
    const assess = await withMeta({ [REAL_DVN]: NETH, [NETHERMIND]: { name: "Horizen", id: "horizen-labs" } });
    const { findings } = await assess(snap({ routes: [selfDvnRoute([REAL_DVN, NETHERMIND])] }), "SOMETOKEN", null);
    expect(findings.find((x: Finding) => x.check === "Self-DVN")).toBeUndefined();
  });

  // The 276-address collision: `0x3b0531…` is usdt0 on ethereum, nansen on optimism.
  // Looking USDT0's own DVN up under the WRONG chain must not credit it.
  it("does not credit a self-DVN resolved against the wrong chain's table", async () => {
    vi.resetModules();
    vi.doMock("../services/lz-config.js", async (importActual) => {
      const actual = await importActual<typeof import("../services/lz-config.js")>();
      return {
        ...actual,
        // The id lives under "ethereum"; the snapshot's chain is base (8453).
        loadDvnMeta: vi.fn(async () => ({
          byChain: { ethereum: { [REAL_DVN.toLowerCase()]: { name: "USDT0", deprecated: false, id: "usdt0" } } },
          deadByChain: {},
          fetchedAt: Date.now(),
        })),
      };
    });
    const { assessSnapshot: assess } = await import("../services/drift.js");
    const { findings } = await assess(snap({ routes: [selfDvnRoute([REAL_DVN, NETHERMIND])] }), "USDT0", null);
    expect(findings.find((x: Finding) => x.check === "Self-DVN")).toBeUndefined();
  });
});

// The anti-laundering guarantee: no rule can emit a CRITICAL it did not observe.
describe("structural guarantee", () => {
  it("every CRITICAL/HIGH finding the engine can emit carries evidence:observed", async () => {
    const route = {
      eid: 30101, chainName: "ethereum", chainKey: "ethereum",
      sendLibrary: "0x1", sendLibIsDefault: true,
      receiveLibrary: "0x2", receiveLibIsDefault: true,
      uln: { confirmations: 2, requiredDVNCount: 1, requiredDVNs: [REAL_DVN], optionalDVNCount: 0, optionalDVNThreshold: 0, optionalDVNs: [] },
      receiveUln: null, peer: "0x3", peerAddress: "0x3",
      hasEnforcedOptions: false, isActive: true, rpcConflict: true,
    } as any;
    const { findings } = await assessSnapshot(
      snap({ routes: [route], ownerIsContract: false, proxyAdmin: "0xA", proxyAdminOwner: EOA, proxyAdminIsMultisig: false, proxyAdminOwnerIsContract: false }),
      undefined,
      null,
    );
    const strong = findings.filter((x) => x.severity === "CRITICAL" || x.severity === "HIGH");
    expect(strong.length).toBeGreaterThan(0);
    for (const x of strong) expect(x.evidence).toBe("observed");
  });

  it("every finding carries an evidence tag", async () => {
    const { findings } = await assessSnapshot(snap({ ownerIsContract: false }), undefined, null);
    for (const x of findings) expect(["observed", "inferred", "unverifiable"]).toContain(x.evidence);
  });
});
