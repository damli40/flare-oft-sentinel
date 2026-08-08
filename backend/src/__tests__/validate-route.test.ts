import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Server } from "http";
import type { AddressInfo } from "net";

// assessSnapshot calls loadDvnMeta() (network) — stub only that, same pattern
// as dead-dvn.test.ts. Everything else in the engine runs for real.
vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
  };
});

// getWatched() sources the watchlist from Dune (network) — stub only that with
// a fixed fleet; the snapshot cache underneath it is the real store, seeded
// below with putSnapshot.
const WATCHED = vi.hoisted(() => [
  { ticker: "ORBIT", address: "0xaaaa000000000000000000000000000000000001", chainId: 5000 },
  { ticker: "USDT0", address: "0xbbbb000000000000000000000000000000000002", chainId: 196 },
  { ticker: "USDT0", address: "0xcccc000000000000000000000000000000000003", chainId: 1 },
  { ticker: "COLD", address: "0xdddd000000000000000000000000000000000004", chainId: 5000 },
  { ticker: "OLDY", address: "0xeeee000000000000000000000000000000000005", chainId: 5000 },
]);
vi.mock("../services/sentinel.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/sentinel.js")>();
  return { ...actual, getWatched: vi.fn(async () => WATCHED) };
});

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "validate-route-"));

import { router } from "../routes/sentinel.js";
import { putSnapshot } from "../services/snapshot-store.js";

const REAL_DVN = "0x589dEDbD617e0CBcB916A9223F4d1300c294236b";
const OFT = "0xabc1111111111111111111111111111111111111";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/sentinel", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sentinel/validate`;
});

afterAll(() => server.close());

function route(over: Record<string, unknown> = {}) {
  return {
    eid: 30101,
    chainName: "ethereum",
    chainKey: "ethereum",
    sendLibrary: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2",
    sendLibIsDefault: true,
    receiveLibrary: "0x0000000000000000000000000000000000000001",
    receiveLibIsDefault: true,
    uln: {
      confirmations: 64,
      requiredDVNCount: 1,
      requiredDVNs: [REAL_DVN],
      optionalDVNCount: 0,
      optionalDVNThreshold: 0,
      optionalDVNs: [],
    },
    receiveUln: null,
    peer: "0x88A19F30E1254B37b66899893ab1F73aD82BD2C3",
    peerAddress: "0x88A19F30E1254B37b66899893ab1F73aD82BD2C3",
    hasEnforcedOptions: null,
    isActive: true,
    ...over,
  };
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    oft: OFT,
    chainId: 5000,
    capturedAt: 1700000000000,
    owner: "0x1234567890123456789012345678901234567890",
    ownerIsContract: false,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes: [route()],
    ...over,
  };
}

function post(body: unknown) {
  return fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/sentinel/validate", () => {
  it("scores a 1-of-1 DVN config CRITICAL — the single-DVN shape", async () => {
    const res = await post({ snapshot: snapshot() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskLevel).toBe("CRITICAL");
    expect(typeof body.score).toBe("number");
    expect(body.rulesVersion).toBe("5.0.0");
    expect(body.findings.some((f: { check: string; severity: string }) => /dvn/i.test(f.check) && f.severity === "CRITICAL")).toBe(true);
    expect(Array.isArray(body.tis)).toBe(true);
  });

  it("consumes a custody declaration — same config, different findings", async () => {
    const bare = await (await post({ snapshot: snapshot() })).json();
    const declared = await (await post({
      snapshot: snapshot(),
      custodyDeclaration: { custodyType: "fireblocks_mpc", declaredBy: "team (relayed)" },
    })).json();
    expect(JSON.stringify(declared.findings)).not.toEqual(JSON.stringify(bare.findings));
    expect(declared.score).toBeGreaterThanOrEqual(bare.score);
  });

  it("rejects more than 30 routes with 400", async () => {
    const routes = Array.from({ length: 31 }, (_, i) => route({ eid: 30000 + i }));
    const res = await post({ snapshot: snapshot({ routes }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/routes/i);
  });

  // OKX's escrow re-test (Jul 21): a buyer pastes the config a human actually
  // holds — ticker, routes with chain names, DVNs, confirmations — and no
  // contract address. That paste must produce a real verdict, not a 400.
  it("scores a buyer paste with no OFT address — the OKX MYTKN shape", async () => {
    const res = await post({
      snapshot: {
        token: "MYTKN",
        routes: [{
          chainName: "ethereum",
          dvns: [REAL_DVN],
          confirmations: 20,
          libraries: { send: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2", receive: "0x0000000000000000000000000000000000000001" },
        }],
      },
      ticker: "MYTKN",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskLevel).toBe("CRITICAL"); // 1-of-1 DVN still fires on the lifted ULN
    expect(body.findings.some((f: { check: string }) => /oft address/i.test(f.check))).toBe(true);
    const advisory = body.findings.find((f: { check: string }) => /oft address/i.test(f.check));
    expect(advisory.severity).toBe("UNKNOWN");
    expect(advisory.evidence).toBe("unverifiable");
  });

  it("resolves route chain names to eids and flags an unknown source chain", async () => {
    const res = await post({
      snapshot: { oft: OFT, routes: [route({ eid: undefined, chainName: "ethereum" })] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskLevel).toBe("CRITICAL");
    expect(body.findings.some((f: { check: string }) => /source chain/i.test(f.check))).toBe(true);
  });

  it("validates top-level dvns/confirmations as a single synthesized route", async () => {
    const res = await post({ snapshot: { dvns: [REAL_DVN], confirmations: 20 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.riskLevel).toBe("CRITICAL"); // 1-of-1
    expect(body.findings.some((f: { check: string }) => /routes/i.test(f.check))).toBe(true);
  });

  it("answers an unscoreable config with a plain-language 200, never a raw 400", async () => {
    for (const snap of [{}, { oft: "not-an-address", chainId: 5000, routes: [] }, snapshot({ routes: "nope" })]) {
      const res = await post({ snapshot: snap });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.incomplete).toBe(true);
      expect(body.riskLevel).toBeNull();
      expect(body.message).toMatch(/routes/i);
      expect(body.missing).toContain("routes");
      expect(body.rulesVersion).toBe("5.0.0");
    }
  });

  it("answers unpaid snapshot-less requests with an x402 challenge", async () => {
    for (const res of [await fetch(base), await post({})]) {
      expect(res.status).toBe(402);
      const header = res.headers.get("payment-required");
      expect(header).toBeTruthy();
      const challenge = JSON.parse(Buffer.from(header!, "base64").toString());
      expect(challenge.x402Version).toBe(2);
      expect(challenge.accepts).toHaveLength(1);
      // 0.01 USDT at 6 decimals. A zero amount is valid x402 but OKX's buyer-side
      // task-402-pay cannot convert "0 USDT" to minimal units (their Jul 21 report),
      // so the listed fee and this challenge both carry 0.01.
      // maxTimeoutSeconds 300 matches the canonical example in OKX's A2MCP guide
      // (dev-docs/okxai/howtomcp) — the buyer's signature validity window derives
      // from it, and their round-1 report flagged tight timeout budgets.
      expect(challenge.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:196", amount: "10000", maxTimeoutSeconds: 300 });
    }
  });

  // Caught by the live paid self-test (Jul 24, round 5): the payment settled but
  // the deliverable was the usage hint, not a verdict. Buyer CLIs only attach
  // parameters the seller DECLARES — they never invent a request shape — so an
  // undeclared input schema means the paid replay carries an empty body and the
  // buyer pays for a hint. The challenge must declare the ticker body itself.
  it("declares the paid request shape so a buyer CLI can attach the ticker", async () => {
    const header = (await post({})).headers.get("payment-required");
    const { accepts } = JSON.parse(Buffer.from(header!, "base64").toString());
    const input = accepts[0].outputSchema?.input;
    expect(input).toBeTruthy();
    expect(input.type).toBe("http");
    expect(input.method).toBe("POST");
    expect(input.bodyType).toBe("json");
    // ticker is REQUIRED in the declaration: an optional param the buyer did not
    // supply is dropped by the CLI, which is exactly how round 5 produced an
    // empty body. Required means the CLI collects it before paying.
    expect(input.body.required).toContain("ticker");
    expect(input.body.properties.ticker.type).toBe("string");
    expect(Object.keys(input.body.properties)).toContain("chainId");
  });

  // OKX's spec carries no machine-readable input schema (A2MCP Guide's
  // challenge has no schema field; ASP registration takes only name /
  // description / price / endpoint), so the description IS the interface
  // contract — it is what a buying agent reads to compose the request.
  it("states the request shape in the description, the only channel OKX specs", async () => {
    const header = (await post({})).headers.get("payment-required");
    const { resource } = JSON.parse(Buffer.from(header!, "base64").toString());
    expect(resource.description).toMatch(/ticker/i);
    expect(resource.description).toMatch(/POST/);
  });

  // Caught by the live buyer-flow self-test (Jul 21): the OKX CLI replays with
  // the same method it probed with — GET — and the old GET route challenged
  // unconditionally, so a paying buyer was 402'd forever ("facilitator
  // non-terminal: HTTP 402"). A paid GET must serve a deliverable.
  // A paid GET carries no body, so it cannot name an asset — it still must not
  // cost a cent for a usage hint. The fleet answer is the deliverable.
  it("serves a paid GET replay a deliverable, not another challenge", async () => {
    const res = await fetch(base, { headers: { "payment-signature": "signed-by-okx-escrow" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("fleet");
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.message).toMatch(/ticker/i);
  });

  it("serves a paid replay; a paid replay with no config still answers with the fleet", async () => {
    const paid = (body: unknown) =>
      fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "payment-signature": "signed-by-okx-escrow" },
        body: JSON.stringify(body),
      });
    expect((await paid({ snapshot: snapshot() })).status).toBe(200);
    const empty = await paid({});
    expect(empty.status).toBe(200);
    const body = await empty.json();
    expect(body.scope).toBe("fleet");
    expect(body.incomplete).toBeUndefined();
  });

  it("is pure — validating does not create a verdict", async () => {
    const before = await (await fetch(base.replace("/validate", "/verdicts"))).json();
    await post({ snapshot: snapshot() });
    const after = await (await fetch(base.replace("/validate", "/verdicts"))).json();
    expect(after.verdicts.length).toBe(before.verdicts.length);
  });
});

// A paying buyer who already holds the full config has done the hard part
// themselves — the listed promise of agent #6455 is address-in, verdict-out.
// A paid { ticker } body reads the watchlist's hourly-poll cache; no live
// on-chain read on the request path (its ~900s worst-case tail would blow the
// 300s payment window).
describe("POST /api/sentinel/validate — paid ticker cache lookup", () => {
  const FRESH_AT = Date.now() - 30 * 60_000; // half an hour: inside the hourly cycle
  const STALE_AT = Date.now() - 3 * 3_600_000; // 3h: poller missed at least one cycle

  beforeAll(() => {
    // Seed the real snapshot store for every watched ticker except COLD
    // (watched but never polled). The 1-of-1 DVN route scores CRITICAL.
    putSnapshot(snapshot({ oft: WATCHED[0].address, chainId: 5000, capturedAt: FRESH_AT }) as never);
    putSnapshot(snapshot({ oft: WATCHED[1].address, chainId: 196, capturedAt: FRESH_AT }) as never);
    putSnapshot(snapshot({ oft: WATCHED[2].address, chainId: 1, capturedAt: FRESH_AT }) as never);
    putSnapshot(snapshot({ oft: WATCHED[4].address, chainId: 5000, capturedAt: STALE_AT }) as never);
  });

  function paidPost(body: unknown) {
    return fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": "signed-by-okx-escrow" },
      body: JSON.stringify(body),
    });
  }

  it("serves a paid bare ticker a cached verdict — case-insensitive", async () => {
    const res = await paidPost({ ticker: "orbit" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("cache");
    expect(body.results).toHaveLength(1);
    const r = body.results[0];
    expect(r.oft).toBe(WATCHED[0].address);
    expect(r.chainId).toBe(5000);
    expect(typeof r.score).toBe("number");
    expect(r.riskLevel).toBe("CRITICAL"); // seeded 1-of-1 DVN shape
    expect(r.rulesVersion).toBe("5.0.0");
    expect(r.asOf).toBe(FRESH_AT);
    expect(r.stale).toBe(false);
    expect(r.findings.some((f: { check: string }) => /freshness/i.test(f.check))).toBe(false);
  });

  it("returns one result per chain for a multi-chain ticker", async () => {
    const body = await (await paidPost({ ticker: "USDT0" })).json();
    expect(body.results).toHaveLength(2);
    expect(body.results.map((r: { chainId: number }) => r.chainId).sort()).toEqual([1, 196]);
  });

  it("narrows a multi-chain ticker with chainId", async () => {
    const body = await (await paidPost({ ticker: "USDT0", chainId: 196 })).json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].chainId).toBe(196);
    expect(body.results[0].oft).toBe(WATCHED[1].address);
  });

  it("answers an unknown ticker with a no-charge hint, not a score", async () => {
    const res = await paidPost({ ticker: "NOPE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.incomplete).toBe(true);
    expect(body.missing).toContain("ticker");
    expect(body.riskLevel).toBeNull();
    expect(body.message).toMatch(/watchlist/i);
  });

  it("marks a watched-but-never-polled ticker incomplete per match", async () => {
    const body = await (await paidPost({ ticker: "COLD" })).json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].incomplete).toBe(true);
    expect(body.results[0].score).toBeUndefined();
    expect(body.results[0].message).toMatch(/not yet polled/i);
  });

  it("surfaces a freshness advisory on a stale cached verdict", async () => {
    const body = await (await paidPost({ ticker: "OLDY" })).json();
    const r = body.results[0];
    expect(r.stale).toBe(true);
    expect(r.ageMs).toBeGreaterThan(2 * 3_600_000);
    const advisory = r.findings.find((f: { check: string }) => /freshness/i.test(f.check));
    expect(advisory).toBeTruthy();
    expect(advisory.severity).toBe("UNKNOWN");
    expect(advisory.evidence).toBe("unverifiable");
  });

  it("still answers an unpaid bare ticker with the x402 challenge", async () => {
    const res = await post({ ticker: "ORBIT" });
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTruthy();
  });

  // OKX's spec (A2MCP Guide + ASP Registration, checked Jul 24) has no
  // machine-readable input schema — a buying agent reads the description and
  // builds the request itself, so some buyers will always pay with an empty
  // body. Nobody may pay a cent for a usage hint: an empty paid body returns
  // the whole monitored fleet, which is the widest honest answer to "what do
  // you know?" (the same data /status already serves publicly and free).
  it("serves a paid empty body the whole fleet, never a bare usage hint", async () => {
    const res = await paidPost({});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("cache");
    expect(body.scope).toBe("fleet");
    expect(body.results).toHaveLength(WATCHED.length);
    expect(body.results.map((r: { ticker: string }) => r.ticker)).toEqual(WATCHED.map((w) => w.ticker));
    const orbit = body.results.find((r: { ticker: string }) => r.ticker === "ORBIT");
    expect(typeof orbit.score).toBe("number"); // scored, not a hint
    expect(orbit.riskLevel).toBe("CRITICAL");
    expect(orbit.asOf).toBe(FRESH_AT);
    // the never-polled and stale members stay honestly labelled in the fleet view
    expect(body.results.find((r: { ticker: string }) => r.ticker === "COLD").incomplete).toBe(true);
    const oldy = body.results.find((r: { ticker: string }) => r.ticker === "OLDY");
    expect(oldy.stale).toBe(true);
    expect(oldy.findings.some((f: { check: string }) => /freshness/i.test(f.check))).toBe(true);
  });

  it("tells a paid empty-body buyer how to narrow the answer", async () => {
    const body = await (await paidPost({})).json();
    expect(body.message).toMatch(/ticker/i);
  });

  it("keeps the fleet answer pure — no verdict is created", async () => {
    const before = await (await fetch(base.replace("/validate", "/verdicts"))).json();
    await paidPost({});
    const after = await (await fetch(base.replace("/validate", "/verdicts"))).json();
    expect(after.verdicts.length).toBe(before.verdicts.length);
  });
});
