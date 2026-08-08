import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Server } from "http";
import type { AddressInfo } from "net";

// /status resolves DVN names through loadDvnMeta() (network) — stub only that,
// same pattern as validate-route.test.ts. An empty table is fine here: these
// tests are about the SHAPE of each corridor entry, not about name resolution.
vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
  };
});

// getWatched() sources the watchlist from Dune (network) — stub it with one
// fixed asset; the snapshot store underneath is the real store, seeded below.
const OFT = "0xabc1111111111111111111111111111111111111";
const WATCHED = vi.hoisted(() => [
  { ticker: "ORBIT", address: "0xabc1111111111111111111111111111111111111", chainId: 5000 },
]);
vi.mock("../services/sentinel.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/sentinel.js")>();
  return { ...actual, getWatched: vi.fn(async () => WATCHED) };
});

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "status-corridors-"));

import { router } from "../routes/sentinel.js";
import { putSnapshot } from "../services/snapshot-store.js";

const REAL_DVN = "0x589dEDbD617e0CBcB916A9223F4d1300c294236b";
const SEND_LIB = "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2";
const RECEIVE_LIB = "0x0000000000000000000000000000000000000001";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/sentinel", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sentinel/status`;
});

afterAll(() => server.close());

function route(over: Record<string, unknown> = {}) {
  return {
    eid: 30101,
    chainName: "ethereum",
    chainKey: "ethereum",
    sendLibrary: SEND_LIB,
    sendLibIsDefault: false,
    receiveLibrary: RECEIVE_LIB,
    receiveLibIsDefault: false,
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

type Corridor = {
  corridor: string;
  eid: number;
  sendLibrary: string | null;
  sendLibIsDefault: boolean | null;
  receiveLibrary: string | null;
  receiveLibIsDefault: boolean | null;
  uln: { confirmations: number; requiredCount: number; requiredDVNs: string[] } | null;
};

async function corridors(routes: unknown[]): Promise<Corridor[]> {
  putSnapshot(snapshot({ routes }) as never);
  const res = await fetch(base);
  expect(res.status).toBe(200);
  const body = await res.json();
  const asset = body.watched.find((w: { ticker: string }) => w.ticker === "ORBIT");
  return asset.dvnCorridors as Corridor[];
}

// A rail card states the libraries a route uses and the confirmations it waits
// for. Those facts have to come off the route snapshot on every corridor —
// including the corridors whose ULN could not be read, because the libraries
// are read from the endpoint and survive an unreadable ULN.
describe("GET /api/sentinel/status — per-corridor libraries and confirmations", () => {
  it("exposes both libraries, both default flags and uln.confirmations on a readable route", async () => {
    const [c] = await corridors([route()]);
    expect(c.corridor).toBe("ethereum");
    expect(c.eid).toBe(30101);
    expect(c.sendLibrary).toBe(SEND_LIB);
    expect(c.sendLibIsDefault).toBe(false);
    expect(c.receiveLibrary).toBe(RECEIVE_LIB);
    expect(c.receiveLibIsDefault).toBe(false);
    expect(c.uln?.confirmations).toBe(64);
    // the pre-existing ULN fields are untouched by the addition
    expect(c.uln?.requiredCount).toBe(1);
    expect(c.uln?.requiredDVNs).toEqual([REAL_DVN]);
  });

  it("still carries the library fields when the ULN could not be read", async () => {
    const [c] = await corridors([route({ uln: null })]);
    expect(c.uln).toBeNull();
    expect(c.sendLibrary).toBe(SEND_LIB);
    expect(c.sendLibIsDefault).toBe(false);
    expect(c.receiveLibrary).toBe(RECEIVE_LIB);
    expect(c.receiveLibIsDefault).toBe(false);
  });

  it("reports a default library as true rather than as a missing field", async () => {
    const [c] = await corridors([route({ sendLibIsDefault: true, receiveLibIsDefault: true })]);
    expect(c.sendLibIsDefault).toBe(true);
    expect(c.receiveLibIsDefault).toBe(true);
  });

  // An unread library is null. It must arrive as null — not omitted, and not
  // flattened into a string — so a consumer can tell "not read" from "read".
  it("serves unread libraries as null, present and uncoerced", async () => {
    const [c] = await corridors([
      route({
        sendLibrary: null,
        sendLibIsDefault: null,
        receiveLibrary: null,
        receiveLibIsDefault: null,
      }),
    ]);
    for (const key of ["sendLibrary", "sendLibIsDefault", "receiveLibrary", "receiveLibIsDefault"] as const) {
      expect(key in c).toBe(true);
      expect(c[key]).toBeNull();
    }
    // and the readable half of the same route is still served
    expect(c.uln?.confirmations).toBe(64);
  });

  it("keeps every corridor's own libraries — one unreadable route does not blank the others", async () => {
    const list = await corridors([
      route(),
      route({ eid: 30184, chainName: "base", uln: null, sendLibrary: null, sendLibIsDefault: null }),
    ]);
    expect(list).toHaveLength(2);
    expect(list[0].sendLibrary).toBe(SEND_LIB);
    expect(list[0].uln?.confirmations).toBe(64);
    expect(list[1].sendLibrary).toBeNull();
    expect(list[1].receiveLibrary).toBe(RECEIVE_LIB);
    expect(list[1].uln).toBeNull();
  });

  // /status is the same endpoint the production frontend consumes. The addition
  // is additive: nothing that was already served may change.
  it("leaves dvnSummary and dvnNames untouched", async () => {
    putSnapshot(snapshot() as never);
    const body = await (await fetch(base)).json();
    const asset = body.watched.find((w: { ticker: string }) => w.ticker === "ORBIT");
    expect(asset.dvnSummary).toEqual({
      requiredCount: 1,
      optionalThreshold: 0,
      effectiveCount: 1,
      requiredDVNs: [REAL_DVN],
      optionalDVNs: [],
    });
    expect(Object.keys(asset.dvnNames)).toEqual([REAL_DVN]);
  });
});
