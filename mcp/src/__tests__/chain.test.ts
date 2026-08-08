import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem";

// chain.ts decides which chain answers "is this attestation real". This instance
// keeps its AuditRegistry on Flare Mainnet, so a default pointing anywhere else
// would return a confident answer about a contract nobody here deployed.
//
// The endpoint is read at module load, so every case reloads the module under a
// stubbed environment.

const FLARE_DEFAULT_RPC = "https://flare-api.flare.network/ext/C/rpc";
const REGISTRY = "0x2d2b385eb0375aBD74d5174a4f738B0B142Dd144" as const;
const VERDICT_HASH = ("0x" + "cd".repeat(32)) as `0x${string}`;

/** One Attestation struct, ABI-encoded the way an RPC would return it. */
function encodedAttestation(): string {
  return encodeAbiParameters(
    parseAbiParameters("(address,uint32,bytes32,uint8,uint8,uint256,uint64)"),
    [["0xaaa0000000000000000000000000000000000aaa", 14, VERDICT_HASH, 75, 2, 1n, 1754000000n]],
  );
}

/** Answers eth_call and records every URL the client dialled. */
function stubRpc(calls: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body));
    const one = Array.isArray(body) ? body[0] : body;
    const result = one.method === "eth_chainId" ? "0xe" : encodedAttestation();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: one.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("registry chain", () => {
  it("defaults to Flare Mainnet's public RPC", async () => {
    vi.resetModules();
    const { registryRpcName, REGISTRY_CHAIN_NAME } = await import("../chain.js");
    expect(registryRpcName()).toBe(FLARE_DEFAULT_RPC);
    expect(REGISTRY_CHAIN_NAME).toBe("Flare");
  });

  it("reads the attestation over the default RPC and decodes the verdict hash", async () => {
    const calls: string[] = [];
    stubRpc(calls);
    vi.resetModules();
    const { readAttestation } = await import("../chain.js");
    const att = await readAttestation(REGISTRY, 7n);
    expect(att.verdictHash).toBe(VERDICT_HASH);
    expect(att.score).toBe(75);
    expect(calls.every((u) => u === FLARE_DEFAULT_RPC)).toBe(true);
  });

  it("takes the endpoint from SENTINEL_REGISTRY_RPC, and only from there", async () => {
    const calls: string[] = [];
    stubRpc(calls);
    vi.stubEnv("SENTINEL_REGISTRY_RPC", "https://rpc.operator.example/flare");
    vi.resetModules();
    const { readAttestation, registryRpcName } = await import("../chain.js");
    expect(registryRpcName()).toBe("https://rpc.operator.example/flare");
    await readAttestation(REGISTRY, 7n);
    expect(calls.every((u) => u === "https://rpc.operator.example/flare")).toBe(true);
    // readAttestation takes a registry address and an id. There is no RPC
    // parameter, so a tool call cannot redirect the read to a node that returns
    // a hash of the caller's choosing.
    expect(readAttestation.length).toBe(2);
  });

  it("ignores the retired chain-specific env var", async () => {
    vi.stubEnv("SENTINEL_SEPOLIA_RPC", "https://rpc.wrong-chain.example");
    vi.resetModules();
    const { registryRpcName } = await import("../chain.js");
    expect(registryRpcName()).toBe(FLARE_DEFAULT_RPC);
  });
});
