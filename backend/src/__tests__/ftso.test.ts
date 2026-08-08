import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, type Address } from "viem";

import {
  FTSOV2_ADDRESS,
  feedId,
  feedForTicker,
  FEED_STALE_AFTER_S,
  readExposure,
  type Exposure,
} from "../services/ftso.js";
import { revertWith, multicallHandler, type Handler } from "./helpers/fake-rpc.js";

// assessSnapshot (drift.ts) calls loadDvnMeta() (network) unconditionally.
// Stubbed exactly as dead-dvn.test.ts does, so the determinism guard below
// runs hermetically. None of ftso.ts's own tests touch lz-config.js at all —
// that is precisely what the import-isolation guard below checks.
vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
  };
});

import { assessSnapshot } from "../services/drift.js";
import type { OftSnapshot, RouteSnapshot, UlnSnapshot } from "../types.js";

// ── Local ABIs, independent of ftso.ts's own copies ──────────────────────────
// Mirrors multicall.test.ts's philosophy for its golden vectors: a fixture built
// from the SAME ABI object the implementation encodes with can't catch the
// implementation asking the wrong question. These are declared fresh here.
const ERC20_ABI = [
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const FTSOV2_ABI = [
  {
    name: "getFeedsById",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "_feedIds", type: "bytes21[]" }],
    outputs: [
      { name: "_values", type: "uint256[]" },
      { name: "_decimals", type: "int8[]" },
      { name: "_timestamp", type: "uint64" },
    ],
  },
] as const;

const TOTAL_SUPPLY_SEL = encodeFunctionData({ abi: ERC20_ABI, functionName: "totalSupply" }).slice(0, 10);
const DECIMALS_SEL = encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }).slice(0, 10);
const GET_FEEDS_SEL = encodeFunctionData({ abi: FTSOV2_ABI, functionName: "getFeedsById", args: [[]] }).slice(0, 10);

// ── Fixture builders ──────────────────────────────────────────────────────
type TokenAnswer = { supply?: bigint | "revert"; decimals?: number | "revert" };

/** Answers totalSupply()/decimals() for a fixed set of token addresses.
 *  Unmodelled selectors/addresses answer "0x" (no answer), same convention
 *  fake-rpc.ts's fullHandler uses. */
function tokenHandler(book: Record<string, TokenAnswer>): Handler {
  return (to, data) => {
    const entry = book[to.toLowerCase()];
    if (!entry) return "0x";
    const sel = data.slice(0, 10);
    if (sel === TOTAL_SUPPLY_SEL) {
      if (entry.supply === undefined) return "0x";
      if (entry.supply === "revert") return revertWith("0x");
      return encodeFunctionResult({ abi: ERC20_ABI, functionName: "totalSupply", result: entry.supply });
    }
    if (sel === DECIMALS_SEL) {
      if (entry.decimals === undefined) return "0x";
      if (entry.decimals === "revert") return revertWith("0x");
      return encodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", result: entry.decimals });
    }
    return "0x";
  };
}

/** Answers FtsoV2.getFeedsById for a fixed, ordered set of feeds sharing one timestamp
 *  (the real contract returns exactly one uint64 timestamp per call, not one per feed). */
function feedsHandler(feeds: { name: string; value: bigint; decimals: number }[], timestamp: bigint): Handler {
  return (to, data) => {
    if (to.toLowerCase() !== FTSOV2_ADDRESS.toLowerCase()) return "0x";
    if (data.slice(0, 10) !== GET_FEEDS_SEL) return "0x";
    return encodeFunctionResult({
      abi: FTSOV2_ABI,
      functionName: "getFeedsById",
      result: [feeds.map((f) => f.value), feeds.map((f) => f.decimals), timestamp],
    });
  };
}

function combine(...handlers: Handler[]): Handler {
  return (to, data) => {
    for (const h of handlers) {
      const r = h(to, data);
      if (r !== "0x") return r;
    }
    return "0x";
  };
}

/** Wrap a per-selector Handler into the `call` shape readExposure/aggregate3Batch
 *  take, via fake-rpc.ts's multicallHandler (the aggregate3-wire-format piece of
 *  that file — the only part that fits: readExposure's `call` is a bare
 *  `(to, data) => Promise<string>`, not the RpcClient object the rest of
 *  fake-rpc.ts is built around). `log`, if given, records every SUB-call the
 *  aggregate3 batch actually carried, post-decode. */
function fakeCall(
  inner: Handler,
  log?: { to: string; data: string }[],
): (to: string, data: string) => Promise<string> {
  const wrapped = multicallHandler((to, data) => {
    log?.push({ to, data });
    return inner(to, data);
  });
  return async (to, data) => wrapped(to as Address, data);
}

const FLR_ADDR = ("0x" + "11".repeat(20)) as Address;
const WFLR_ADDR = ("0x" + "22".repeat(20)) as Address;
const XRP_ADDR = ("0x" + "33".repeat(20)) as Address;
const DINERO_ADDR = ("0x" + "44".repeat(20)) as Address;

// ─────────────────────────────────────────────────────────────────────────
describe("FTSOV2_ADDRESS", () => {
  it("is the verified Flare Mainnet FtsoV2 address", () => {
    expect(FTSOV2_ADDRESS.toLowerCase()).toBe("0x7bde3df0624114edb3a67dfe6753e62f4e7c1d20");
  });
});

describe("feedId", () => {
  it("matches the documented worked example exactly", () => {
    expect(feedId("01", "FLR/USD")).toBe("0x01464c522f55534400000000000000000000000000");
  });

  it("is always 21 bytes: 0x + 42 hex chars", () => {
    expect(feedId("01", "XRP/USD")).toHaveLength(44);
    expect(feedId("01", "X")).toHaveLength(44);
  });

  it("throws rather than silently truncating a name that doesn't fit in 20 bytes", () => {
    expect(() => feedId("01", "A".repeat(21))).toThrow(/exceeds 20 bytes/);
  });

  it.each(["1", "abc", "gg", "", "0x01"])(
    "throws on a malformed category %j rather than emitting a differently-shaped ID",
    (bad) => {
      expect(() => feedId(bad, "FLR/USD")).toThrow(/category must be exactly 2 hex chars/);
    },
  );
});

describe("feedForTicker", () => {
  it.each([
    ["FLR", "FLR/USD"],
    ["WFLR", "FLR/USD"],
    ["FXRP", "XRP/USD"],
    ["XRP", "XRP/USD"],
    ["USDT", "USDT/USD"],
    ["USDT0", "USDT/USD"],
    ["USDC", "USDC/USD"],
    ["ETH", "ETH/USD"],
    ["WETH", "ETH/USD"],
  ])("%s -> %s", (ticker, feed) => {
    expect(feedForTicker(ticker)).toBe(feed);
  });

  it("is case-insensitive", () => {
    expect(feedForTicker("flr")).toBe("FLR/USD");
    expect(feedForTicker("uSdT0")).toBe("USDT/USD");
  });

  it("returns null for null, undefined and empty string", () => {
    expect(feedForTicker(null)).toBeNull();
    expect(feedForTicker(undefined)).toBeNull();
    expect(feedForTicker("")).toBeNull();
  });

  // Three of the six watched assets are unpriceable and the product has to say
  // so rather than guess — named explicitly, per the brief.
  it.each(["DINERO", "UP", "MOFT"])("%s has no feed and must return null, never a guess", (ticker) => {
    expect(feedForTicker(ticker)).toBeNull();
  });
});

describe("FEED_STALE_AFTER_S", () => {
  it("is 600 seconds (ten minutes)", () => {
    expect(FEED_STALE_AFTER_S).toBe(600);
  });
});

describe("readExposure — batching", () => {
  it("carries every totalSupply/decimals read and the DISTINCT feeds through ONE aggregate3Batch invocation", async () => {
    let outerCalls = 0;
    const subCalls: { to: string; data: string }[] = [];
    const book: Record<string, TokenAnswer> = {
      [FLR_ADDR.toLowerCase()]: { supply: 1n, decimals: 18 },
      [WFLR_ADDR.toLowerCase()]: { supply: 2n, decimals: 18 },
      [XRP_ADDR.toLowerCase()]: { supply: 3n, decimals: 6 },
    };
    const feeds = [
      { name: "FLR/USD", value: 100n, decimals: 2 },
      { name: "XRP/USD", value: 200n, decimals: 2 },
    ];
    const wrapped = multicallHandler((to, data) => {
      subCalls.push({ to, data });
      return combine(tokenHandler(book), feedsHandler(feeds, 0n))(to, data);
    });
    const call = async (to: string, data: string) => {
      outerCalls++;
      return wrapped(to as Address, data);
    };

    await readExposure(
      [
        { address: FLR_ADDR, ticker: "FLR" },
        { address: WFLR_ADDR, ticker: "WFLR" }, // shares FLR/USD with FLR_ADDR
        { address: XRP_ADDR, ticker: "FXRP" },
      ],
      { call },
    );

    expect(outerCalls).toBe(1); // one round trip through the injected `call`
    // 3 assets * (totalSupply + decimals) + 1 getFeedsById = 7, NOT 8: FLR/USD
    // must be read once even though two assets price off it.
    expect(subCalls).toHaveLength(7);

    const feedsCall = subCalls.find((c) => c.to.toLowerCase() === FTSOV2_ADDRESS.toLowerCase());
    expect(feedsCall).toBeDefined();
    const { args } = decodeFunctionData({ abi: FTSOV2_ABI, data: feedsCall!.data as `0x${string}` });
    expect(args![0]).toEqual([feedId("01", "FLR/USD"), feedId("01", "XRP/USD")]);
  });

  it("does not call getFeedsById at all when no asset in the batch has a feed", async () => {
    const book: Record<string, TokenAnswer> = { [DINERO_ADDR.toLowerCase()]: { supply: 1n, decimals: 9 } };
    const log: { to: string; data: string }[] = [];
    const call = fakeCall(tokenHandler(book), log);

    await readExposure([{ address: DINERO_ADDR, ticker: "DINERO" }], { call });

    expect(log.some((c) => c.to.toLowerCase() === FTSOV2_ADDRESS.toLowerCase())).toBe(false);
  });

  it("returns exactly one Exposure per input asset, in input order", async () => {
    const book: Record<string, TokenAnswer> = {
      [FLR_ADDR.toLowerCase()]: { supply: 1n, decimals: 18 },
      [XRP_ADDR.toLowerCase()]: { supply: 2n, decimals: 6 },
      [DINERO_ADDR.toLowerCase()]: { supply: 3n, decimals: 9 },
      [WFLR_ADDR.toLowerCase()]: { supply: 4n, decimals: 18 },
    };
    const feeds = [
      { name: "FLR/USD", value: 100n, decimals: 2 },
      { name: "XRP/USD", value: 200n, decimals: 2 },
    ];
    const call = fakeCall(combine(tokenHandler(book), feedsHandler(feeds, 0n)));

    const inputs = [
      { address: FLR_ADDR, ticker: "FLR" },
      { address: XRP_ADDR, ticker: "FXRP" },
      { address: DINERO_ADDR, ticker: "DINERO" },
      { address: WFLR_ADDR, ticker: "WFLR" },
    ];
    const out = await readExposure(inputs, { call });

    expect(out).toHaveLength(4);
    expect(out.map((e) => e.address)).toEqual(inputs.map((i) => i.address));
  });
});

describe("readExposure — supply/decimals failure isolation", () => {
  it("a reverted totalSupply nulls only that asset's supply/valueUsd; the other row is unaffected", async () => {
    const book: Record<string, TokenAnswer> = {
      [FLR_ADDR.toLowerCase()]: { supply: "revert", decimals: 18 },
      [XRP_ADDR.toLowerCase()]: { supply: 500n, decimals: 6 },
    };
    const call = fakeCall(tokenHandler(book));

    const out = await readExposure(
      [
        { address: FLR_ADDR, ticker: "FLR" },
        { address: XRP_ADDR, ticker: "FXRP" },
      ],
      { call },
    );

    expect(out[0].supply).toBeNull();
    expect(out[0].valueUsd).toBeNull();
    expect(out[0].decimals).toBe(18); // decimals read independently of supply
    expect(out[1].supply).toBe(500n);
  });

  it("keeps a successfully-read supply even when decimals() reverts, but nulls valueUsd — an unknown scale cannot be guessed at 18", async () => {
    const book: Record<string, TokenAnswer> = {
      [FLR_ADDR.toLowerCase()]: { supply: 12345n, decimals: "revert" },
    };
    const call = fakeCall(tokenHandler(book));

    const [a] = await readExposure([{ address: FLR_ADDR, ticker: "FLR" }], { call });

    expect(a.supply).toBe(12345n);
    expect(a.decimals).toBeNull();
    expect(a.valueUsd).toBeNull();
  });

  it("uses the ACTUAL on-chain decimals, never hardcodes 18", async () => {
    const book: Record<string, TokenAnswer> = { [XRP_ADDR.toLowerCase()]: { supply: 1_000_000n, decimals: 6 } };
    const feeds = [{ name: "XRP/USD", value: 1_044_395n, decimals: 6 }]; // 1.044395
    const call = fakeCall(combine(tokenHandler(book), feedsHandler(feeds, 1000n)));

    const [a] = await readExposure([{ address: XRP_ADDR, ticker: "FXRP" }], { call, now: () => 1_000_000 });

    expect(a.decimals).toBe(6);
    // 1,000,000 raw / 10^6 = 1 token; 1 * 1.044395 = 1.044395.
    // A hardcoded 18 would divide by 10^18 instead and read as ~0.
    expect(a.valueUsd).toBeCloseTo(1.044395, 6);
  });

  it("propagates a transport failure rather than returning nulls, matching aggregate3Batch's documented contract", async () => {
    const call = async (): Promise<string> => {
      throw new Error("429 Too Many Requests");
    };
    await expect(readExposure([{ address: FLR_ADDR, ticker: "FLR" }], { call })).rejects.toThrow("429");
  });
});

describe("readExposure — malformed on-chain payloads (junk bytes, not empty/revert)", () => {
  it("a getFeedsById row answering FEWER feeds than requested is refused, not partially indexed", async () => {
    const book: Record<string, TokenAnswer> = {
      [FLR_ADDR.toLowerCase()]: { supply: 1n, decimals: 18 },
      [XRP_ADDR.toLowerCase()]: { supply: 1n, decimals: 6 },
    };
    // Two feeds requested (FLR/USD, XRP/USD); the fake node answers only ONE —
    // the shape a truncating/misbehaving node can actually produce, and
    // exactly the class multicall.ts's own row-count check refuses.
    const shortFeeds: Handler = (to, data) => {
      if (to.toLowerCase() !== FTSOV2_ADDRESS.toLowerCase()) return "0x";
      if (data.slice(0, 10) !== GET_FEEDS_SEL) return "0x";
      return encodeFunctionResult({
        abi: FTSOV2_ABI,
        functionName: "getFeedsById",
        result: [[100n], [2], 0n], // length 1, not 2 — a real, decodable, WRONG-shaped answer
      });
    };
    const call = fakeCall(combine(tokenHandler(book), shortFeeds));

    const out = await readExposure(
      [
        { address: FLR_ADDR, ticker: "FLR" },
        { address: XRP_ADDR, ticker: "FXRP" },
      ],
      { call, now: () => 1000 },
    );

    // Refused, not misattributed: neither asset's price is built off a
    // shifted index, and — the bug this guards against — neither is NaN.
    expect(out[0].priceUsd).toBeNull();
    expect(out[1].priceUsd).toBeNull();
    expect(out[0].valueUsd).toBeNull();
    expect(out[1].valueUsd).toBeNull();
    expect(Number.isNaN(out[0].valueUsd as unknown as number)).toBe(false);
    expect(Number.isNaN(out[1].valueUsd as unknown as number)).toBe(false);
    // Pricing failed; the independent token reads did not.
    expect(out[0].supply).toBe(1n);
    expect(out[1].supply).toBe(1n);
  });

  it("an undecodable getFeedsById payload does not throw readExposure or poison priceUsd with NaN", async () => {
    const book: Record<string, TokenAnswer> = { [FLR_ADDR.toLowerCase()]: { supply: 1n, decimals: 18 } };
    const garbageFeeds: Handler = (to, data) => {
      if (to.toLowerCase() !== FTSOV2_ADDRESS.toLowerCase()) return "0x";
      if (data.slice(0, 10) !== GET_FEEDS_SEL) return "0x";
      // Non-empty — a real answer, per aggregate3Batch's success flag — but not
      // valid ABI-encoded getFeedsById output. A misbehaving public RPC can
      // return exactly this (fake-rpc.ts documents the same hazard for peers()).
      return "0xdeadbeef";
    };
    const call = fakeCall(combine(tokenHandler(book), garbageFeeds));

    const out = await readExposure([{ address: FLR_ADDR, ticker: "FLR" }], { call, now: () => 1000 });

    expect(out[0].priceUsd).toBeNull();
    expect(out[0].valueUsd).toBeNull();
    expect(out[0].supply).toBe(1n); // the token-read batch row is unaffected
  });

  it("one token's undecodable decimals() nulls only that field for that asset — the batch does not throw and no other row is touched", async () => {
    const junky = FLR_ADDR;
    const healthy = XRP_ADDR;
    const book: Record<string, TokenAnswer> = {
      [junky.toLowerCase()]: { supply: 777n }, // decimals deliberately left unanswered here
      [healthy.toLowerCase()]: { supply: 500n, decimals: 6 },
    };
    const junkDecimals: Handler = (to, data) => {
      if (to.toLowerCase() !== junky.toLowerCase()) return "0x";
      if (data.slice(0, 10) !== DECIMALS_SEL) return "0x";
      return "0x1234"; // non-empty real answer, too short to decode as uint8
    };
    const call = fakeCall(combine(tokenHandler(book), junkDecimals));

    const out = await readExposure(
      [
        { address: junky, ticker: "FLR" },
        { address: healthy, ticker: "FXRP" },
      ],
      { call },
    );

    expect(out[0].decimals).toBeNull(); // undecodable -> null, not a thrown exception
    expect(out[0].supply).toBe(777n); // the OTHER sub-call for the SAME asset is unaffected
    expect(out[1].supply).toBe(500n); // and the OTHER asset entirely is unaffected
    expect(out[1].decimals).toBe(6);
  });
});

describe("readExposure — unpriceable assets", () => {
  it.each(["DINERO", "UP", "MOFT"])(
    "%s: supply/decimals still read normally, but feed/priceUsd/valueUsd stay null",
    async (ticker) => {
      const book: Record<string, TokenAnswer> = { [DINERO_ADDR.toLowerCase()]: { supply: 999n, decimals: 9 } };
      const call = fakeCall(tokenHandler(book));

      const [a] = await readExposure([{ address: DINERO_ADDR, ticker }], { call });

      expect(a.feed).toBeNull();
      expect(a.supply).toBe(999n);
      expect(a.decimals).toBe(9);
      expect(a.priceUsd).toBeNull();
      expect(a.valueUsd).toBeNull();
      expect(a.stale).toBe(false); // never priced, not "priced and found stale"
    },
  );
});

describe("readExposure — feed staleness", () => {
  const book: Record<string, TokenAnswer> = { [XRP_ADDR.toLowerCase()]: { supply: 1_000_000n, decimals: 6 } };
  const feeds = [{ name: "XRP/USD", value: 1_044_395n, decimals: 6 }];

  it("a feed exactly FEED_STALE_AFTER_S old is still usable — the boundary is exclusive", async () => {
    const call = fakeCall(combine(tokenHandler(book), feedsHandler(feeds, 0n)));

    const [a] = await readExposure([{ address: XRP_ADDR, ticker: "FXRP" }], {
      call,
      now: () => FEED_STALE_AFTER_S * 1000,
    });

    expect(a.stale).toBe(false);
    expect(a.priceUsd).not.toBeNull();
  });

  it("a feed one second past FEED_STALE_AFTER_S is stale: priceUsd AND valueUsd both null, but feedTimestamp still surfaces the age", async () => {
    const call = fakeCall(combine(tokenHandler(book), feedsHandler(feeds, 0n)));

    const [a] = await readExposure([{ address: XRP_ADDR, ticker: "FXRP" }], {
      call,
      now: () => (FEED_STALE_AFTER_S + 1) * 1000,
    });

    expect(a.stale).toBe(true);
    expect(a.priceUsd).toBeNull();
    expect(a.valueUsd).toBeNull();
    expect(a.feedTimestamp).toBe(0);
  });
});

describe("readExposure — worked example (live-verified Flare Mainnet values, 2026-08-07, chainId 14 block 66940893)", () => {
  it("prices feeds with DIFFERENT decimals correctly — decimals are read per feed, never assumed uniform", async () => {
    const addrs = {
      flr: ("0x" + "a1".repeat(20)) as Address,
      xrp: ("0x" + "a2".repeat(20)) as Address,
      usdt: ("0x" + "a3".repeat(20)) as Address,
      eth: ("0x" + "a4".repeat(20)) as Address,
      usdc: ("0x" + "a5".repeat(20)) as Address,
    };
    const book: Record<string, TokenAnswer> = {
      [addrs.flr.toLowerCase()]: { supply: 1n, decimals: 18 },
      [addrs.xrp.toLowerCase()]: { supply: 1n, decimals: 6 },
      [addrs.usdt.toLowerCase()]: { supply: 1n, decimals: 6 },
      [addrs.eth.toLowerCase()]: { supply: 1n, decimals: 18 },
      [addrs.usdc.toLowerCase()]: { supply: 1n, decimals: 6 },
    };
    // Raw values as FtsoV2.getFeedsById returned them live.
    const feeds = [
      { name: "FLR/USD", value: 605322n, decimals: 8 }, // 0.00605322
      { name: "XRP/USD", value: 1044395n, decimals: 6 }, // 1.044395
      { name: "USDT/USD", value: 99948n, decimals: 5 }, // 0.99948
      { name: "ETH/USD", value: 1923400n, decimals: 3 }, // 1923.4
      { name: "USDC/USD", value: 100006n, decimals: 5 }, // 1.00006
    ];
    const call = fakeCall(combine(tokenHandler(book), feedsHandler(feeds, 0n)));

    const out = await readExposure(
      [
        { address: addrs.flr, ticker: "FLR" },
        { address: addrs.xrp, ticker: "FXRP" },
        { address: addrs.usdt, ticker: "USDT" },
        { address: addrs.eth, ticker: "WETH" },
        { address: addrs.usdc, ticker: "USDC" },
      ],
      { call, now: () => 1000 }, // feedsHandler's timestamp is 0n; keep the read fresh
    );

    expect(out[0].priceUsd).toBeCloseTo(0.00605322, 8);
    expect(out[1].priceUsd).toBeCloseTo(1.044395, 6);
    expect(out[2].priceUsd).toBeCloseTo(0.99948, 5);
    expect(out[3].priceUsd).toBeCloseTo(1923.4, 3);
    expect(out[4].priceUsd).toBeCloseTo(1.00006, 5);
  });
});

// ── The determinism guard, and it is the reason this task exists ───────────
describe("engine isolation", () => {
  it("ftso.ts never names score.ts or drift.ts as a module specifier", () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "services", "ftso.ts");
    const src = readFileSync(path, "utf8");

    // Match the SPECIFIER, not the first line of the statement. A multi-line
    // `import {\n  ...\n} from "./x.js"` — this codebase's own house style,
    // including this file's own imports — puts the module path on the LAST
    // line, so a line-based `/^\s*import\b/` filter (the previous version of
    // this test) never sees it and passes even with a live engine import
    // planted in the file. This also catches `export { ... } from "./x.js"`
    // and `await import("./x.js")`, neither of which starts with `import`.
    const specifiers = [...src.matchAll(/from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g)].map(
      (m) => m[1] ?? m[2],
    );

    // Sanity: prove the file really has specifiers, so this can't pass
    // vacuously on a parsing mistake that matched nothing at all.
    expect(specifiers.length).toBeGreaterThan(0);

    for (const s of specifiers) {
      expect(s).not.toMatch(/\/(score|drift)\.(js|ts)$/);
    }
  });
});

// score.test.ts's own fixtures are bare Finding[] literals for computeScore(),
// which never returns riskLevel — so they cannot pin "score, riskLevel and
// findings byte-identical" on their own. assessSnapshot() (drift.ts) is the
// only exported function that returns all three together, so THAT is "the
// existing scoring path" this guard runs against. The OftSnapshot fixture
// reuses the established snap()/route()/uln() idiom already standing in
// dead-dvn.test.ts (every scoring-path test file in this suite rolls its own;
// there is no single shared OftSnapshot fixture module to import instead).
const REAL_DVN = "0x589dEDbD617e0CBcB916A9223F4d1300c294236b";

function uln(over: Partial<UlnSnapshot> = {}): UlnSnapshot {
  return {
    confirmations: 15,
    requiredDVNCount: 1,
    requiredDVNs: [REAL_DVN],
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    optionalDVNs: [],
    ...over,
  };
}

function route(over: Partial<RouteSnapshot> = {}): RouteSnapshot {
  return {
    eid: 30101,
    chainName: "ethereum",
    chainKey: "ethereum",
    sendLibrary: "0x" + "5e".repeat(20),
    sendLibIsDefault: false,
    receiveLibrary: "0x" + "5c".repeat(20),
    receiveLibIsDefault: false,
    uln: uln(),
    receiveUln: null,
    peer: "0x" + "ab".repeat(20),
    peerAddress: "0x" + "ab".repeat(20),
    hasEnforcedOptions: true,
    isActive: true,
    sendability: "SENDABLE",
    ...over,
  };
}

function snap(routes: RouteSnapshot[]): OftSnapshot {
  return {
    oft: "0x" + "12".repeat(20),
    chainId: 14, // Flare Mainnet
    capturedAt: 0,
    owner: "0x" + "a1".repeat(20),
    ownerIsContract: true,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes,
  };
}

describe("the score must not move when the price moves", () => {
  // Ticker "TKN" throughout, never a real third-party ticker like "FXRP": the
  // commit immediately before this task's own (f15dd82) removed exactly that
  // shape — a real third-party ticker attached to a CRITICAL-riskLevel
  // assertion — from three other files. This snapshot's `oft` address is a
  // synthetic fixture regardless; the ticker passed to assessSnapshot must
  // match that, not the ticker used to look up a real price feed below.
  const TICKER = "TKN";

  /** Build a real Exposure (via THIS task's readExposure, fake call) priced at
   *  a given raw XRP/USD feed value, so two calls can represent the price at
   *  two different moments. */
  async function exposureAt(oft: string, rawValue: bigint): Promise<Exposure[]> {
    const book: Record<string, TokenAnswer> = { [oft.toLowerCase()]: { supply: 10_000_000n, decimals: 6 } };
    const feeds = [{ name: "XRP/USD", value: rawValue, decimals: 6 }];
    const priceCall = fakeCall(combine(tokenHandler(book), feedsHandler(feeds, 0n)));
    return readExposure([{ address: oft, ticker: "FXRP" }], {
      call: priceCall,
      now: () => 1000, // feedsHandler's timestamp is 0n; keep the read fresh
    });
  }

  it("assessSnapshot returns byte-identical score, riskLevel and findings across no Exposure and two DIFFERENTLY-priced Exposures", async () => {
    const base = snap([route()]); // a real 1-of-1 required DVN -> CRITICAL, non-trivial score

    const absent = await assessSnapshot(base, TICKER, null);
    expect(absent.riskLevel).toBe("CRITICAL"); // sanity: this is a substantive, non-vacuous case

    const exposureLow = await exposureAt(base.oft, 1_044_395n); // XRP/USD = 1.044395
    const exposureHigh = await exposureAt(base.oft, 2_088_790n); // XRP/USD = 2.088790 — the price moved
    expect(exposureLow[0].valueUsd).not.toBeNull(); // sanity: pricing actually resolved
    expect(exposureHigh[0].valueUsd).not.toBeNull();
    // Sanity the price truly did move between the two Exposures, or this test
    // would just be restating "same input twice gives the same output".
    expect(exposureHigh[0].priceUsd).not.toBe(exposureLow[0].priceUsd);
    expect(exposureHigh[0].valueUsd).not.toBe(exposureLow[0].valueUsd);

    // ftso.ts's Exposure type is not part of OftSnapshot — attach it the way a
    // future caller (route.ts, Task 25) would, alongside the same snapshot.
    const withLow: OftSnapshot & { exposure: Exposure[] } = { ...base, exposure: exposureLow };
    const withHigh: OftSnapshot & { exposure: Exposure[] } = { ...base, exposure: exposureHigh };
    const priceLow = await assessSnapshot(withLow, TICKER, null);
    const priceHigh = await assessSnapshot(withHigh, TICKER, null);

    for (const result of [priceLow, priceHigh]) {
      expect(result.score).toBe(absent.score);
      expect(result.riskLevel).toBe(absent.riskLevel);
      expect(result.findings).toEqual(absent.findings);
    }
  });
});
