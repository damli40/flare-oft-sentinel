import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.js";
import type { StatusPayload, WatchedEntry } from "../format.js";

// latestVerdict shape shape pinned from a real /status read; the identity here is invented.
const zeta: WatchedEntry = {
  ticker: "ZETA",
  address: "0xeee0000000000000000000000000000000000eee",
  chainId: 5000,
  lastSnapshotAt: 1784263908376,
  corridors: ["ethereum", "base"],
  assessment: {
    score: 0,
    riskLevel: "CRITICAL",
    reasons: ["ethereum: 2 block confirmations (< 15, reorg risk)."],
    tis: [
      { action: "Pin the receive library to a specific version", severity: "CRITICAL", corridors: ["ethereum", "base"] },
      { action: "Raise confirmation threshold to ≥15 blocks", severity: "MEDIUM", corridors: ["ethereum"] },
    ],
  },
  latestVerdict: {
    verdict: "Persistent CRITICAL config — pre-existing risk, no drift (score 0/100)",
    verdictHash: "0xe2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2",
    capturedAt: 1784263908376,
    attestTxHash: "0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
    attestationId: "1",
  },
};

const neverAttested: WatchedEntry = {
  ...zeta,
  ticker: "Quiet",
  address: "0x1111111111111111111111111111111111111111",
  assessment: { score: 100, riskLevel: "PASS", reasons: [], tis: [] },
  latestVerdict: null,
};

const status: StatusPayload = {
  rulesVersion: "4.1.0",
  chains: [{ chainId: 5000, name: "Mantle" }],
  // /status reports which chain holds this instance's contracts, and the tools
  // build explorer links from it. Flare here, because that is where this
  // instance's AuditRegistry lives.
  chain: { chainId: 14, name: "Flare", explorer: "https://flare-explorer.flare.network" },
  watched: [zeta, neverAttested],
};

async function connectedClient() {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server — get_verdict", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns current posture plus the last attested verdict with explorer link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const client = await connectedClient();
    const res = await client.callTool({ name: "get_verdict", arguments: { address: zeta.address } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      rulesVersion: string;
      current: { score: number; riskLevel: string; reasons: string[]; remediation: Array<{ action: string }> };
      lastAttested: { verdictHash: string; attestationId: string | null; explorerTx: string | null } | null;
    };
    expect(sc.rulesVersion).toBe("4.1.0");
    expect(sc.current.score).toBe(0);
    expect(sc.current.riskLevel).toBe("CRITICAL");
    expect(sc.current.remediation[0].action).toContain("receive library");
    expect(sc.lastAttested?.verdictHash).toBe(zeta.latestVerdict!.verdictHash);
    expect(sc.lastAttested?.explorerTx).toBe(
      `https://flare-explorer.flare.network/tx/${zeta.latestVerdict!.attestTxHash}`,
    );
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("CRITICAL");
    expect(text).toContain("ZETA");
  });

  it("renders no explorer link when the backend reports no explorer for its chain", async () => {
    const noExplorer: StatusPayload = { ...status, chain: { chainId: 999999, name: "Chain 999999", explorer: null } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(noExplorer), { status: 200 })));
    const client = await connectedClient();
    const res = await client.callTool({ name: "get_verdict", arguments: { address: zeta.address } });
    const sc = res.structuredContent as { lastAttested: { explorerTx: string | null; attestTxHash: string | null } };
    // The hash is still reported. Only the link is withheld, because a link to a
    // guessed explorer lands on nothing and reads as "the proof does not exist".
    expect(sc.lastAttested.attestTxHash).toBe(zeta.latestVerdict!.attestTxHash);
    expect(sc.lastAttested.explorerTx).toBeNull();
  });

  it("returns lastAttested: null for an asset that has never been attested", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const client = await connectedClient();
    const res = await client.callTool({ name: "get_verdict", arguments: { address: neverAttested.address } });
    const sc = res.structuredContent as { lastAttested: unknown; current: { riskLevel: string } };
    expect(sc.lastAttested).toBeNull();
    expect(sc.current.riskLevel).toBe("PASS");
  });

  it("propagates resolver errors (unwatched address) as isError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    const client = await connectedClient();
    const res = await client.callTool({
      name: "get_verdict",
      arguments: { address: "0x0000000000000000000000000000000000000002" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("list_fleet");
  });
});
