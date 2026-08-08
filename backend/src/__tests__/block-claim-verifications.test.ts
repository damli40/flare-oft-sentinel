import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getBlockClaimVerification, recordBlockClaimVerification, stampDelivery,
  ulnFingerprint, blockClaimVerificationsFile, type BlockClaimVerification,
} from "../services/block-claim-verifications.js";
import type { DeliverySnapshot, UlnSnapshot } from "../types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bcv-"));
  vi.stubEnv("DATA_DIR", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const A = "0x589dEDbD617e0CBcB916A9223F4d1300c294236b";
const B = "0x8ddF05F9A5c488b4973897E278B58895bF87Cb24";
const OFT = "0x00000000000000000000000000000000000f1c71"; // synthetic

const uln = (over: Partial<UlnSnapshot> = {}): UlnSnapshot => ({
  confirmations: 15, requiredDVNCount: 2, requiredDVNs: [A, B],
  optionalDVNCount: 0, optionalDVNThreshold: 0, optionalDVNs: [], ...over,
});

const verification = (over: Partial<BlockClaimVerification> = {}): BlockClaimVerification => ({
  sentUnderCurrentConfig: false,
  lastDeliveredBlock: 100,
  deliveredAtVerification: 5,
  sendUlnFingerprint: ulnFingerprint(uln()),
  verifiedAt: Date.now(),
  ...over,
});

describe("worksheet round-trip", () => {
  it("records and reads back, keyed chainId:oft:eid (address lowercased)", () => {
    recordBlockClaimVerification(8453, OFT.toUpperCase().replace("0X", "0x"), 30102, verification());
    const v = getBlockClaimVerification(8453, OFT, 30102);
    expect(v?.sentUnderCurrentConfig).toBe(false);
    expect(getBlockClaimVerification(1, OFT, 30102)).toBeNull();
  });

  it("a missing or malformed file means 'not measured', never a crash", () => {
    expect(getBlockClaimVerification(1, OFT, 30102)).toBeNull();
    writeFileSync(blockClaimVerificationsFile(), "{not json");
    expect(getBlockClaimVerification(1, OFT, 30102)).toBeNull();
  });
});

describe("stampDelivery — the asymmetric validity rule", () => {
  it("stamps UNTESTED (false) while the delivered count is unchanged", () => {
    const d: DeliverySnapshot = { sent: 5, delivered: 5 };
    stampDelivery(d, uln(), verification({ sentUnderCurrentConfig: false, deliveredAtVerification: 5 }));
    expect(d.sentUnderCurrentConfig).toBe(false);
  });

  it("refuses a stale UNTESTED: one new delivery might be the first under the current config", () => {
    const d: DeliverySnapshot = { sent: 6, delivered: 6 };
    stampDelivery(d, uln(), verification({ sentUnderCurrentConfig: false, deliveredAtVerification: 5 }));
    expect(d.sentUnderCurrentConfig).toBeUndefined();
  });

  it("stamps TESTED (true) even after new deliveries — same config only strengthens it", () => {
    const d: DeliverySnapshot = { sent: 9, delivered: 9 };
    stampDelivery(d, uln(), verification({ sentUnderCurrentConfig: true, deliveredAtVerification: 5 }));
    expect(d.sentUnderCurrentConfig).toBe(true);
  });

  it("refuses ANY stamp when the config changed since verification", () => {
    const d: DeliverySnapshot = { sent: 5, delivered: 5 };
    stampDelivery(d, uln({ confirmations: 20 }), verification({ sentUnderCurrentConfig: true }));
    expect(d.sentUnderCurrentConfig).toBeUndefined();
  });

  it("no verification or no uln = no stamp (not measured)", () => {
    const d: DeliverySnapshot = { sent: 5, delivered: 5 };
    stampDelivery(d, null, verification());
    stampDelivery(d, uln(), null);
    expect(d.sentUnderCurrentConfig).toBeUndefined();
  });
});

describe("ulnFingerprint", () => {
  it("is order- and case-insensitive over DVN sets", () => {
    expect(ulnFingerprint(uln({ requiredDVNs: [B, A] })))
      .toBe(ulnFingerprint(uln({ requiredDVNs: [A.toLowerCase(), B.toLowerCase()] })));
  });
  it("changes when confirmations change", () => {
    expect(ulnFingerprint(uln({ confirmations: 20 }))).not.toBe(ulnFingerprint(uln()));
  });
});
