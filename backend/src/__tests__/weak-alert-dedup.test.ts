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

  // ── The re-ping cadence, and the separation it depends on ────────────────
  //
  // Added 2026-08-09. The cadence shipped claiming "a repeat alerts but does
  // not attest", and nothing asserted it. Worse, the first version of the claim
  // was wrong in a way no test would have caught: the ALERT path itself writes
  // on-chain (a payable AlertBus transaction plus a dust transfer to the OFT
  // owner), so a repeat was still costing gas and still nudging a third party's
  // wallet every interval. These three tests pin all of it.

  it("re-pings an unchanged CRITICAL after the interval, WITHOUT attesting again", async () => {
    vi.stubEnv("REPING_CRITICAL_MINUTES", "1");
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 25, "CRITICAL", []);
    expect(attest).toHaveBeenCalledTimes(1);
    expect(dispatchAlert).toHaveBeenCalledTimes(1);

    // Two minutes later, findings identical.
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 25, "CRITICAL", []);

    expect(dispatchAlert).toHaveBeenCalledTimes(2); // said again
    expect(attest).toHaveBeenCalledTimes(1);        // recorded once
    vi.useRealTimers();
  });

  it("tells the alert path a repeat is a repeat, so it skips the on-chain leg", async () => {
    vi.stubEnv("REPING_CRITICAL_MINUTES", "1");
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 25, "CRITICAL", []);
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 25, "CRITICAL", []);

    // First call is a genuine finding: the chain should hear it.
    expect(dispatchAlert.mock.calls[0][2]).toMatchObject({ isRepeat: false });
    // Second is a reminder: Telegram only. This flag is the only thing standing
    // between a 12-hour cadence and a permanent gas bill on the shared prod
    // instance, where ALERT_BUS_ADDRESS is set.
    expect(dispatchAlert.mock.calls[1][2]).toMatchObject({ isRepeat: true });
    vi.useRealTimers();
  });

  it("holds an AT_RISK finding past the CRITICAL interval", async () => {
    // Same unchanged findings, lower band, so the weekly cadence applies and the
    // twice-daily one must not.
    vi.stubEnv("REPING_CRITICAL_MINUTES", "1");
    vi.stubEnv("REPING_AT_RISK_MINUTES", "10000");
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 60, "AT_RISK", []);
    expect(dispatchAlert).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 60, "AT_RISK", []);
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // ── PASS assets get exactly one signed record ────────────────────────────
  //
  // Added 2026-08-09. The caller's gate carried two exclusions and both were
  // bugs; this is the second. A clean asset never drifts, so the drift producer
  // never fires for it either — while PASS was excluded here too, the two
  // assets scoring 100/100 were the only ones in the fleet with no attestation
  // of any kind, and a registry that records only failures cannot be used to
  // check that a config was read and found sound.

  function passFindings(): Finding[] {
    return [{ severity: "PASS", check: "DVN Count", detail: "2-of-2 DVN", evidence: "observed" }];
  }

  it("attests a PASS asset on first sight, at the band it scored", async () => {
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(), snapshot(), passFindings(), 100, "PASS", []);
    expect(attest).toHaveBeenCalledTimes(1);
    expect(attest.mock.calls[0][3]).toBe(100);
    expect(attest.mock.calls[0][4]).toBe("PASS");
  });

  it("signs a clean asset once and then stays quiet indefinitely", async () => {
    // Not via a special case in the producer: PASS is absent from
    // REPEAT_AFTER_MS, so dueForRepeat is false at any age. A year on, still one
    // write. If someone ever adds a PASS row to that map, this fails.
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(), snapshot(), passFindings(), 100, "PASS", []);
    vi.setSystemTime(new Date(Date.now() + 365 * 24 * 60 * 60_000));
    await o.produceWeakConfigAttestation(watched(), snapshot(), passFindings(), 100, "PASS", []);
    expect(attest).toHaveBeenCalledTimes(1);
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not announce a 100/100 asset as a persistent CRITICAL", async () => {
    // The verdict string is the public feed's `detail` whenever a verdict has no
    // findings to show instead — which is precisely the PASS case. It was
    // hardcoded to CRITICAL back when CRITICAL was the only band that reached
    // this producer.
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(), snapshot(), passFindings(), 100, "PASS", []);
    const v = dispatchAlert.mock.calls[0][0];
    expect(v.verdict).not.toMatch(/CRITICAL/);
    expect(v.verdict).toContain("100/100");
  });

  it("names the band it actually assessed, not the one it was written for", async () => {
    const o = await loadOrchestrator();
    await o.produceWeakConfigAttestation(watched(), snapshot(), findings(), 75, "AT_RISK", []);
    const v = dispatchAlert.mock.calls[0][0];
    expect(v.verdict).toContain("AT_RISK");
    expect(v.verdict).not.toMatch(/CRITICAL/);
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
