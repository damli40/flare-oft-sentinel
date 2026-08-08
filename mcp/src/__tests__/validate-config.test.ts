import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.js";

const snapshot = {
  oft: "0xabc1111111111111111111111111111111111111",
  chainId: 5000,
  routes: [{ eid: 30101, uln: { confirmations: 64, requiredDVNCount: 1, requiredDVNs: ["0x589dEDbD617e0CBcB916A9223F4d1300c294236b"], optionalDVNCount: 0, optionalDVNThreshold: 0, optionalDVNs: [] } }],
};

const backendResult = {
  score: 0,
  riskLevel: "CRITICAL",
  rulesVersion: "4.1.0",
  findings: [
    { severity: "MEDIUM", check: "Confirmations", detail: "eid-30101: 64 confirmations fine" },
    { severity: "CRITICAL", check: "DVN Count", detail: "eid-30101: 1 effective DVN — single point of failure" },
  ],
  tis: [{ intent: "add_dvn", action: "Add a second required DVN", severity: "CRITICAL" }],
};

async function connectedClient() {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server — validate_config", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the parsed config and returns findings worst-first with a next step", async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/api/sentinel/validate");
      const body = JSON.parse(String(init?.body));
      expect(body.snapshot.oft).toBe(snapshot.oft);
      expect(body.custodyDeclaration).toEqual({ custodyType: "fireblocks_mpc", declaredBy: "agent operator" });
      return new Response(JSON.stringify(backendResult), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connectedClient();
    const res = await client.callTool({
      name: "validate_config",
      arguments: {
        config: JSON.stringify(snapshot),
        custodyType: "fireblocks_mpc",
        declaredBy: "agent operator",
      },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { riskLevel: string; findings: Array<{ severity: string }> };
    expect(sc.riskLevel).toBe("CRITICAL");
    expect(sc.findings[0].severity).toBe("CRITICAL");
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("CRITICAL");
    expect(text).toContain("single point of failure");
    expect(text).toContain("Add a second required DVN");
    expect(text.toLowerCase()).toContain("do not ship");
  });

  it("rejects malformed JSON without calling the backend", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connectedClient();
    const res = await client.callTool({ name: "validate_config", arguments: { config: "{not json" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("JSON");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an oversized config without calling the backend", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connectedClient();
    const big = JSON.stringify({ ...snapshot, pad: "x".repeat(120_000) });
    const res = await client.callTool({ name: "validate_config", arguments: { config: big } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("100");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces backend 400s with the backend's reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "snapshot.routes must be an array" }), { status: 400 })));
    const client = await connectedClient();
    const res = await client.callTool({ name: "validate_config", arguments: { config: JSON.stringify({ oft: snapshot.oft }) } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("routes must be an array");
  });

  it("requires declaredBy when custodyType is given", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connectedClient();
    const res = await client.callTool({
      name: "validate_config",
      arguments: { config: JSON.stringify(snapshot), custodyType: "fireblocks_mpc" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("declaredBy");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
