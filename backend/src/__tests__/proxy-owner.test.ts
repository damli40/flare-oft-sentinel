import { describe, it, expect, vi } from "vitest";

vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
  };
});

import { assessSnapshot } from "../services/drift.js";
import type { OftSnapshot } from "../types.js";

// weETH/Base: proxyAdmin.owner() is an OZ TimelockController — a CONTRACT that is
// not a Gnosis Safe (getThreshold() reverts). The engine must not call this an EOA.
const TIMELOCK = "0x851Dd540f4D2Ec78120De0a0cc87B21EdE5Df5C6";
const EOA = "0x1111111111111111111111111111111111111111";
const SAFE = "0x2222222222222222222222222222222222222222";

function snap(over: Partial<OftSnapshot> = {}): OftSnapshot {
  return {
    oft: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A",
    chainId: 8453,
    capturedAt: Date.now(),
    owner: "0x3333333333333333333333333333333333333333",
    ownerIsContract: true,
    proxyAdmin: "0x2F6f3cc4a275C7951FB79199F01eD82421eDFb68",
    proxyAdminOwner: TIMELOCK,
    proxyAdminIsMultisig: false, // getThreshold() reverted
    proxyAdminOwnerIsContract: true, // …but it HAS bytecode
    routes: [],
    ...over,
  };
}

const proxyFindings = (fs: any[]) => fs.filter((f) => f.check === "Proxy Upgrade Control");

describe("assessSnapshot — proxy admin owner classification", () => {
  it("does NOT call a non-Safe CONTRACT owner an EOA (weETH timelock case)", async () => {
    const { findings } = await assessSnapshot(snap(), undefined, null);
    const pf = proxyFindings(findings);
    expect(pf).toHaveLength(1);
    // must not be HIGH, must not claim "EOA"
    expect(pf[0].severity).not.toBe("HIGH");
    expect(pf[0].detail).not.toMatch(/\bEOA\b/i);
    expect(pf[0].detail).not.toMatch(/single (private )?key/i);
    // it is an advisory that names the real, unverifiable situation
    expect(pf[0].severity).toBe("LOW");
    expect(pf[0].detail).toMatch(/contract/i);
  });

  it("still fires HIGH for a REAL EOA proxy admin owner (no bytecode)", async () => {
    const { findings } = await assessSnapshot(
      snap({ proxyAdminOwner: EOA, proxyAdminOwnerIsContract: false }),
      undefined,
      null,
    );
    const pf = proxyFindings(findings);
    expect(pf).toHaveLength(1);
    expect(pf[0].severity).toBe("HIGH");
    expect(pf[0].detail).toMatch(/EOA/i);
  });

  it("emits no proxy finding for a verified Gnosis Safe owner", async () => {
    const { findings } = await assessSnapshot(
      snap({ proxyAdminOwner: SAFE, proxyAdminIsMultisig: true, proxyAdminOwnerIsContract: true }),
      undefined,
      null,
    );
    expect(proxyFindings(findings)).toHaveLength(0);
  });

  it("does not score the check when owner bytecode is unreadable (UNKNOWN, 0 deduction)", async () => {
    const { findings, score } = await assessSnapshot(
      snap({ proxyAdminOwnerIsContract: null }),
      undefined,
      null,
    );
    const pf = proxyFindings(findings);
    expect(pf).toHaveLength(1);
    expect(pf[0].severity).toBe("UNKNOWN");
    expect(score).toBe(100); // UNKNOWN never deducts
  });

  // REGRESSION: `proxyAdminOwner?.slice()` yielded undefined when the owner() read
  // failed, shipping "Proxy admin owner (undefined...)" into the finding and the PDR.
  it("never interpolates the literal string 'undefined' when owner() is unreadable", async () => {
    const { findings } = await assessSnapshot(
      snap({ proxyAdminOwner: null, proxyAdminIsMultisig: null, proxyAdminOwnerIsContract: null }),
      undefined,
      null,
    );
    const pf = proxyFindings(findings);
    expect(pf).toHaveLength(1);
    expect(pf[0].severity).toBe("UNKNOWN");
    expect(pf[0].detail).not.toMatch(/undefined/);
    expect(pf[0].detail).toMatch(/owner\(\) unreadable/);
  });

  it("emits no proxy finding when the OFT is not a proxy", async () => {
    const { findings } = await assessSnapshot(
      snap({ proxyAdmin: null, proxyAdminOwner: null, proxyAdminIsMultisig: null, proxyAdminOwnerIsContract: null }),
      undefined,
      null,
    );
    expect(proxyFindings(findings)).toHaveLength(0);
  });
});
