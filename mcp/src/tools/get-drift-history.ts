import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiGet, SentinelApiError } from "../http.js";
import { driftRows, resolveAsset, type HistoryRow, type StatusPayload, type VerdictRow } from "../format.js";
import { ADDRESS } from "./get-oft-config.js";

const MAX_LIMIT = 100;

export function registerGetDriftHistory(server: McpServer): void {
  server.registerTool(
    "get_drift_history",
    {
      description:
        "Score/risk history for a watched OFT (newest first) with on-chain attested config-change events " +
        "joined in. Use it to see WHEN a config drifted and what the verdict was. Default 20 rows, max 100.",
      inputSchema: {
        address: ADDRESS.describe("OFT contract address (0x…, 40 hex chars)"),
        chain: z.union([z.string(), z.number()]).optional()
          .describe("Chain name or chainId — required when the address exists on more than one chain"),
        limit: z.number().int().positive().optional()
          .describe("Rows to return, newest first (default 20, max 100)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address, chain, limit }) => {
      if (limit !== undefined && limit > MAX_LIMIT) {
        return {
          content: [{ type: "text", text: `limit must be ≤ ${MAX_LIMIT} (got ${limit}).` }],
          isError: true,
        };
      }
      try {
        const status = await apiGet<StatusPayload>("/api/sentinel/status");
        const resolved = resolveAsset(status, address, chain);
        if (!resolved.ok) {
          return { content: [{ type: "text", text: resolved.error }], isError: true };
        }
        const entry = resolved.entry;
        const chainName = status.chains.find((c) => c.chainId === entry.chainId)?.name ?? String(entry.chainId);
        const [historyRes, verdictsRes] = await Promise.all([
          apiGet<{ history: HistoryRow[] }>(`/api/sentinel/history/${entry.address}`),
          apiGet<{ verdicts: VerdictRow[] }>("/api/sentinel/verdicts"),
        ]);
        const rows = driftRows(historyRes.history, verdictsRes.verdicts, entry.address, entry.chainId, limit ?? 20);
        const events = rows.filter((r) => r.event).length;
        const oldest = rows[rows.length - 1];
        const newest = rows[0];
        const scoreArc = rows.length > 1 && oldest.score !== newest.score
          ? `score ${oldest.score} → ${newest.score}`
          : `score steady at ${newest?.score ?? "?"}`;
        return {
          content: [{
            type: "text",
            text: `${entry.ticker} on ${chainName}: ${rows.length} snapshot(s), ${scoreArc}, ${events} attested event(s).`,
          }],
          structuredContent: {
            ticker: entry.ticker,
            address: entry.address,
            chainId: entry.chainId,
            chain: chainName,
            rulesVersion: status.rulesVersion,
            rows,
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
