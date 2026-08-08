import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiGet, SentinelApiError } from "../http.js";
import { explorerTxUrl, resolveAsset, type StatusPayload } from "../format.js";
import { ADDRESS } from "./get-oft-config.js";

export function registerGetVerdict(server: McpServer): void {
  server.registerTool(
    "get_verdict",
    {
      description:
        "Current security verdict and severity for a watched OFT: live score, risk band, reasons and " +
        "remediation intents, plus the last on-chain attested verdict (hash + attestation tx) when one " +
        "exists. Use verify_attestation to independently check the attested hash.",
      inputSchema: {
        address: ADDRESS.describe("OFT contract address (0x…, 40 hex chars)"),
        chain: z.union([z.string(), z.number()]).optional()
          .describe("Chain name or chainId — required when the address exists on more than one chain"),
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
        const a = entry.assessment;
        const current = a
          ? {
              score: a.score,
              riskLevel: a.riskLevel,
              reasons: a.reasons,
              remediation: a.tis.map((t) => ({ action: t.action, severity: t.severity ?? null, corridors: t.corridors ?? [] })),
            }
          : null;
        const lv = entry.latestVerdict ?? null;
        const lastAttested = lv
          ? {
              verdict: lv.verdict,
              verdictHash: lv.verdictHash,
              capturedAt: lv.capturedAt,
              attestationId: lv.attestationId ?? null,
              attestTxHash: lv.attestTxHash ?? null,
              explorerTx: explorerTxUrl(status, lv.attestTxHash),
            }
          : null;
        const posture = current
          ? `${current.riskLevel} (score ${current.score}/100), ${current.reasons.length} finding(s), ${current.remediation.length} remediation intent(s)`
          : "UNASSESSED — no snapshot assessed yet";
        const attestLine = lastAttested
          ? `Last attested: "${lastAttested.verdict}" (attestation ${lastAttested.attestationId ?? "?"}, hash ${lastAttested.verdictHash.slice(0, 10)}…)`
          : "Never attested on-chain (no drift/weak-config event recorded).";
        return {
          content: [{ type: "text", text: `${entry.ticker} on ${chainName}: ${posture}. ${attestLine}` }],
          structuredContent: {
            ticker: entry.ticker,
            address: entry.address,
            chainId: entry.chainId,
            chain: chainName,
            rulesVersion: status.rulesVersion,
            current,
            lastAttested,
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
