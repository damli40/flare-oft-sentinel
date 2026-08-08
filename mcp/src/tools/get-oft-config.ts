import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiGet, SentinelApiError } from "../http.js";
import { corridorSummary, resolveAsset, type CorridorConfig, type StatusPayload } from "../format.js";

// Trust boundary: the address is validated against this exact pattern BEFORE
// any use — nothing unvalidated is ever interpolated anywhere.
export const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

function dvnList(refs: CorridorConfig["requiredDVNs"]): string {
  return refs.map((d) => d.name ?? `${d.address.slice(0, 8)}…`).join(", ");
}

export function corridorLine(c: CorridorConfig): string {
  if (c.unreadable) return `${c.corridor}: unreadable this cycle (RPC) — treat as unknown, not safe`;
  const opt = c.optionalDVNs.length > 0 ? ` + ${c.optionalThreshold}-of-${c.optionalDVNs.length} optional [${dvnList(c.optionalDVNs)}]` : "";
  return `${c.corridor}: ${c.requiredCount} required [${dvnList(c.requiredDVNs)}]${opt} (effective ${c.effectiveCount})`;
}

export function registerGetOftConfig(server: McpServer): void {
  server.registerTool(
    "get_oft_config",
    {
      description:
        "Full DVN security configuration for one watched OFT, per corridor: required and optional DVN sets " +
        "with resolved operator names, optional threshold and effective validator count. A corridor with one " +
        "required DVN and no optionals verifies every message through a single party, so compromising that " +
        "one party is enough to forge a message the corridor accepts. Use list_fleet first to find the " +
        "address; pass chain when the same address is deployed on multiple chains.",
      inputSchema: {
        address: ADDRESS.describe("OFT contract address (0x…, 40 hex chars)"),
        chain: z.union([z.string(), z.number()]).optional()
          .describe("Chain name (e.g. \"base\") or chainId (e.g. 8453) — required when the address exists on more than one chain"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address, chain }) => {
      try {
        const status = await apiGet<StatusPayload>("/api/sentinel/status");
        const resolved = resolveAsset(status, address, chain);
        if (!resolved.ok) {
          return { content: [{ type: "text", text: resolved.error }], isError: true };
        }
        const entry = resolved.entry;
        const chainName = status.chains.find((c) => c.chainId === entry.chainId)?.name ?? String(entry.chainId);
        const corridors = corridorSummary(entry);
        const lines = corridors.map(corridorLine);
        const text =
          `${entry.ticker} on ${chainName} (${entry.address}) — ${corridors.length} corridor(s):\n` +
          lines.map((l) => `- ${l}`).join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            ticker: entry.ticker,
            address: entry.address,
            chainId: entry.chainId,
            chain: chainName,
            lastSnapshotAt: entry.lastSnapshotAt,
            rulesVersion: status.rulesVersion,
            corridors,
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
