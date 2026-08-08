import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiGet, SentinelApiError } from "../http.js";
import { fleetRows, fleetSummary, type StatusPayload } from "../format.js";

const RISK = ["PASS", "AT_RISK", "CRITICAL", "UNASSESSED"] as const;

export function registerListFleet(server: McpServer): void {
  server.registerTool(
    "list_fleet",
    {
      description:
        "List every OFT (omnichain fungible token) deployment the Sentinel watches, with current risk band and score. " +
        "Use this first to find an asset's address/chain before calling get_oft_config, get_verdict or get_drift_history. " +
        "Optional filters: chain (name or chainId), risk (PASS | AT_RISK | CRITICAL | UNASSESSED).",
      inputSchema: {
        chain: z.union([z.string(), z.number()]).optional()
          .describe("Filter to one chain, by name (e.g. \"base\") or numeric chainId (e.g. 8453)"),
        risk: z.enum(RISK).optional().describe("Filter to one risk band"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chain, risk }) => {
      try {
        const status = await apiGet<StatusPayload>("/api/sentinel/status");
        let rows = fleetRows(status);
        if (chain !== undefined) {
          const needle = String(chain).toLowerCase();
          rows = rows.filter((r) => r.chain.toLowerCase() === needle || String(r.chainId) === needle);
        }
        if (risk !== undefined) rows = rows.filter((r) => r.riskLevel === risk);
        return {
          content: [{ type: "text", text: fleetSummary(rows, status.rulesVersion) }],
          structuredContent: { rulesVersion: status.rulesVersion, total: rows.length, rows },
        };
      } catch (e) {
        const msg = e instanceof SentinelApiError
          ? `${e.message}. The fleet is unavailable right now. Retry, or check https://flare-oft-sentinel.netlify.app/flare.html for the rail status page.`
          : `Unexpected failure: ${(e as Error).message}`;
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );
}
