import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListFleet } from "./tools/list-fleet.js";
import { registerGetOftConfig } from "./tools/get-oft-config.js";
import { registerGetVerdict } from "./tools/get-verdict.js";
import { registerGetDriftHistory } from "./tools/get-drift-history.js";
import { registerVerifyAttestation } from "./tools/verify-attestation.js";
import { registerValidateConfig } from "./tools/validate-config.js";

/** All six v1 tools are read+validate — the server never holds keys and never
 *  writes chain state. That boundary is the product: an agent can check a
 *  config here, but cannot be tricked into shipping one.
 *  Registration order is the tools/list order — append only (prompt caches). */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "oft-sentinel", version: "0.1.0" });
  registerListFleet(server);
  registerGetOftConfig(server);
  registerGetVerdict(server);
  registerGetDriftHistory(server);
  registerVerifyAttestation(server);
  registerValidateConfig(server);
  return server;
}
