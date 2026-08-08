import { describe, it, expect, vi } from "vitest";

// assessSnapshot / detectDrift call loadDvnMeta() (network). Stub only that,
// keeping the real isDeadDvn / resolveDvn / isDvnDeprecated so the dead-DVN
// detection under test runs for real. The dead-address check (0x…dEaD / zero)
// is address-based and needs no metadata, so an empty meta is sufficient here.
vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
  };
});

import { assessSnapshot, detectDrift } from "../services/drift.js";
import { isDeadDvn } from "../services/lz-config.js";
import type { OftSnapshot, RouteSnapshot, UlnSnapshot } from "../types.js";

const DEAD = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";
const REAL_DVN = "0x589dEDbD617e0CBcB916A9223F4d1300c294236b"; // LZ Labs DVN (arbitrary real addr)

function uln(over: Partial<UlnSnapshot> = {}): UlnSnapshot {
  return {
    confirmations: 64,
    requiredDVNCount: 1,
    requiredDVNs: [DEAD],
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    optionalDVNs: [],
    ...over,
  };
}

function route(over: Partial<RouteSnapshot> = {}): RouteSnapshot {
  return {
    eid: 30303,
    chainName: "zircuit",
    chainKey: "zircuit",
    sendLibrary: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2",
    sendLibIsDefault: true,
    receiveLibrary: "0x0000000000000000000000000000000000000001",
    receiveLibIsDefault: true,
    uln: uln(),
    receiveUln: null,
    peer: "0x88A19F30E1254B37b66899893ab1F73aD82BD2C3",
    peerAddress: "0x88A19F30E1254B37b66899893ab1F73aD82BD2C3",
    hasEnforcedOptions: null,
    isActive: true,
    ...over,
  };
}

function snap(routes: RouteSnapshot[]): OftSnapshot {
  return {
    oft: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", // weETH on Base
    chainId: 8453,
    capturedAt: Date.now(),
    owner: "0x0000000000000000000000000000000000000002",
    ownerIsContract: true,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes,
  };
}

// LZ deploys a distinct dead-DVN contract per chain; none of them is 0x…dEaD.
const BASE_LZ_DEAD_DVN = "0x6498b0632F3834D7647367334838111c8C889703";
const ETH_LZ_DEAD_DVN = "0x747C741496a507E4B404b50463e691A8d692f6Ac";

describe("isDeadDvn", () => {
  const meta = { byChain: {}, deadByChain: {}, fetchedAt: Date.now() };
  it("treats the 0x…dEaD burn address as dead (case-insensitive)", () => {
    expect(isDeadDvn(DEAD, "base", meta)).toBe(true);
    expect(isDeadDvn(DEAD.toLowerCase(), "base", meta)).toBe(true);
  });
  it("treats the zero address as dead", () => {
    expect(isDeadDvn(ZERO, "base", meta)).toBe(true);
  });
  it("treats a metadata-flagged 'LZ Dead DVN' as dead on the chain it is dead on", () => {
    const m = { byChain: {}, deadByChain: { base: new Set([REAL_DVN.toLowerCase()]) }, fetchedAt: Date.now() };
    expect(isDeadDvn(REAL_DVN, "base", m)).toBe(true);
  });
  it("does NOT treat a real DVN as dead", () => {
    expect(isDeadDvn(REAL_DVN, "base", meta)).toBe(false);
  });

  // Per-chain dead DVNs must be caught by ADDRESS (deployments API), not by name —
  // metadata canonicalName must never be the only thing standing between a dead
  // pathway and a false CRITICAL.
  it("catches a per-chain LZ dead DVN by address with NO name metadata at all", () => {
    const m = {
      byChain: {},
      deadByChain: {
        base: new Set([BASE_LZ_DEAD_DVN.toLowerCase()]),
        ethereum: new Set([ETH_LZ_DEAD_DVN.toLowerCase()]),
      },
      fetchedAt: Date.now(),
    };
    expect(isDeadDvn(BASE_LZ_DEAD_DVN, "base", m)).toBe(true);
    expect(isDeadDvn(ETH_LZ_DEAD_DVN, "ethereum", m)).toBe(true);
    // and still not a real DVN
    expect(isDeadDvn(REAL_DVN, "base", m)).toBe(false);
  });

  // ⚠️ INVERTED in rules 3.0.0. This test previously asserted the OPPOSITE:
  //
  //     it("catches a per-chain dead DVN even when the chainKey is wrong (cross-chain union)")
  //     // "Dead detection is an ADDRESS union across all chains, so it must survive a
  //     //  wrong or missing chainKey."
  //
  // That was reasoning, not observation, and it was wrong. The live LZ DVN metadata carries
  // 14 addresses that are an LZDeadDVN placeholder on one chain and a REAL, LIVE DVN on
  // another. The flat union therefore classified a genuine 1-of-1 as an "unconfigured dead
  // pathway" and SUPPRESSED its CRITICAL — silencing the very single-point-of-failure
  // shape the Dead Pathway rule was written to preserve. Real instances:
  //
  //   0x28b6140e…  dead on flare,          "LayerZero Labs" on mantle (our primary chain)
  //   0x6788f524…  dead on 40 chains,      "LayerZero Labs" on 32 others
  //   0x282b3386…  dead on space/humanity, live on 36 incl. unichain, sonic, bera
  //
  // Dead detection is per-chain. Only universal burn/zero addresses are chain-independent.
  // scripts/verify-dvn-invariants.ts re-derives these from the live feed so this comment
  // cannot quietly become false again.
  it("does NOT treat a dead placeholder from another chain as dead here", () => {
    const m = { byChain: {}, deadByChain: { base: new Set([BASE_LZ_DEAD_DVN.toLowerCase()]) }, fetchedAt: Date.now() };
    expect(isDeadDvn(BASE_LZ_DEAD_DVN, "base", m)).toBe(true);
    // Same address, different chain: on mantle it is not a known placeholder. Calling it
    // dead here is exactly how a real CRITICAL gets suppressed.
    expect(isDeadDvn(BASE_LZ_DEAD_DVN, "mantle", m)).toBe(false);
  });

  it("fails closed without a chainKey: a placeholder is indistinguishable from a live DVN", () => {
    const m = { byChain: {}, deadByChain: { base: new Set([BASE_LZ_DEAD_DVN.toLowerCase()]) }, fetchedAt: Date.now() };
    expect(isDeadDvn(BASE_LZ_DEAD_DVN, null, m)).toBe(false);
    // …but a universal burn address needs no chain context.
    expect(isDeadDvn(DEAD, null, m)).toBe(true);
  });
});

describe("assessSnapshot — dead / unconfigured pathway", () => {
  it("weETH Base→Zircuit (all-dead required set) is a LOW advisory, not CRITICAL", async () => {
    const { findings, score, riskLevel } = await assessSnapshot(snap([route()]), undefined, null);

    // No CRITICAL from an unconfigured placeholder pathway.
    expect(findings.some((f) => f.severity === "CRITICAL")).toBe(false);
    // One visible advisory naming the dead pathway.
    const advisory = findings.find((f) => f.check === "Dead Pathway");
    expect(advisory).toBeDefined();
    expect(advisory!.severity).toBe("LOW");
    // LOW doesn't flip the band; a lone dead pathway is PASS with a −5 advisory.
    expect(riskLevel).toBe("PASS");
    expect(score).toBe(95);
  });

  it("still fires CRITICAL for a REAL single DVN (single-DVN pattern preserved)", async () => {
    const r = route({
      uln: uln({ requiredDVNs: [REAL_DVN] }),
      sendLibIsDefault: false,
      receiveLibIsDefault: false,
    });
    const { findings, riskLevel } = await assessSnapshot(snap([r]), undefined, null);

    expect(riskLevel).toBe("CRITICAL");
    expect(findings.some((f) => f.check === "DVN Count" && f.severity === "CRITICAL")).toBe(true);
    expect(findings.some((f) => f.check === "Dead Pathway")).toBe(false);
  });

  it("does NOT classify a mixed set (one real + one dead DVN) as a dead pathway", async () => {
    const r = route({
      uln: uln({ requiredDVNCount: 2, requiredDVNs: [REAL_DVN, DEAD] }),
    });
    const { findings } = await assessSnapshot(snap([r]), undefined, null);
    // A functional DVN remains → not the untouched placeholder → no dead-pathway advisory.
    expect(findings.some((f) => f.check === "Dead Pathway")).toBe(false);
  });
});

describe("detectDrift — new dead pathway does not drift", () => {
  it("a newly-appearing all-dead route is not flagged as a new 1-of-1", async () => {
    const prev = snap([]); // no routes previously
    const next = snap([route()]); // new all-dead zircuit route
    const drift = await detectDrift(prev, next);
    expect(drift.reasons.some((r) => /1-of-1|single point/i.test(r))).toBe(false);
    expect(drift.drifted).toBe(false);
  });
});
