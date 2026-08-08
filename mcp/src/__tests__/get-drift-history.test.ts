import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.js";
import { driftRows, type StatusPayload } from "../format.js";

// Endpoint shapes pinned from prod 2026-07-17:
//   GET /history/:address → { oft, history: [{ oft, chainId, score, riskLevel, capturedAt }] }
//   GET /verdicts → { verdicts: [{ oft, chainId, capturedAt, verdict, reasons, attestTxHash, ... }] }
const historyRows = [
  { oft: "0xaaa0000000000000000000000000000000000aaa", chainId: 5000, score: 100, riskLevel: "PASS", capturedAt: 100 },
  { oft: "0xaaa0000000000000000000000000000000000aaa", chainId: 5000, score: 40, riskLevel: "CRITICAL", capturedAt: 200 },
  { oft: "0xaaa0000000000000000000000000000000000aaa", chainId: 5000, score: 40, riskLevel: "CRITICAL", capturedAt: 300 },
  // Same address, DIFFERENT chain — must be filtered out by the resolved chainId.
  { oft: "0xaaa0000000000000000000000000000000000aaa", chainId: 1, score: 90, riskLevel: "PASS", capturedAt: 250 },
];

const verdictRows = [
  {
    oft: "0xAAA0000000000000000000000000000000000aaa", chainId: 5000, capturedAt: 200,
    verdict: "Config drift: DVN set reduced", reasons: ["ethereum: 1 effective DVN"],
    attestTxHash: "0xattest1", score: 40, riskLevel: "CRITICAL",
  },
  { oft: "0xbbb0000000000000000000000000000000000bbb", chainId: 5000, capturedAt: 200, verdict: "other asset", reasons: [], attestTxHash: "0xother", score: 0, riskLevel: "CRITICAL" },
];

describe("driftRows", () => {
  it("filters to the resolved chain, joins events on capturedAt, newest first, capped", () => {
    const rows = driftRows(historyRows, verdictRows, "0xaaa0000000000000000000000000000000000aaa", 5000, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ capturedAt: 300, score: 40, event: undefined });
    expect(rows[1]).toMatchObject({
      capturedAt: 200,
      score: 40,
      event: { verdict: "Config drift: DVN set reduced", attestTxHash: "0xattest1" },
    });
  });

  it("never joins another asset's verdict", () => {
    const rows = driftRows(historyRows, verdictRows, "0xaaa0000000000000000000000000000000000aaa", 5000, 10);
    expect(rows.flatMap((r) => (r.event ? [r.event.verdict] : []))).toEqual(["Config drift: DVN set reduced"]);
  });
});

const status: StatusPayload = {
  rulesVersion: "4.1.0",
  chains: [{ chainId: 5000, name: "Mantle" }, { chainId: 1, name: "Ethereum" }],
  watched: [
    {
      ticker: "AAA", address: "0xaaa0000000000000000000000000000000000aaa", chainId: 5000,
      lastSnapshotAt: 300, corridors: ["ethereum"],
      assessment: { score: 40, riskLevel: "CRITICAL", reasons: [], tis: [] },
    },
    {
      ticker: "AAA", address: "0xaaa0000000000000000000000000000000000aaa", chainId: 1,
      lastSnapshotAt: 250, corridors: ["base"],
      assessment: { score: 90, riskLevel: "PASS", reasons: [], tis: [] },
    },
  ],
};

describe("MCP server — get_drift_history", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function connectedClient() {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  function stubEndpoints() {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/api/sentinel/status")) return new Response(JSON.stringify(status), { status: 200 });
      if (u.includes("/api/sentinel/history/")) {
        return new Response(JSON.stringify({ oft: "0xaaa…", history: historyRows }), { status: 200 });
      }
      if (u.endsWith("/api/sentinel/verdicts")) {
        return new Response(JSON.stringify({ verdicts: verdictRows }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));
  }

  it("returns chain-scoped rows with attested events and a drift summary", async () => {
    stubEndpoints();
    const client = await connectedClient();
    const res = await client.callTool({
      name: "get_drift_history",
      arguments: { address: "0xaaa0000000000000000000000000000000000aaa", chain: "mantle" },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { rows: Array<{ capturedAt: number; event?: { verdict: string } }> };
    expect(sc.rows.map((r) => r.capturedAt)).toEqual([300, 200, 100]);
    expect(sc.rows[1].event?.verdict).toContain("DVN set reduced");
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("100 → 40");
    expect(text).toContain("1 attested event");
  });

  it("enforces the limit ceiling of 100", async () => {
    stubEndpoints();
    const client = await connectedClient();
    const res = await client.callTool({
      name: "get_drift_history",
      arguments: { address: "0xaaa0000000000000000000000000000000000aaa", chain: 5000, limit: 500 },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text.toLowerCase()).toContain("limit");
  });
});
