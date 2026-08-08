import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Finding, OftSnapshot, WatchedOft } from "../types.js";

// The weak-config (persistent CRITICAL, no drift) alert used to dedupe in a
// per-boot Set keyed by address alone. Two production bugs:
//   1. every backend restart re-attested + re-alerted the entire CRITICAL band
//      (real gas, real Telegram spam);
//   2. the same address deployed on two chains shared one dedupe slot.
// The fingerprint store persists in sentinel-state.json and re-fires only when
// the finding set materially changes.

const OFT = "0xCcCc333333333333333333333333333333333333";

const attest = vi.fn().mockResolvedValue({ txHash: "0xtx", attestationId: 7 });
const dispatchAlert = vi.fn().mockResolvedValue("0xalert");

function watched(chainId = 5000): WatchedOft {
  return { ticker: "TESTC", address: OFT, chainId };
}

function snapshot(chainId = 5000): OftSnapshot {
  return {
    oft: OFT,
    chainId,
    capturedAt: 1_700_000_000_000,
    owner: null,
    ownerIsContract: null,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes: [],
  };
}

function findings(detail = "1-of-1 DVN"): Finding[] {
  return [{ severity: "CRITICAL", check: "DVN Count", detail, evidence: "observed" }];
}

let dir: string;

async function loadOrchestrator() {
  vi.doMock("../services/attestor.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../services/attestor.js")>();
    return { ...actual, attest };
  });
  vi.doMock("../services/alerts.js", () => ({ dispatchAlert }));
  vi.doMock("../services/lz-config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../services/lz-config.js")>();
    return {
      ...actual,
      loadDvnMeta: async () => ({ byChain: {}, fetchedAt: 1 }),
      dvnMetaHash: () => "0xmeta",
    };
  });
  return await import("../services/orchestrator.js");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "weak-alert-test-"));
  vi.stubEnv("DATA_DIR", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("../services/attestor.js");
  vi.doUnmock("../services/alerts.js");
  vi.doUnmock("../services/lz-config.js");
  attest.mockClear();
  dispatchAlert.mockClear();
  rmSync(dir, { recursive: true, force: true });
});

describe("produceWeakConfigAttestation dedup", () => {
  it("fires once, then suppresses identical findings within the same boot", async () => {
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 25, "CRITICAL", []);
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 25, "CRITICAL", []);
    expect(attest).toHaveBeenCalledTimes(1);
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
  });

  it("stays suppressed across a restart (fingerprint persisted to DATA_DIR)", async () => {
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 25, "CRITICAL", []);
    expect(attest).toHaveBeenCalledTimes(1);

    vi.resetModules(); // simulate a backend restart — module state gone, disk state kept
    const o2 = await loadOrchestrator();
    await o2.produceWeakConfigAttestation(watched(), snapshot(), findings(), 25, "CRITICAL", []);
    expect(attest).toHaveBeenCalledTimes(1);
  });

  it("re-fires when the finding set materially changes", async () => {
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 25, "CRITICAL", []);
    await o.produceWeakConfigAttestation(
      watched(),
      snapshot(),
      [...findings(), { severity: "HIGH", check: "Owner Type", detail: "owner is an EOA", evidence: "observed" }],
      15,
      "CRITICAL",
      [],
    );
    expect(attest).toHaveBeenCalledTimes(2);
  });

  it("dedupes per chain — the same address on another chain still fires", async () => {
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(5000), snapshot(5000), findings(), 25, "CRITICAL", []);
    await o.produceWeakConfigAttestation(watched(1), snapshot(1), findings(), 25, "CRITICAL", []);
    expect(attest).toHaveBeenCalledTimes(2);
  });
});
