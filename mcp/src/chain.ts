import { createPublicClient, http } from "viem";

// This instance's AuditRegistry lives on Flare Mainnet, so the verification read
// goes to Flare and nowhere else.
//
// SECURITY: the RPC is env-configured ONLY (SENTINEL_REGISTRY_RPC). It is never a
// tool input. An agent that could name the RPC could point this read at a node
// that returns whatever hash it wants, and the "independent" check would confirm
// the backend against a source the agent chose. Operators set the endpoint; the
// model asking the question never does.
const REGISTRY_RPC = process.env.SENTINEL_REGISTRY_RPC ?? "https://flare-api.flare.network/ext/C/rpc";
const FLARE_ID = 14;

/** The chain this server verifies attestations against. Display name for error
 *  text, so a reader knows which chain failed to answer. */
export const REGISTRY_CHAIN_NAME = "Flare";

// Exact ABI fragment from contracts/artifacts AuditRegistry.json: get(uint256)
// returns the Attestation struct.
const GET_ATTESTATION_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "id", type: "uint256" }],
    name: "get",
    outputs: [
      {
        components: [
          { internalType: "address", name: "oft", type: "address" },
          { internalType: "uint32", name: "chainId", type: "uint32" },
          { internalType: "bytes32", name: "verdictHash", type: "bytes32" },
          { internalType: "uint8", name: "score", type: "uint8" },
          { internalType: "enum AuditRegistry.RiskLevel", name: "risk", type: "uint8" },
          { internalType: "uint256", name: "agentId", type: "uint256" },
          { internalType: "uint64", name: "timestamp", type: "uint64" },
        ],
        internalType: "struct AuditRegistry.Attestation",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface OnChainAttestation {
  verdictHash: string;
  score?: number;
  agentId?: bigint;
  timestamp?: bigint;
}

export async function readAttestation(registry: `0x${string}`, id: bigint): Promise<OnChainAttestation> {
  const client = createPublicClient({
    chain: {
      id: FLARE_ID,
      name: REGISTRY_CHAIN_NAME,
      nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
      rpcUrls: { default: { http: [REGISTRY_RPC] } },
    },
    transport: http(REGISTRY_RPC, { timeout: 15_000 }),
  });
  const att = await client.readContract({
    address: registry,
    abi: GET_ATTESTATION_ABI,
    functionName: "get",
    args: [id],
  });
  return { verdictHash: att.verdictHash, score: att.score, agentId: att.agentId, timestamp: att.timestamp };
}

export function registryRpcName(): string {
  return REGISTRY_RPC;
}
