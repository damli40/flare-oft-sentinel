import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  keccak256,
  toHex,
  getAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RiskLevel } from "../types.js";
import { attestScopeMode, attestPinnedAssets } from "./watch-scope.js";
import { getChainRefByKey, sentinelChain as sentinelChainInfo, sentinelRpcUrl } from "./chain-registry.js";

// AuditRegistry.attest(oft, chainId, verdictHash, score, risk, agentId) → id
const REGISTRY_ABI = [
  {
    name: "attest",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "oft", type: "address" },
      { name: "chainId", type: "uint32" },
      { name: "verdictHash", type: "bytes32" },
      { name: "score", type: "uint8" },
      { name: "risk", type: "uint8" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  { name: "total", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// AuditRegistry.RiskLevel enum: UNKNOWN=0, SAFE=1, AT_RISK=2, HIGH_RISK=3, CRITICAL=4
const RISK_ENUM: Record<RiskLevel, number> = { PASS: 1, AT_RISK: 2, CRITICAL: 4 };

const SENTINEL_CHAIN_ID = Number(process.env.SENTINEL_CHAIN_ID ?? 5003);
const AGENT_ID = BigInt(process.env.SENTINEL_AGENT_ID ?? 1);

// LAZY, not module-level. sentinelRpcUrl() throws for a sentinel chain with no
// configured endpoint, which is the right answer at the moment of signing and the
// wrong one at import: services/sentinel.ts imports alerts.ts, and the read-only
// scripts (scan-readonly.ts, verify-multichain-watchlist.ts) import sentinel.ts.
// Resolving at load made those scripts require an endpoint they never call, so a
// safety check on the WRITE path became an import-time crash on READ paths.
// Deferring keeps the fail-loud property exactly where it belongs.
//
// Memoised so repeated attestations do not rebuild the chain object, and so the
// error surfaces once per process rather than once per call.
let _rpc: string | null = null;
function sentinelRpc(): string {
  return (_rpc ??= sentinelRpcUrl());
}
/** Display-only identity, from the chain registry. Hardcoding "Mantle Sepolia"
 *  made every log line lie on a Flare instance; the native currency was still
 *  hardcoded to MNT after the label was fixed, so amounts were quoted in the
 *  wrong unit. Defaults keep prod byte-identical. */
function buildChain() {
  return defineChain({
    id: SENTINEL_CHAIN_ID,
    name: sentinelChainInfo().name,
    nativeCurrency: sentinelChainInfo().nativeCurrency,
    rpcUrls: { default: { http: [sentinelRpc()] } },
  });
}
// Typed from buildChain's own return, NOT `ReturnType<typeof defineChain>` — the
// latter is the generic, widened Chain, and viem then loses the literal it needs
// to infer `chain` on writeContract, which surfaces as "Property 'chain' is
// missing" at every call site.
let _chain: ReturnType<typeof buildChain> | null = null;
function sentinelChainObj(): ReturnType<typeof buildChain> {
  return (_chain ??= buildChain());
}

function account() {
  const pk = process.env.SENTINEL_PRIVATE_KEY;
  if (!pk) throw new Error("SENTINEL_PRIVATE_KEY not set");
  return privateKeyToAccount(pk as `0x${string}`);
}

function registryAddress(): Address {
  const a = process.env.AUDIT_REGISTRY_ADDRESS;
  if (!a) throw new Error("AUDIT_REGISTRY_ADDRESS not set");
  return getAddress(a) as Address;
}

export function verdictHash(report: unknown): `0x${string}` {
  return keccak256(toHex(JSON.stringify(report)));
}

/** True when this (oft, chainId) may be attested under the current scope.
 *
 *  ATTEST_SCOPE unset → everything (prod, unchanged).
 *  ATTEST_SCOPE=allowlist → only ATTEST_PINNED entries — NOT WATCH_PINNED.
 *  ATTEST_SCOPE=<anything else> → nothing (fail closed; see attestScopeMode).
 *
 *  Env is read at CALL time so a running process picks up the current scope.
 *  Every path that is not an explicit match returns false: an empty, unset or
 *  unparseable ATTEST_PINNED yields an empty list and therefore attests nothing.
 *  A scope check that fails open is worse than no scope check, because it reads
 *  as a guarantee. */
export function attestInScope(oft: string, chainId: number): boolean {
  const mode = attestScopeMode();
  if (mode === "all") return true;
  if (mode === "invalid") {
    console.error(
      `[attestor] ATTEST_SCOPE="${process.env.ATTEST_SCOPE}" is not a recognised mode ` +
        `(expected unset for production, or "allowlist") — attesting NOTHING. ` +
        `Note "pinned" was removed on 2026-08-05: it gated on WATCH_PINNED, which made every watched asset signable.`,
    );
    return false;
  }
  return attestPinnedAssets().some((p) => {
    const ref = getChainRefByKey(p.chainKey);
    return ref?.chainId === chainId && p.address.toLowerCase() === oft.toLowerCase();
  });
}

export interface AttestResult {
  txHash: string;
  attestationId: string;
}

/**
 * Write a verdict to AuditRegistry on Mantle Sepolia. The `watchedChainId` arg
 * is the chain the OFT lives on (Mantle mainnet 5000) — recorded in the
 * attestation — while the tx itself lands on the contract's chain (Sepolia).
 */
export async function attest(
  oft: string,
  watchedChainId: number,
  hash: `0x${string}`,
  score: number,
  risk: RiskLevel
): Promise<AttestResult> {
  const acct = account();
  const chain = sentinelChainObj();
  const wallet = createWalletClient({ account: acct, chain, transport: http(sentinelRpc()) });
  const pub = createPublicClient({ chain, transport: http(sentinelRpc()) });
  const registry = registryAddress();

  const txHash = await wallet.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "attest",
    args: [getAddress(oft), watchedChainId, hash, score, RISK_ENUM[risk], AGENT_ID],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });

  // Parse attestation ID from the Attested event emitted in the receipt.
  // Pre-reading total() before the tx races when multiple OFTs attest concurrently:
  // both callers can read the same total() and one ends up storing the wrong ID.
  // Attested(uint256 indexed id, address indexed oft, uint32, bytes32, uint8, uint8, uint256 indexed agentId, uint64)
  const ATTESTED_SIG = keccak256(toHex("Attested(uint256,address,uint32,bytes32,uint8,uint8,uint256,uint64)")) as `0x${string}`;
  const attestedLog = receipt.logs.find(
    (l) => l.address.toLowerCase() === registry.toLowerCase() && l.topics[0] === ATTESTED_SIG
  );
  const attestationId = attestedLog?.topics[1] != null
    ? BigInt(attestedLog.topics[1]).toString()
    : "unknown";

  // Post-state: confirm the ID is within the registry's total count.
  // Brief pause lets the RPC node catch up before reading total() — avoids
  // a stale-read false positive on Mantle Sepolia's load-balanced endpoints.
  if (attestationId !== "unknown") {
    try {
      await new Promise(r => setTimeout(r, 800));
      const total = await pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "total" });
      if (total <= BigInt(attestationId)) {
        console.warn(`[attestor] post-state mismatch: attestationId=${attestationId} registry total=${total}`);
      }
    } catch (e: any) {
      console.warn(`[attestor] post-state check failed:`, e.shortMessage ?? e.message);
    }
  }

  return { txHash, attestationId };
}
