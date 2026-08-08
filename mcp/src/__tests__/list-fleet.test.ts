import { describe, expect, it } from "vitest";
import { fleetRows, type StatusPayload } from "../format.js";

// Trimmed to the fields the distiller reads; the real /status payload is ~660KB
// per fetch and must never be proxied through a tool result.
const status = {
  rulesVersion: "4.1.0",
  chains: [
    { chainId: 1, name: "Ethereum" },
    { chainId: 8453, name: "Base" },
    { chainId: 5000, name: "Mantle" },
  ],
  watched: [
    {
      ticker: "ALFA",
      address: "0xa1f0000000000000000000000000000000000a1f",
      chainId: 5000,
      lastSnapshotAt: 1784262545728,
      corridors: ["ethereum"],
      assessment: {
        score: 84,
        riskLevel: "AT_RISK",
        reasons: ["ethereum: 2 block confirmations (< 15, reorg risk)."],
        tis: [{ action: "Raise confirmation threshold to ≥15 blocks" }],
      },
      dvnSummary: { requiredCount: 2, optionalThreshold: 2, effectiveCount: 4 },
    },
    {
      ticker: "BETA",
      address: "0xbbb0000000000000000000000000000000000bbb",
      chainId: 8453,
      lastSnapshotAt: 1784262545000,
      corridors: ["gnosis", "arbitrum"],
      assessment: { score: 0, riskLevel: "CRITICAL", reasons: [], tis: [] },
    },
    {
      ticker: "NEWOFT",
      address: "0x1111111111111111111111111111111111111111",
      chainId: 1,
      lastSnapshotAt: null,
      corridors: [],
      // no assessment yet — never polled cleanly; must surface, not vanish
    },
  ],
} as unknown as StatusPayload;

describe("fleetRows — distills /status into token-lean rows", () => {
  it("maps each watched entry to a compact row", () => {
    const rows = fleetRows(status);
    expect(rows[0]).toEqual({
      ticker: "ALFA",
      address: "0xa1f0000000000000000000000000000000000a1f",
      chainId: 5000,
      chain: "Mantle",
      riskLevel: "AT_RISK",
      score: 84,
      corridors: ["ethereum"],
      lastSnapshotAt: 1784262545728,
    });
  });

  it("marks entries without an assessment UNASSESSED instead of dropping them", () => {
    const rows = fleetRows(status);
    const unassessed = rows.find((r) => r.ticker === "NEWOFT");
    expect(unassessed?.riskLevel).toBe("UNASSESSED");
    expect(unassessed?.score).toBeNull();
  });

  it("never leaks bulky fields (reasons, tis, dvn detail) into rows", () => {
    for (const row of fleetRows(status)) {
      expect(Object.keys(row).sort()).toEqual(
        ["address", "chain", "chainId", "corridors", "lastSnapshotAt", "riskLevel", "score", "ticker"],
      );
    }
  });
});
