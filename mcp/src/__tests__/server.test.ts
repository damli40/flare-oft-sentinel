import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.js";

const status = {
  rulesVersion: "4.1.0",
  chains: [
    { chainId: 1, name: "Ethereum" },
    { chainId: 8453, name: "Base" },
    { chainId: 5000, name: "Mantle" },
  ],
  watched: [
    {
      ticker: "ALFA", address: "0xa1f0000000000000000000000000000000000a1f", chainId: 5000,
      lastSnapshotAt: 1, corridors: ["ethereum"],
      assessment: { score: 84, riskLevel: "AT_RISK", reasons: [], tis: [] },
    },
    {
      ticker: "BETA", address: "0xbbb0000000000000000000000000000000000bbb", chainId: 8453,
      lastSnapshotAt: 2, corridors: ["gnosis"],
      assessment: { score: 0, riskLevel: "CRITICAL", reasons: [], tis: [] },
    },
  ],
};

async function connectedClient() {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server — list_fleet", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Pin the exact tool surface: names IN ORDER (reordering invalidates client
  // prompt caches), schema property keys, and annotations. Update deliberately
  // when a tool lands — never let this drift as a side effect.
  it("pins the tool list — names, order, schema keys, annotations", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_fleet", "get_oft_config", "get_verdict", "get_drift_history", "verify_attestation", "validate_config",
    ]);
    const schemaKeys = (t: (typeof tools)[number]) =>
      Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort();
    expect(schemaKeys(tools[0])).toEqual(["chain", "risk"]);
    expect(schemaKeys(tools[1])).toEqual(["address", "chain"]);
    expect(schemaKeys(tools[2])).toEqual(["address", "chain"]);
    expect(schemaKeys(tools[3])).toEqual(["address", "chain", "limit"]);
    expect(schemaKeys(tools[4])).toEqual(["address", "attestationId", "chain"]);
    expect(schemaKeys(tools[5])).toEqual(["config", "custodyType", "declaredBy", "ticker"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
  });

  it("advertises list_fleet as a read-only tool", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "list_fleet");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.description).toContain("risk band");
  });

  it("returns distilled rows plus a fleet summary line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const client = await connectedClient();
    const res = await client.callTool({ name: "list_fleet", arguments: {} });
    const sc = res.structuredContent as { rulesVersion: string; total: number; rows: Array<{ ticker: string }> };
    expect(sc.rulesVersion).toBe("4.1.0");
    expect(sc.total).toBe(2);
    expect(sc.rows.map((r) => r.ticker)).toEqual(["ALFA", "BETA"]);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("2 OFTs watched");
    expect(text).toContain("1 CRITICAL");
  });

  it("filters by risk and by chain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const client = await connectedClient();
    const critical = await client.callTool({ name: "list_fleet", arguments: { risk: "CRITICAL" } });
    expect((critical.structuredContent as { rows: unknown[] }).rows).toHaveLength(1);
    const base = await client.callTool({ name: "list_fleet", arguments: { chain: "base" } });
    expect((base.structuredContent as { rows: Array<{ chainId: number }> }).rows[0].chainId).toBe(8453);
  });

  it("surfaces API failures as isError results with an actionable message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    const client = await connectedClient();
    const res = await client.callTool({ name: "list_fleet", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("Sentinel API 500");
  });
});
