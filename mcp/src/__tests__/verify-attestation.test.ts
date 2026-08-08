import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex } from "viem";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerVerifyAttestation } from "../tools/verify-attestation.js";
import type { StatusPayload } from "../format.js";

// The backend's own contract (types.ts): verdictHash = keccak256(JSON.stringify(pdr)),
// stored so ANYONE can recompute. This tool is that recomputation.
const pdr = { oft: "0xccc0000000000000000000000000000000000ccc", chainId: 5000, findings: [{ check: "DVN Count" }] };
const goodHash = keccak256(toHex(JSON.stringify(pdr)));

const status: StatusPayload & { registry: string } = {
  rulesVersion: "4.1.0",
  // The registry address is whatever /status reports. The tool never carries one
  // of its own, so pointing SENTINEL_API_URL at another instance verifies that
  // instance's registry rather than this one's.
  registry: "0xf07d24dbd1fe21645a0489a94bae2c99d7e0e80b",
  chains: [{ chainId: 5000, name: "Mantle" }],
  chain: { chainId: 14, name: "Flare", explorer: "https://flare-explorer.flare.network" },
  watched: [
    {
      ticker: "CCC", address: "0xccc0000000000000000000000000000000000ccc", chainId: 5000,
      lastSnapshotAt: 100, corridors: [],
      assessment: { score: 0, riskLevel: "CRITICAL", reasons: [], tis: [] },
    },
  ],
};

function verdictsPayload(hash: string, withPdr = true) {
  return {
    verdicts: [{
      oft: "0xccc0000000000000000000000000000000000ccc", chainId: 5000, capturedAt: 100,
      verdict: "test verdict", reasons: [], verdictHash: hash,
      attestationId: "7", attestTxHash: "0xtx7", ...(withPdr ? { pdr } : {}),
    }],
  };
}

function stubEndpoints(verdicts: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/api/sentinel/status")) return new Response(JSON.stringify(status), { status: 200 });
    if (u.endsWith("/api/sentinel/verdicts")) return new Response(JSON.stringify(verdicts), { status: 200 });
    return new Response("not found", { status: 404 });
  }));
}

async function clientWith(readAttestation: (registry: `0x${string}`, id: bigint) => Promise<{ verdictHash: string }>) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerVerifyAttestation(server, { readAttestation });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const ADDR = "0xccc0000000000000000000000000000000000ccc";

describe("MCP server — verify_attestation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("VERIFIED when recomputed == stored == on-chain", async () => {
    stubEndpoints(verdictsPayload(goodHash));
    const onChain = vi.fn(async () => ({ verdictHash: goodHash }));
    const client = await clientWith(onChain);
    const res = await client.callTool({ name: "verify_attestation", arguments: { address: ADDR } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      verdict: string; recomputedHash: string; pdrMatchesStored: boolean; storedMatchesOnChain: boolean;
      explorerTx: string | null;
    };
    expect(sc.verdict).toBe("VERIFIED");
    expect(sc.explorerTx).toBe("https://flare-explorer.flare.network/tx/0xtx7");
    expect(sc.recomputedHash).toBe(goodHash);
    expect(sc.pdrMatchesStored).toBe(true);
    expect(sc.storedMatchesOnChain).toBe(true);
    expect(onChain).toHaveBeenCalledWith("0xf07d24dbd1fe21645a0489a94bae2c99d7e0e80b", 7n);
  });

  it("MISMATCH is a normal result (a finding), not an error", async () => {
    stubEndpoints(verdictsPayload(goodHash));
    const client = await clientWith(async () => ({ verdictHash: "0x" + "ab".repeat(32) }));
    const res = await client.callTool({ name: "verify_attestation", arguments: { address: ADDR } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { verdict: string; storedMatchesOnChain: boolean };
    expect(sc.verdict).toBe("MISMATCH");
    expect(sc.storedMatchesOnChain).toBe(false);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("MISMATCH");
  });

  it("UNAVAILABLE when the verdict predates PDR storage", async () => {
    stubEndpoints(verdictsPayload(goodHash, false));
    const client = await clientWith(async () => ({ verdictHash: goodHash }));
    const res = await client.callTool({ name: "verify_attestation", arguments: { address: ADDR } });
    const sc = res.structuredContent as { verdict: string; pdrMatchesStored: boolean | null };
    expect(sc.verdict).toBe("UNAVAILABLE");
    expect(sc.pdrMatchesStored).toBeNull();
  });

  it("RPC failure is isError naming the chain, the endpoint and the env var that changes it", async () => {
    stubEndpoints(verdictsPayload(goodHash));
    const client = await clientWith(async () => { throw new Error("ECONNREFUSED"); });
    const res = await client.callTool({ name: "verify_attestation", arguments: { address: ADDR } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Flare RPC read failed");
    expect(text).toContain("https://flare-api.flare.network/ext/C/rpc");
    expect(text).toContain("SENTINEL_REGISTRY_RPC");
  });

  it("errors when no attested verdict exists for the asset", async () => {
    stubEndpoints({ verdicts: [] });
    const client = await clientWith(async () => ({ verdictHash: goodHash }));
    const res = await client.callTool({ name: "verify_attestation", arguments: { address: ADDR } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("no attested verdict");
  });
});
