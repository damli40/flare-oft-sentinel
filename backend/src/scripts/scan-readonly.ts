/**
 * Read-only fleet scan. Mirrors sentinel.pollOnce()'s READ path exactly
 * (getWatched → getChainRef → readSnapshot → guards → assessSnapshot) but
 * performs no putSnapshot, no attest(), no alerts. Safe to run any time.
 *
 *   npx tsx src/scripts/scan-readonly.ts > /path/to/scan.json
 */
import "dotenv/config";
import { appendFileSync, writeFileSync } from "node:fs";
import { readSnapshot } from "../services/lz-config.js";
import { assessSnapshot, deliveryState } from "../services/drift.js";
import { RULES_VERSION } from "../services/drift.js";
import { getWatched } from "../services/sentinel.js";
import { getChainRef } from "../services/chain-registry.js";

const CONCURRENCY = Number(process.env.SCAN_CONCURRENCY ?? 3);
// NDJSON sink: one row per line, flushed as it completes, so a killed run keeps its work.
const OUT = process.env.SCAN_OUT!;
writeFileSync(OUT, "");
const emit = (o: unknown) => appendFileSync(OUT, JSON.stringify(o) + "\n");

async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const rows: any[] = [];
const skipped: any[] = [];
const skip = (o: any) => { skipped.push(o); emit({ kind: "skip", ...o }); };

const watched = (await getWatched(true)).filter((w) => w.ticker !== "DEMO");
console.error(`[scan] ${watched.length} OFT-chain pairs`);

let done = 0;
await mapLimit(watched, CONCURRENCY, async (w) => {
  const tag = `${w.ticker}@${w.chainId}`;
  try {
    const chainRef = getChainRef(w.chainId);
    if (!chainRef?.eligible) return void skip({ ...w, reason: "chain ineligible" });

    const snap = await readSnapshot(w.address, chainRef);
    if (!snap.routes.some((r) => r.isActive)) return void skip({ ...w, reason: "0 active routes" });
    if (!snap.routes.some((r) => r.isActive && r.uln !== null))
      return void skip({ ...w, reason: "all ULN reads null" });

    const { score, riskLevel, findings } = await assessSnapshot(snap, w.ticker);
    const active = snap.routes.filter((r) => r.isActive);
    // Sendability census. Without this we cannot tell a working severity gate from an inert
    // one: if RPC pressure turned every corridor into UNKNOWN, the gate would silently
    // cap nothing and the scan would look identical to a healthy run.
    const sendability = { SENDABLE: 0, UNSENDABLE: 0, UNKNOWN: 0 } as Record<string, number>;
    for (const r of active) sendability[r.sendability ?? "UNKNOWN"]++;
    // Delivery census: the only thing that turns a config observation into a claim about
    // value. STRANDING is the only state where funds are actually stuck.
    const delivery = { STRANDING: 0, DELIVERING: 0, UNUSED: 0, UNKNOWN: 0 } as Record<string, number>;
    let stranded = 0;
    const halfWired: string[] = [];
    for (const r of active) {
      delivery[deliveryState(r)]++;
      if (deliveryState(r) === "STRANDING" && r.delivery?.delivered != null) {
        stranded += r.delivery.sent - r.delivery.delivered;
      }
      if (r.peerSymmetric === false) halfWired.push(r.chainName);
    }
    const row = {
      ticker: w.ticker,
      address: w.address,
      chainId: w.chainId,
      chainKey: chainRef.chainKey,
      score,
      riskLevel,
      sendability,
      delivery,
      stranded,
      halfWired,
      activeRoutes: active.length,
      findings: findings.map((f) => ({
        severity: f.severity,
        evidence: f.evidence,
        check: f.check,
        detail: f.detail,
      })),
    };
    rows.push(row);
    emit({ kind: "row", ...row });
  } catch (e: any) {
    skip({ ...w, reason: e.shortMessage ?? e.message });
  } finally {
    if (++done % 20 === 0) console.error(`[scan] ${done}/${watched.length}`);
  }
});

emit({ kind: "done", scannedAt: new Date().toISOString(), rulesVersion: RULES_VERSION, assessed: rows.length, skipped: skipped.length });
console.error(`[scan] assessed ${rows.length}, skipped ${skipped.length}`);
