import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, toFunctionSelector } from "viem";
import express from "express";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Server } from "http";
import type { AddressInfo } from "net";

// GET /status must publish every verdict whether or not the price read worked.
// The verdict is the product; a price is a nice-to-have bolted onto the same
// response, and ftso.ts THROWS on transport failure by design. This drives the
// REAL route with the REAL wrapper and only the oracle read faked, because the
// thing being checked is exactly what the route does with that throw.

// /status resolves DVN names through loadDvnMeta() (network) — stubbed the same
// way status-corridors.test.ts and validate-route.test.ts stub it. An empty
// table is fine: nothing here is about name resolution.
vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
  };
});

// The `token()` probe exposure.ts runs before pricing is the only OTHER on-chain
// read on this path. Stubbed to "no answer" so the test stays hermetic; the
// fallback that runs is exactly what a chain with no answer produces, and the
// probe's own behaviour is pinned in exposure.test.ts against a fake node.
// `shape` selects what the chain appears to be. "none" is the original
// behaviour — every call unanswered, so every asset classifies as a plain OFT.
// "lockboxEmpty" makes the watched contract an ADAPTER that custodies nothing
// while the token it moves has a supply, which is the live USDT0 shape and the
// only one that sets `mintsOnArrival`. Without it, `basis: "circulating"` was
// the sole shape this route was ever proven to serialise.
const chain = vi.hoisted(() => ({ shape: "none" as "none" | "lockboxEmpty" }));
const UNDERLYING = "0xdddd000000000000000000000000000000000001";

const TOKEN_ABI = [
  { name: "token", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

vi.mock("../services/multicall.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/multicall.js")>();
  return {
    ...actual,
    aggregate3Batch: vi.fn(async (_call: unknown, calls: Array<{ callData: string }>) => {
      if (chain.shape === "none") return calls.map(() => null);
      const tokenSel = toFunctionSelector("token()");
      const balSel = toFunctionSelector("balanceOf(address)");
      return calls.map((c) => {
        if (c.callData.startsWith(tokenSel)) {
          return encodeFunctionResult({ abi: TOKEN_ABI, functionName: "token", result: UNDERLYING });
        }
        if (c.callData.startsWith(balSel)) {
          // Custodies nothing. The supply the oracle mock reports is non-zero,
          // which is what makes this the mint-on-arrival shape rather than a
          // failed read.
          return encodeFunctionResult({ abi: BALANCE_ABI, functionName: "balanceOf", result: 0n });
        }
        return null;
      });
    }),
  };
});

const PRICED = "0xabc1111111111111111111111111111111111111";
const UNPRICEABLE = "0xabc2222222222222222222222222222222222222";
const CHAIN_ID = 14;

const WATCHED = vi.hoisted(() => [
  { ticker: "FXRP", address: "0xabc1111111111111111111111111111111111111", chainId: 14 },
  { ticker: "MOFT", address: "0xabc2222222222222222222222222222222222222", chainId: 14 },
]);
vi.mock("../services/sentinel.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/sentinel.js")>();
  return { ...actual, getWatched: vi.fn(async () => WATCHED) };
});

// The oracle read itself is the only faked part. `mode` flips it between a
// healthy answer and the transport failure ftso.ts is documented to throw on.
const oracle = vi.hoisted(() => ({ mode: "ok" as "ok" | "throw" }));
vi.mock("../services/ftso.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/ftso.js")>();
  return {
    ...actual,
    readExposure: vi.fn(async (assets: Array<{ address: string; ticker?: string | null }>) => {
      if (oracle.mode === "throw") throw new Error("429 Too Many Requests");
      return assets.map((a) => {
        const feed = actual.feedForTicker(a.ticker);
        return {
          address: a.address,
          ticker: a.ticker ?? null,
          feed,
          // A bigint, exactly as the real module returns one — the wrapper is
          // what has to turn it into something res.json() can serialise.
          supply: 1_000_000_000_000n,
          decimals: 6,
          priceUsd: feed ? 1.044395 : null,
          valueUsd: feed ? 1_044_395 : null,
          feedTimestamp: feed ? 1_000 : null,
          stale: false,
        };
      });
    }),
  };
});

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "status-exposure-"));

import { router } from "../routes/sentinel.js";
import { putSnapshot } from "../services/snapshot-store.js";
import { resetExposureCache } from "../services/exposure.js";

const REAL_DVN = "0x589dEDbD617e0CBcB916A9223F4d1300c294236b";

let server: Server;
let base: string;

function snapshot(oft: string) {
  return {
    oft,
    chainId: CHAIN_ID,
    capturedAt: 1700000000000,
    owner: "0x1234567890123456789012345678901234567890",
    ownerIsContract: false,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes: [
      {
        eid: 30101,
        chainName: "ethereum",
        chainKey: "ethereum",
        sendLibrary: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2",
        sendLibIsDefault: false,
        receiveLibrary: "0x0000000000000000000000000000000000000001",
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
      },
    ],
  };
}

type Row = {
  ticker: string;
  assessment: { score: number; riskLevel: string; reasons: string[] } | null;
  exposure: {
    feed: string | null;
    amount: string | null;
    basis: string | null;
    decimals: number | null;
    priceUsd: number | null;
    valueUsd: number | null;
    stale: boolean;
    readAt: number;
  } | null;
};

async function status(): Promise<Row[]> {
  const res = await fetch(base);
  expect(res.status).toBe(200);
  return (await res.json()).watched as Row[];
}

beforeAll(async () => {
  vi.stubEnv("SENTINEL_CHAIN_ID", String(CHAIN_ID));
  putSnapshot(snapshot(PRICED) as never);
  putSnapshot(snapshot(UNPRICEABLE) as never);
  const app = express();
  app.use(express.json());
  app.use("/api/sentinel", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sentinel/status`;
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  resetExposureCache();
  // Reset the chain shape too. A test that leaves it set would silently
  // change what every later test is reading from.
  chain.shape = "none";
});

describe("GET /status — a failed price read never costs a verdict", () => {
  it("serves every verdict, with exposure null, when the oracle read throws", async () => {
    oracle.mode = "throw";
    const rows = await status();

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // The product survives intact.
      expect(row.assessment, `${row.ticker} lost its assessment`).not.toBeNull();
      expect(typeof row.assessment!.score).toBe("number");
      expect(row.assessment!.riskLevel).toBeTruthy();
      // And the price is stated as absent — present as a field, null as a value,
      // so a consumer can tell "not read" from "not served by this instance".
      expect("exposure" in row).toBe(true);
      expect(row.exposure).toBeNull();
    }
  });

  it("serves the same verdicts, now with exposure, once the read succeeds", async () => {
    oracle.mode = "throw";
    const degraded = await status();
    resetExposureCache();

    oracle.mode = "ok";
    const healthy = await status();

    // The verdicts are byte-identical across the two: exposure is additive and
    // reaches nothing the engine reads.
    expect(healthy.map((r) => r.assessment)).toEqual(degraded.map((r) => r.assessment));

    const priced = healthy.find((r) => r.ticker === "FXRP")!;
    expect(priced.exposure).not.toBeNull();
    expect(priced.exposure!.feed).toBe("XRP/USD");
    expect(priced.exposure!.valueUsd).toBeCloseTo(1_044_395, 3);
    // The raw amount survived JSON as a string. A bigint here would have made
    // res.json() throw and taken the whole response down, not just the price.
    expect(priced.exposure!.amount).toBe("1000000000000");
    expect(priced.exposure!.basis).toBe("circulating");
    expect(typeof priced.exposure!.readAt).toBe("number");
  });

  it("serves an unpriceable asset with a null feed rather than a zero", async () => {
    oracle.mode = "ok";
    const rows = await status();
    const none = rows.find((r) => r.ticker === "MOFT")!;

    expect(none.exposure).not.toBeNull();
    expect(none.exposure!.feed).toBeNull();
    expect(none.exposure!.priceUsd).toBeNull();
    expect(none.exposure!.valueUsd).toBeNull();
    // Zero would be a claim. Null is the read.
    expect(none.exposure!.valueUsd).not.toBe(0);
    expect(none.exposure!.amount).toBe("1000000000000"); // the amount reads fine regardless
  });

  it("serialises a CUSTODIED row, with the mint flag, through the real route", async () => {
    // Until this existed, every row this route was proven to serve came back
    // `circulating`, because the chain mock answered nothing and everything
    // classified as a plain OFT. The shape that actually ships on Flare is a
    // lockbox adapter, and the one that carries an explanation is a lockbox
    // custodying nothing. Neither had ever survived res.json() in a test.
    oracle.mode = "ok";
    chain.shape = "lockboxEmpty";
    resetExposureCache();

    const rows = await status();
    const row = rows.find((r) => r.ticker === "FXRP")!;

    expect(row.exposure).not.toBeNull();
    expect(row.exposure!.basis).toBe("custodied");
    // Zero CUSTODIED, not the underlying's supply. This is the whole point of
    // the shape split: `1000000000000` here would be the fabricated figure.
    expect(row.exposure!.amount).toBe("0");
    expect(row.exposure!.amount).not.toBe("1000000000000");
    expect(row.exposure!.valueUsd).toBe(0);
    // A measured zero is still a price read. Null would mean we never asked.
    expect(row.exposure!.priceUsd).not.toBeNull();

    // The flag that earns the page its explanation, surviving JSON.
    expect((row.exposure as unknown as { mintsOnArrival: boolean }).mintsOnArrival).toBe(true);
    // And the figure is attributed to the contract it was read from, which is
    // NOT the address the row links to.
    expect((row.exposure as unknown as { pricedToken: string }).pricedToken.toLowerCase())
      .toBe(UNDERLYING.toLowerCase());

    // The verdict is untouched by any of it.
    expect(row.assessment).not.toBeNull();
  });
});
