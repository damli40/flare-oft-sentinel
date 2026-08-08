#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

// stdout belongs to the JSON-RPC transport; every log line goes to stderr.
async function main() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error("[oft-sentinel-mcp] ready (stdio)");
}

main().catch((e) => {
  console.error("[oft-sentinel-mcp] fatal:", e);
  process.exit(1);
});
