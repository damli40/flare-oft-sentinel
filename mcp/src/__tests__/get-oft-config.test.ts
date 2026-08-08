import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.js";
import { corridorSummary, resolveAsset, type StatusPayload, type WatchedEntry } from "../format.js";

// Corridor shape shape pinned from a real /status read; the identity here is invented: uln carries
// requiredCount/optionalThreshold/effectiveCount, address arrays, and a names map.
const alfaMantle: WatchedEntry = {
  ticker: "ALFA",
  address: "0xa1f0000000000000000000000000000000000a1f",
  chainId: 5000,
  lastSnapshotAt: 1784269935161,
  corridors: ["ethereum"],
  assessment: { score: 84, riskLevel: "AT_RISK", reasons: [], tis: [] },
  dvnCorridors: [
    {
      corridor: "ethereum",
      eid: 30101,
      uln: {
        requiredCount: 2,
        optionalThreshold: 2,
        effectiveCount: 4,
        requiredDVNs: ["0x28B6140ead70cb2Fb669705b3598ffB4BEaA060b", "0xa2447e5B58D357c49Bf74B50B14421e6A100e525"],
        optionalDVNs: ["0x7fe673201724925B5c477d4E1A4Bd3E954688cF5"],
        names: {
          "0x28B6140ead70cb2Fb669705b3598ffB4BEaA060b": "LayerZero Labs",
          "0xa2447e5B58D357c49Bf74B50B14421e6A100e525": "Canary",
        },
      },
    },
    { corridor: "arbitrum", eid: 30110, uln: null },
  ],
};

const alfaEthereum: WatchedEntry = {
  ...alfaMantle,
  chainId: 1,
  dvnCorridors: [],
};

const status: StatusPayload = {
  rulesVersion: "4.1.0",
  chains: [
    { chainId: 1, name: "Ethereum" },
    { chainId: 8453, name: "Base" },
    { chainId: 5000, name: "Mantle" },
  ],
  watched: [alfaMantle, alfaEthereum],
};

describe("corridorSummary", () => {
  it("maps uln fields and resolves DVN names (null when unknown)", () => {
    const rows = corridorSummary(alfaMantle);
    expect(rows[0]).toEqual({
      corridor: "ethereum",
      eid: 30101,
      requiredCount: 2,
      optionalThreshold: 2,
      effectiveCount: 4,
      unreadable: false,
      requiredDVNs: [
        { address: "0x28B6140ead70cb2Fb669705b3598ffB4BEaA060b", name: "LayerZero Labs" },
        { address: "0xa2447e5B58D357c49Bf74B50B14421e6A100e525", name: "Canary" },
      ],
      optionalDVNs: [{ address: "0x7fe673201724925B5c477d4E1A4Bd3E954688cF5", name: null }],
    });
  });

  it("marks a null-uln corridor unreadable instead of dropping it", () => {
    const rows = corridorSummary(alfaMantle);
    expect(rows[1]).toMatchObject({ corridor: "arbitrum", eid: 30110, unreadable: true, requiredDVNs: [], optionalDVNs: [] });
  });
});

describe("resolveAsset", () => {
  it("resolves a unique address without chain", () => {
    const solo: StatusPayload = { ...status, watched: [alfaMantle] };
    const r = resolveAsset(solo, "0xA1F0000000000000000000000000000000000A1F");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.chainId).toBe(5000);
  });

  it("rejects an unwatched address, pointing at list_fleet", () => {
    const r = resolveAsset(status, "0x0000000000000000000000000000000000000001");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("list_fleet");
  });

  it("rejects an ambiguous address without chain, listing the candidate chains", () => {
    const r = resolveAsset(status, alfaMantle.address);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Mantle");
      expect(r.error).toContain("Ethereum");
    }
  });

  it("disambiguates by chain name (case-insensitive) and by chainId", () => {
    const byName = resolveAsset(status, alfaMantle.address, "mantle");
    expect(byName.ok && byName.entry.chainId).toBe(5000);
    const byId = resolveAsset(status, alfaMantle.address, 1);
    expect(byId.ok && byId.entry.chainId).toBe(1);
    const byIdString = resolveAsset(status, alfaMantle.address, "8453");
    expect(byIdString.ok).toBe(false);
  });

  it("names the chains the asset IS on when the requested chain has no deployment", () => {
    const r = resolveAsset(status, alfaMantle.address, "base");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Mantle.*Ethereum|Ethereum.*Mantle/);
  });
});

describe("MCP server — get_oft_config", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function connectedClient() {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("returns per-corridor DVN config with a text summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const client = await connectedClient();
    const res = await client.callTool({
      name: "get_oft_config",
      arguments: { address: alfaMantle.address, chain: "mantle" },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      ticker: string; chain: string; corridors: Array<{ corridor: string; unreadable: boolean }>;
    };
    expect(sc.ticker).toBe("ALFA");
    expect(sc.chain).toBe("Mantle");
    expect(sc.corridors).toHaveLength(2);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("LayerZero Labs");
    expect(text).toContain("unreadable");
  });

  it("returns isError listing candidate chains for an ambiguous address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const client = await connectedClient();
    const res = await client.callTool({ name: "get_oft_config", arguments: { address: alfaMantle.address } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("chain");
  });

  it("rejects a malformed address before any request is made", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connectedClient();
    // The SDK converts schema failures into an -32602 error result — the
    // guarantee under test is that nothing unvalidated reaches the network.
    const res = await client.callTool({ name: "get_oft_config", arguments: { address: "not-an-address" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("hex address");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
