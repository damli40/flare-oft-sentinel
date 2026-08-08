import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiPost, SentinelApiError } from "../http.js";

// The config is a SINGLE stringified-JSON parameter, not a nested schema: a
// deeply nested inputSchema would ride along in every tools/list of every
// session. The deterministic validation happens server-side in the rule
// engine — the tool only guards size and parseability before shipping it.
const MAX_CONFIG_CHARS = 100_000;
const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

const CUSTODY = ["eoa_hot", "fireblocks_mpc", "safe_multisig", "unknown"] as const;

interface ValidateResponse {
  score: number;
  riskLevel: string;
  rulesVersion: string;
  findings: Array<{ severity: string; check: string; detail: string }>;
  tis: Array<{ intent?: string; action: string; severity?: string }>;
}

export function registerValidateConfig(server: McpServer): void {
  server.registerTool(
    "validate_config",
    {
      description:
        "Validate a proposed or existing OFT security config against Sentinel's deterministic rule engine " +
        "(the same rules that produce on-chain attestations) BEFORE deploying or changing it. Returns findings " +
        "(worst first), score, risk band and remediation intents. An agent should refuse to ship a config that " +
        "comes back CRITICAL: a route verified by one party alone gives that party the power to forge a " +
        "message, and the setting is invisible until someone reads it. Pass the config as a JSON " +
        "string: {\"oft\":\"0x…\",\"chainId\":1,\"routes\":[{\"eid\":30101,\"uln\":{\"confirmations\":15," +
        "\"requiredDVNCount\":2,\"requiredDVNs\":[\"0x…\",\"0x…\"],\"optionalDVNCount\":0," +
        "\"optionalDVNThreshold\":0,\"optionalDVNs\":[]}}]} — owner/proxy fields optional; omitted fields " +
        "are treated as unknown, not safe.",
      inputSchema: {
        config: z.string().describe("The OFT config snapshot as a JSON string (see tool description for the shape)"),
        ticker: z.string().max(32).optional().describe("Asset ticker, for readable findings"),
        custodyType: z.enum(CUSTODY).optional()
          .describe("Declared custody of the owner key — consumed by the owner-key rules (e.g. fireblocks_mpc)"),
        declaredBy: z.string().max(120).optional()
          .describe("Who is making the custody declaration — required when custodyType is set"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ config, ticker, custodyType, declaredBy }) => {
      if (config.length > MAX_CONFIG_CHARS) {
        return {
          content: [{ type: "text", text: `config is ${config.length} chars — max ${MAX_CONFIG_CHARS} (100KB). Trim it to the routes you are validating.` }],
          isError: true,
        };
      }
      if (custodyType !== undefined && !declaredBy) {
        return {
          content: [{ type: "text", text: "custodyType was given without declaredBy — say who is making the custody declaration." }],
          isError: true,
        };
      }
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(config);
      } catch (e) {
        return {
          content: [{ type: "text", text: `config is not valid JSON: ${(e as Error).message}. Fix the JSON and retry.` }],
          isError: true,
        };
      }
      try {
        const result = await apiPost<ValidateResponse>("/api/sentinel/validate", {
          snapshot,
          ...(ticker !== undefined ? { ticker } : {}),
          ...(custodyType !== undefined ? { custodyDeclaration: { custodyType, declaredBy } } : {}),
        });
        const findings = [...result.findings].sort(
          (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
        );
        const worst = findings[0];
        const remediation = result.tis.map((t) => t.action);
        const shipCall = result.riskLevel === "CRITICAL"
          ? "DO NOT SHIP this config."
          : result.riskLevel === "AT_RISK"
            ? "Shippable but weak — fix the findings first if you can."
            : "No blocking findings.";
        const text =
          `${result.riskLevel} (score ${result.score}/100, rules ${result.rulesVersion}). ${shipCall}` +
          (worst ? ` Worst finding: [${worst.severity}] ${worst.detail}` : "") +
          (remediation.length > 0 ? ` Fix: ${remediation.join("; ")}.` : "");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            score: result.score,
            riskLevel: result.riskLevel,
            rulesVersion: result.rulesVersion,
            findings,
            remediation: result.tis,
          },
        };
      } catch (e) {
        const msg = e instanceof SentinelApiError
          ? `${e.message}${e.status === 400 ? " Correct the named field and retry." : ". Retry, or check https://flare-oft-sentinel.netlify.app/flare.html."}`
          : `Unexpected failure: ${(e as Error).message}`;
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );
}
