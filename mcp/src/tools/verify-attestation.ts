import { z } from "zod";
import { keccak256, toHex } from "viem";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiGet, SentinelApiError } from "../http.js";
import { readAttestation, registryRpcName, REGISTRY_CHAIN_NAME, type OnChainAttestation } from "../chain.js";
import { explorerTxUrl, resolveAsset, type StatusPayload } from "../format.js";
import { ADDRESS } from "./get-oft-config.js";

interface VerdictRowFull {
  oft: string;
  chainId: number;
  capturedAt: number;
  verdict: string;
  verdictHash: string;
  attestationId?: string | null;
  attestTxHash?: string | null;
  pdr?: unknown;
}

export interface VerifyDeps {
  readAttestation: (registry: `0x${string}`, id: bigint) => Promise<OnChainAttestation>;
}

export function registerVerifyAttestation(server: McpServer, deps: VerifyDeps = { readAttestation }): void {
  server.registerTool(
    "verify_attestation",
    {
      description:
        "Independently verify a Sentinel attestation: recomputes keccak256 of the policy decision record " +
        "locally and compares it against the hash the backend stored AND the hash held by the AuditRegistry " +
        "contract on Flare Mainnet. The chain read does not rely on the Sentinel backend being honest. " +
        "A MISMATCH result is a finding to act on rather than a failure. Defaults to the asset's latest " +
        "attestation. This instance signs an attestation for every asset it watches, so an asset with no " +
        "attestation has not completed a cycle yet rather than being out of scope, and returns a plain " +
        "'no attested verdict' answer.",
      inputSchema: {
        address: ADDRESS.describe("OFT contract address (0x…, 40 hex chars)"),
        chain: z.union([z.string(), z.number()]).optional()
          .describe("Chain name or chainId — required when the address exists on more than one chain"),
        attestationId: z.string().regex(/^\d+$/).optional()
          .describe("Specific AuditRegistry attestation id — defaults to the asset's latest"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address, chain, attestationId }) => {
      try {
        const status = await apiGet<StatusPayload & { registry: string }>("/api/sentinel/status");
        const resolved = resolveAsset(status, address, chain);
        if (!resolved.ok) {
          return { content: [{ type: "text", text: resolved.error }], isError: true };
        }
        const entry = resolved.entry;
        const { verdicts } = await apiGet<{ verdicts: VerdictRowFull[] }>("/api/sentinel/verdicts");
        const mine = verdicts
          .filter((v) => v.oft.toLowerCase() === entry.address.toLowerCase() && v.chainId === entry.chainId && v.attestationId != null)
          .sort((a, b) => b.capturedAt - a.capturedAt);
        const row = attestationId !== undefined
          ? mine.find((v) => v.attestationId === attestationId)
          : mine[0];
        if (!row) {
          const what = attestationId !== undefined
            ? `attestation ${attestationId} not found for ${entry.ticker}`
            : `no attested verdict exists for ${entry.ticker} on chain ${entry.chainId}`;
          return {
            content: [{ type: "text", text: `${what} — call get_verdict to see the asset's attestation state.` }],
            isError: true,
          };
        }

        // Deterministic recompute in code (never ask a model to hash):
        // backend contract (types.ts): verdictHash = keccak256(JSON.stringify(pdr)).
        const recomputedHash = row.pdr !== undefined ? keccak256(toHex(JSON.stringify(row.pdr))) : null;
        const pdrMatchesStored = recomputedHash === null ? null : recomputedHash === row.verdictHash;

        // The registry address comes from the backend's /status, not from a
        // constant here and never from a tool input: one deployment, one answer.
        if (!/^0x[0-9a-fA-F]{40}$/.test(status.registry ?? "")) {
          return {
            content: [{ type: "text", text: "Backend /status did not report a valid AuditRegistry address, so the on-chain comparison cannot run right now." }],
            isError: true,
          };
        }
        let onChain: OnChainAttestation;
        try {
          onChain = await deps.readAttestation(status.registry as `0x${string}`, BigInt(row.attestationId!));
        } catch (e) {
          return {
            content: [{
              type: "text",
              text: `${REGISTRY_CHAIN_NAME} RPC read failed (${registryRpcName()}): ${(e as Error).message}. Retry, or set SENTINEL_REGISTRY_RPC to a different RPC.`,
            }],
            isError: true,
          };
        }
        const storedMatchesOnChain = onChain.verdictHash === row.verdictHash;

        const verdict =
          recomputedHash === null ? "UNAVAILABLE" :
          pdrMatchesStored && storedMatchesOnChain ? "VERIFIED" : "MISMATCH";
        const explorerTx = explorerTxUrl(status, row.attestTxHash);
        const text =
          verdict === "VERIFIED"
            ? `VERIFIED: attestation ${row.attestationId} for ${entry.ticker} — locally recomputed PDR hash matches the backend AND the on-chain AuditRegistry record.`
            : verdict === "MISMATCH"
              ? `MISMATCH on attestation ${row.attestationId} for ${entry.ticker}: recomputed=${recomputedHash} stored=${row.verdictHash} onChain=${onChain.verdictHash}. Treat the backend-reported verdict as unverified.`
              : `UNAVAILABLE: verdict predates PDR storage — cannot recompute locally. On-chain hash ${storedMatchesOnChain ? "matches" : "does NOT match"} the backend's stored hash.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            ticker: entry.ticker,
            address: entry.address,
            chainId: entry.chainId,
            attestationId: row.attestationId,
            recomputedHash,
            storedHash: row.verdictHash,
            onChainHash: onChain.verdictHash,
            pdrMatchesStored,
            storedMatchesOnChain,
            verdict,
            explorerTx,
          },
        };
      } catch (e) {
        const msg = e instanceof SentinelApiError
          ? `${e.message}. Retry, or check https://flare-oft-sentinel.netlify.app/flare.html for the rail status page.`
          : `Unexpected failure: ${(e as Error).message}`;
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );
}
