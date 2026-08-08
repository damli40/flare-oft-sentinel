import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { DeliverySnapshot, UlnSnapshot } from "../types.js";

// ── The UNTESTED discriminator's worksheet ────────────────────────────────────
// Answers one question per corridor: was the CURRENT send-ULN config already in
// force at the block of the last DELIVERED message? If not, every delivery the
// nonce accounting can see predates the config we score — history that must never
// soften a block claim (the stale-evidence lesson: sent == delivered, all of it
// long before the config existed, and the first post-change send is BLOCKED).
//
// Produced ONLY by scripts/verify-block-claims.ts (archival eth_calls, run on the
// handful of corridors that already carry a block-class finding — never fleet-wide).
// Consumed by readSnapshot, which stamps route.delivery.sentUnderCurrentConfig so
// drift.ts can say "UNTESTED" / "contradiction" instead of "unverified".
//
// Operator-input file on DATA_DIR (custody-declarations pattern): local/volume only,
// gitignored, absence is normal — every consumer must treat "no entry" as "not
// measured", never as a default answer.

export interface BlockClaimVerification {
  /** true = the last delivered message crossed under the config we score now. */
  sentUnderCurrentConfig: boolean;
  /** Source-chain block of the last DELIVERED send this was verified against. */
  lastDeliveredBlock: number | null;
  /** outbound `delivered` count at verification time — see validity rule below. */
  deliveredAtVerification: number;
  /** Fingerprint of the send-ULN config at verification time — see validity rule. */
  sendUlnFingerprint: string;
  verifiedAt: number;
  /** Human trail: how it was measured (RPC used, scan message, etc.). */
  note?: string;
}

export function ulnFingerprint(uln: UlnSnapshot): string {
  return JSON.stringify({
    c: uln.confirmations,
    rq: [...uln.requiredDVNs].map((a) => a.toLowerCase()).sort(),
    on: uln.optionalDVNCount,
    ot: uln.optionalDVNThreshold,
    od: [...uln.optionalDVNs].map((a) => a.toLowerCase()).sort(),
  });
}

export function blockClaimVerificationsFile(): string {
  const dataDir = process.env.DATA_DIR
    ? resolve(process.env.DATA_DIR)
    : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
  return join(dataDir, "block-claim-verifications.json");
}

type Store = Record<string, BlockClaimVerification>;

const keyOf = (chainId: number, oft: string, eid: number) =>
  `${chainId}:${oft.toLowerCase()}:${eid}`;

export function loadBlockClaimVerifications(): Store {
  const file = blockClaimVerificationsFile();
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? (raw as Store) : {};
  } catch {
    return {}; // malformed worksheet = not measured, never a crash in the read path
  }
}

export function getBlockClaimVerification(
  chainId: number, oft: string, eid: number,
): BlockClaimVerification | null {
  return loadBlockClaimVerifications()[keyOf(chainId, oft, eid)] ?? null;
}

export function recordBlockClaimVerification(
  chainId: number, oft: string, eid: number, v: BlockClaimVerification,
): void {
  const file = blockClaimVerificationsFile();
  mkdirSync(dirname(file), { recursive: true });
  const store = loadBlockClaimVerifications();
  store[keyOf(chainId, oft, eid)] = v;
  writeFileSync(file, JSON.stringify(store, null, 2) + "\n");
}

/**
 * Apply a verification to a live delivery reading — or refuse to, when the world has
 * moved since it was taken. The validity rule is asymmetric because staleness cuts
 * differently per verdict:
 *
 *   `false` (UNTESTED) is valid only while the delivered count is UNCHANGED — one new
 *     delivery might be the first message under the current config.
 *   `true` (crossed under current config) is valid while the CONFIG is unchanged —
 *     more deliveries under the same config only strengthen it.
 *
 * Both additionally require the config fingerprint to match: a config change after
 * verification voids any statement about "the current config".
 * Refusing the stamp is always safe: drift.ts falls back to the undiscriminated
 * DELIVERING note, and severity never depended on the stamp to begin with.
 */
export function stampDelivery(
  delivery: DeliverySnapshot, uln: UlnSnapshot | null, v: BlockClaimVerification | null,
): void {
  if (!v || !uln) return;
  if (ulnFingerprint(uln) !== v.sendUlnFingerprint) return;
  if (v.sentUnderCurrentConfig === false && delivery.delivered !== v.deliveredAtVerification) return;
  delivery.sentUnderCurrentConfig = v.sentUnderCurrentConfig;
}
