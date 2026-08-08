import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, type Address } from "viem";

import {
  EXPOSURE_TTL_MS,
  exposureKey,
  readFleetExposure,
  resetExposureCache,
} from "../services/exposure.js";
import { FTSOV2_ADDRESS } from "../services/ftso.js";
import { MULTICALL3_ADDRESS } from "../services/multicall.js";
import { multicallHandler, type Handler } from "./helpers/fake-rpc.js";

// The wrapper that stands between ftso.ts and the status route, and the reason
// it exists: readExposure THROWS on transport failure, deliberately, so "the
// chain said no" stays distinguishable from "we failed to ask". The verdict is
// the product and a price is not, so that throw must never reach the response.
//
// Every case here is about the boundary, not about pricing — ftso.test.ts owns
// the arithmetic. What is pinned here is: it never rejects, it never invents a
// row, it never reads an asset against a node that speaks a different chain,
// and it does not keep serving a failure after the RPC recovers.

const CHAIN_ID = 14;
const OTHER_CHAIN_ID = 5000;

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

const OFT_TOKEN_ABI = [
  { name: "token", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const TOKEN_SEL = encodeFunctionData({ abi: OFT_TOKEN_ABI, functionName: "token" }).slice(0, 10);

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
const MULTICALL3_BALANCE_ABI = [
  {
    name: "getEthBalance",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
const BALANCE_OF_SEL = encodeFunctionData({
  abi: ERC20_BALANCE_ABI,
  functionName: "balanceOf",
  args: ["0x0000000000000000000000000000000000000000"],
}).slice(0, 10);
const ETH_BALANCE_SEL = encodeFunctionData({
  abi: MULTICALL3_BALANCE_ABI,
  functionName: "getEthBalance",
  args: ["0x0000000000000000000000000000000000000000"],
}).slice(0, 10);
const uint256 = (v: bigint) =>
  encodeFunctionResult({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", result: v });

const PRICED = ("0x" + "b1".repeat(20)) as Address;
const UNPRICEABLE = ("0x" + "b2".repeat(20)) as Address;
const UNDERLYING = ("0x" + "b3".repeat(20)) as Address;

/** A PLAIN OFT node: a 6-decimal token that answers `totalSupply()` on itself
 *  and never answers `token()`, plus one feed answering the value this repo
 *  measured live (XRP/USD 1.044395). */
const healthy: Handler = (to, data) => {
  const sel = data.slice(0, 10);
  if (to.toLowerCase() === FTSOV2_ADDRESS.toLowerCase() && sel === GET_FEEDS_SEL) {
    return encodeFunctionResult({
      abi: FTSOV2_ABI,
      functionName: "getFeedsById",
      result: [[1_044_395n], [6], 1_000n],
    });
  }
  if (sel === TOTAL_SUPPLY_SEL) {
    return encodeFunctionResult({ abi: ERC20_ABI, functionName: "totalSupply", result: 1_000_000_000_000n });
  }
  if (sel === DECIMALS_SEL) {
    return encodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", result: 6 });
  }
  return "0x";
};

function fakeCall(inner: Handler, count?: { n: number }): (to: string, data: string) => Promise<string> {
  const wrapped = multicallHandler(inner);
  return async (to, data) => {
    if (count) count.n++;
    return wrapped(to as Address, data);
  };
}

// The fake feed reports timestamp 1000s; this clock reads 1500s, so the price is
// 500s old and inside FEED_STALE_AFTER_S. A clock further ahead would make every
// case below a staleness case by accident.
const FRESH = { now: () => 1_500_000 };

beforeEach(() => {
  resetExposureCache();
  vi.stubEnv("SENTINEL_CHAIN_ID", String(CHAIN_ID));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readFleetExposure — the happy path", () => {
  it("keys every asset by chain and address, and serves the supply as a string", async () => {
    const out = await readFleetExposure(
      [
        { address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" },
        { address: UNPRICEABLE, chainId: CHAIN_ID, ticker: "MOFT" },
      ],
      { call: fakeCall(healthy), ...FRESH },
    );

    const priced = out.get(exposureKey(CHAIN_ID, PRICED));
    expect(priced?.feed).toBe("XRP/USD");
    expect(priced?.valueUsd).toBeCloseTo(1_044_395, 3);
    // A bigint would make `res.json()` throw outright, taking the whole status
    // response with it. It travels as a decimal string, raw and unscaled.
    expect(priced?.amount).toBe("1000000000000");
    expect(typeof priced?.amount).toBe("string");
    expect(priced?.decimals).toBe(6);

    // The unpriceable asset is PRESENT with a null feed, not missing. Missing
    // and unpriceable are different states and the page says different things
    // about them.
    const none = out.get(exposureKey(CHAIN_ID, UNPRICEABLE));
    expect(none).toBeDefined();
    expect(none?.feed).toBeNull();
    expect(none?.priceUsd).toBeNull();
    expect(none?.valueUsd).toBeNull();
    expect(none?.amount).toBe("1000000000000"); // the circulating amount still reads fine
  });

  it("stamps when THIS instance read it, alongside the feed's own timestamp", async () => {
    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call: fakeCall(healthy),
      ...FRESH,
    });
    const e = out.get(exposureKey(CHAIN_ID, PRICED));
    expect(e?.readAt).toBe(1_500_000); // ours, in ms
    expect(e?.feedTimestamp).toBe(1_000); // the feed's own, in seconds
  });

  it("prices an asset whose watchlist entry is not lowercase, and keys it lowercased", async () => {
    // viem rejects a mixed-case address whose checksum does not verify, and it
    // does so while ENCODING the batch — so one badly-cased watchlist entry
    // would take the price read for the whole fleet down with it, not just its
    // own row. The wrapper lowercases on the way in.
    const shouty = PRICED.toUpperCase().replace("0X", "0x");
    const out = await readFleetExposure([{ address: shouty, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call: fakeCall(healthy),
      ...FRESH,
    });
    expect(out.get(exposureKey(CHAIN_ID, PRICED))).toBeDefined();
    expect(out.get(exposureKey(CHAIN_ID, shouty))).toBeDefined(); // same key either way
  });
});

// ── The requirement this module exists for ───────────────────────────────────

describe("readFleetExposure never fails a cycle", () => {
  it("degrades a transport failure to an empty map instead of rejecting", async () => {
    const call = async (): Promise<string> => {
      throw new Error("429 Too Many Requests");
    };
    // Sanity: readExposure itself DOES throw on this input (ftso.test.ts pins
    // that contract). If it ever stopped, this test would pass vacuously.
    const { readExposure } = await import("../services/ftso.js");
    await expect(readExposure([{ address: PRICED, ticker: "FXRP" }], { call })).rejects.toThrow("429");

    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], { call });
    expect(out.size).toBe(0);
    expect(out.get(exposureKey(CHAIN_ID, PRICED))).toBeUndefined();
  });

  it("degrades a call that never settles, rather than hanging the cycle", async () => {
    // A transport that hangs is worse than one that throws: nothing downstream
    // can even observe it, and the status response would wait forever.
    const call = () => new Promise<string>(() => {});
    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call,
      timeoutMs: 50,
    });
    expect(out.size).toBe(0);
  });

  it("degrades the WHOLE read when the token() probe fails on transport", async () => {
    // A deliberate behaviour change in fix round 1: resolveTokens used to catch
    // its own transport failure and answer "no token" for every asset, which
    // silently reclassified every lockbox as a plain OFT. That is the one
    // misclassification that can produce a number rather than a null, so the
    // failure now propagates and the whole read degrades instead.
    let seen = 0;
    const call = async (to: string, data: string): Promise<string> => {
      seen++;
      if (seen === 1) throw new Error("probe: 503 Service Unavailable"); // the token() batch
      return fakeCall(lockbox(FXRP_BALANCE, FXRP_SUPPLY))(to, data);
    };

    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call,
      ...FRESH,
    });

    // Empty, not "one row silently relabelled circulating".
    expect(out.size).toBe(0);
    // And nothing downstream was attempted on a guessed shape.
    expect(seen).toBe(1);
  });

  it("does not cache a failure — the next read after a recovery is served", async () => {
    const failing = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call: async () => {
        throw new Error("down");
      },
      ...FRESH,
    });
    expect(failing.size).toBe(0);

    const recovered = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call: fakeCall(healthy),
      ...FRESH,
    });
    expect(recovered.get(exposureKey(CHAIN_ID, PRICED))?.valueUsd).toBeCloseTo(1_044_395, 3);
  });
});

// ── Three shapes, three reads, three labels ──────────────────────────────────
//
// The regression this section exists to prevent nearly shipped: pricing a
// lockbox off the UNDERLYING'S TOTAL SUPPLY instead of off the balance the
// lockbox actually holds. Measured on Flare Mainnet 2026-08-08, the gap was
//
//   FXRP   underlying.totalSupply        148,811,449.705  ->  $155,417,934
//          underlying.balanceOf(adapter)  12,929,748.171  ->   $13,503,764
//   USDT0  underlying.totalSupply         26,421,206.049  ->   $26,407,467
//          underlying.balanceOf(adapter)               0  ->           $0
//
// i.e. an 11.5x overstatement on one asset and an entirely fabricated $26.4M on
// another, both of them confident and precise, on a page handed to judges. The
// fixtures below use those exact measured amounts so a regression reads as the
// real number it would have printed.

/** FXRP's measured shape, at 6 decimals: a lockbox holding 12,929,748.171 of an
 *  underlying whose total supply is 148,811,449.705 — 8.69% of it. */
const FXRP_BALANCE = 12_929_748_171_000n;
const FXRP_SUPPLY = 148_811_449_705_000n;
const XRP_PRICE = 1.044395;

/** WHOSE balance was asked for. A balance read is a question about an ADDRESS,
 *  and a fixture that dispatches on the 4-byte selector alone answers that
 *  question for anybody — so every mutation of the argument survives it.
 *
 *  This is the strictness fake-rpc.ts's own `fullHandler` documents at length
 *  (see its ⚠️ note: "every modelled selector returns `0x` unless the TARGET,
 *  the eid argument, the config type, the msgType and the library argument are
 *  all exactly what the production read path should be sending"). The same class
 *  bites harder here, because the wrong answer is not a null: asking
 *  `underlying.balanceOf(underlying)` returns roughly zero, a zero balance
 *  against a non-zero supply is exactly the `mintsOnArrival` branch, and the row
 *  this fix round exists to get right would print a FABRICATED MECHANISM CLAIM
 *  with every test still green. */
const BALANCE_QUESTION_ABI = [...ERC20_BALANCE_ABI, ...MULTICALL3_BALANCE_ABI] as const;

function subjectOf(data: string): string | null {
  try {
    // Decoded against BOTH balance functions, so it resolves whichever one the
    // calldata actually carries rather than silently answering null for the
    // other — a decoder that never decodes would make asksAbout() reject
    // everything, which is a different way to be useless.
    const { args } = decodeFunctionData({ abi: BALANCE_QUESTION_ABI, data: data as `0x${string}` });
    return ((args as readonly string[])[0] ?? "").toLowerCase();
  } catch {
    return null;
  }
}

/** True only when the calldata asks about `who`. `getEthBalance(address)` and
 *  `balanceOf(address)` take the identical argument list, and the selector is
 *  checked separately by the caller. */
function asksAbout(data: string, who: string): boolean {
  return subjectOf(data) === who.toLowerCase();
}

/** A LOCKBOX: answers `token()`, refuses everything else, and the ERC20 it names
 *  answers its own (much larger) total supply plus the balance held BY THE
 *  ADAPTER — and only by the adapter. */
function lockbox(balance: bigint, supply: bigint): Handler {
  return (to, data) => {
    const sel = data.slice(0, 10);
    if (to.toLowerCase() === FTSOV2_ADDRESS.toLowerCase() && sel === GET_FEEDS_SEL) {
      return encodeFunctionResult({
        abi: FTSOV2_ABI,
        functionName: "getFeedsById",
        result: [[1_044_395n], [6], 1_000n],
      });
    }
    if (to.toLowerCase() === PRICED.toLowerCase()) {
      if (sel === TOKEN_SEL) {
        return encodeFunctionResult({ abi: OFT_TOKEN_ABI, functionName: "token", result: UNDERLYING });
      }
      return "0x"; // the adapter itself reports no supply and no decimals
    }
    if (to.toLowerCase() === UNDERLYING.toLowerCase()) {
      // STRICT: the balance is the ADAPTER's. Asked about anyone else — the
      // underlying itself, the zero address, a shifted argument — this node
      // answers nothing, which surfaces as "amount not reported" rather than as
      // a plausible number.
      if (sel === BALANCE_OF_SEL) return asksAbout(data, PRICED) ? uint256(balance) : "0x";
      if (sel === TOTAL_SUPPLY_SEL) return uint256(supply);
      if (sel === DECIMALS_SEL) {
        return encodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", result: 6 });
      }
    }
    return "0x";
  };
}

/** A NATIVE-COIN OFT: `token()` answers the zero address and the coin balance
 *  comes from Multicall3's own helper — for the OFT, and for nobody else. */
function nativeOft(balance: bigint): Handler {
  return (to, data) => {
    const sel = data.slice(0, 10);
    if (to.toLowerCase() === PRICED.toLowerCase() && sel === TOKEN_SEL) {
      return encodeFunctionResult({
        abi: OFT_TOKEN_ABI,
        functionName: "token",
        result: "0x0000000000000000000000000000000000000000",
      });
    }
    if (to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase() && sel === ETH_BALANCE_SEL) {
      // STRICT, same reason: Multicall3's own balance, or the zero address's,
      // are both answers to a question this read must never be asking.
      return asksAbout(data, PRICED) ? uint256(balance) : "0x";
    }
    if (to.toLowerCase() === FTSOV2_ADDRESS.toLowerCase() && sel === GET_FEEDS_SEL) {
      return encodeFunctionResult({
        abi: FTSOV2_ABI,
        functionName: "getFeedsById",
        result: [[1_044_395n], [6], 1_000n],
      });
    }
    return "0x"; // the OFT reports no ERC20 supply and no decimals
  };
}

describe("readFleetExposure — shape 1: a lockbox is worth what it HOLDS", () => {
  it("reads the balance the contract custodies, labels it custodied, and names the contract", async () => {
    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call: fakeCall(lockbox(FXRP_BALANCE, FXRP_SUPPLY)),
      ...FRESH,
    });

    // Keyed by the WATCHED address — the row's identity does not move.
    const e = out.get(exposureKey(CHAIN_ID, PRICED));
    expect(e?.amount).toBe(FXRP_BALANCE.toString());
    expect(e?.decimals).toBe(6); // the UNDERLYING's decimals, which the adapter cannot answer
    expect(e?.basis).toBe("custodied");
    expect(e?.valueUsd).toBeCloseTo(12_929_748.171 * XRP_PRICE, 2);
    expect(e?.pricedToken).toBe(UNDERLYING.toLowerCase());
    expect(e?.mintsOnArrival).toBe(false);
  });

  it("asks for the OFT's OWN balance, and gets nothing when it asks about anyone else", async () => {
    // The in-suite half of the strictness the fixtures enforce. This node
    // answers balanceOf ONLY when the subject is the UNDERLYING — i.e. it models
    // a world where the read is aimed at the wrong address — and the row must
    // then report no amount rather than the plausible number it would get back.
    const wrongSubject: Handler = (to, data) => {
      if (to.toLowerCase() === UNDERLYING.toLowerCase() && data.slice(0, 10) === BALANCE_OF_SEL) {
        return asksAbout(data, UNDERLYING) ? uint256(999_999_000_000n) : "0x";
      }
      return lockbox(FXRP_BALANCE, FXRP_SUPPLY)(to, data);
    };
    const e = (
      await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
        call: fakeCall(wrongSubject),
        ...FRESH,
      })
    ).get(exposureKey(CHAIN_ID, PRICED));

    expect(e?.amount).toBeNull();
    expect(e?.valueUsd).toBeNull();
    // …and it must not become a mechanism claim on the way out: a balance that
    // was never read is not a contract that holds nothing.
    expect(e?.mintsOnArrival).toBe(false);
  });

  // ── THE REGRESSION GUARD ───────────────────────────────────────────────────
  // Its only job is to fail if a lockbox is ever priced off the underlying's
  // total supply again. Both assertions are needed: the first pins the number
  // that is right, the second names the number that is wrong, so the failure
  // message says WHICH mistake was made rather than just "not close to".
  it("NEVER prices a lockbox off the underlying's total supply", async () => {
    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call: fakeCall(lockbox(FXRP_BALANCE, FXRP_SUPPLY)),
      ...FRESH,
    });
    const e = out.get(exposureKey(CHAIN_ID, PRICED));

    const heldValue = 12_929_748.171 * XRP_PRICE; // ~$13,503,764 — the truth
    const supplyValue = 148_811_449.705 * XRP_PRICE; // ~$155,417,934 — the near-miss

    expect(e?.valueUsd).toBeCloseTo(heldValue, 2);
    expect(
      e?.valueUsd,
      "a lockbox is being priced off the underlying's TOTAL SUPPLY again — " +
        "that is an 11.5x overstatement of what the contract actually holds",
    ).not.toBeCloseTo(supplyValue, -3);
    // and the raw amount is the balance, not the supply, at the source
    expect(e?.amount).not.toBe(FXRP_SUPPLY.toString());
  });

  it("a lockbox holding NOTHING reports zero and flags that it mints on arrival", async () => {
    // USDT0's measured shape. The zero is the real answer and stays the answer;
    // the flag is what lets the page explain it instead of looking broken.
    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "USDT0" }], {
      call: fakeCall(lockbox(0n, 26_421_206_049_000n)),
      ...FRESH,
    });
    const e = out.get(exposureKey(CHAIN_ID, PRICED));

    expect(e?.amount).toBe("0");
    expect(e?.valueUsd).toBe(0);
    expect(e?.mintsOnArrival).toBe(true);
    // The supply figure is NOT substituted for the zero anywhere in the payload.
    expect(e?.amount).not.toBe("26421206049000");
    expect(e?.valueUsd).not.toBeCloseTo(26_421_206.049 * XRP_PRICE, -3);
  });

  it("does not flag mint-on-arrival when the underlying itself has no supply", async () => {
    // Zero balance AND zero supply is a dead or brand-new token, not a
    // mint-and-burn design. Claiming a mechanism from a zero would be inventing
    // an explanation.
    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call: fakeCall(lockbox(0n, 0n)),
      ...FRESH,
    });
    expect(out.get(exposureKey(CHAIN_ID, PRICED))?.mintsOnArrival).toBe(false);
  });
});

describe("readFleetExposure — shape 2: a native-coin OFT is worth its COIN balance", () => {
  it("reads the coin balance through Multicall3 and scales it at the chain's own decimals", async () => {
    // FLR's measured shape: token() -> zero address, and a real native balance.
    const balance = 13_844_430_523_000_000_000_000_000n; // 13,844,430.523 coins at 18dp
    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FLR" }], {
      call: fakeCall(nativeOft(balance)),
      ...FRESH,
    });

    const e = out.get(exposureKey(CHAIN_ID, PRICED));
    expect(e?.amount).toBe(balance.toString());
    expect(e?.decimals).toBe(18); // from the chain registry, not from the OFT
    expect(e?.basis).toBe("custodied");
    expect(e?.valueUsd).toBeCloseTo(13_844_430.523 * XRP_PRICE, 2);
    expect(e?.pricedToken).toBe(PRICED.toLowerCase()); // the coin is the OFT's own
    expect(e?.mintsOnArrival).toBe(false);
  });
});

describe("readFleetExposure — shape 3: a plain OFT is worth what CIRCULATES", () => {
  it("reads its own totalSupply and labels it circulating", async () => {
    // `healthy` never answers token(), which is what a plain OFT does.
    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call: fakeCall(healthy),
      ...FRESH,
    });
    const e = out.get(exposureKey(CHAIN_ID, PRICED));
    expect(e?.amount).toBe("1000000000000");
    expect(e?.basis).toBe("circulating");
    expect(e?.pricedToken).toBe(PRICED.toLowerCase());
    expect(e?.valueUsd).toBeCloseTo(1_044_395, 3);
  });

  it("treats an OFT that names ITSELF as its token as plain, not as a lockbox", async () => {
    // Reading balanceOf(self) on a token that mints and burns would report the
    // rounding dust it happens to hold, not what circulates.
    const selfNaming: Handler = (to, data) => {
      if (to.toLowerCase() === PRICED.toLowerCase() && data.slice(0, 10) === TOKEN_SEL) {
        return encodeFunctionResult({ abi: OFT_TOKEN_ABI, functionName: "token", result: PRICED });
      }
      return healthy(to, data);
    };
    const e = (
      await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
        call: fakeCall(selfNaming),
        ...FRESH,
      })
    ).get(exposureKey(CHAIN_ID, PRICED));
    expect(e?.basis).toBe("circulating");
    expect(e?.amount).toBe("1000000000000");
  });

  it("cannot invent a value from a junk answer to the probe", async () => {
    // A selector collision could return a plausible address. It buys nothing:
    // the balance and decimals reads still have to succeed on THAT contract, and
    // when they do not the row reports no amount rather than a wrong number.
    const junkProbe: Handler = (to, data) => {
      if (to.toLowerCase() === PRICED.toLowerCase() && data.slice(0, 10) === TOKEN_SEL) {
        return encodeFunctionResult({ abi: OFT_TOKEN_ABI, functionName: "token", result: UNPRICEABLE });
      }
      if (to.toLowerCase() === UNPRICEABLE.toLowerCase()) return "0x"; // answers nothing
      return healthy(to, data);
    };
    const out = await readFleetExposure([{ address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" }], {
      call: fakeCall(junkProbe),
      ...FRESH,
    });
    const e = out.get(exposureKey(CHAIN_ID, PRICED));
    expect(e?.amount).toBeNull();
    expect(e?.valueUsd).toBeNull();
    expect(e?.priceUsd).toBeCloseTo(1.044395, 6); // the price still read fine
  });
});


describe("readFleetExposure — chain scope", () => {
  it("reads nothing at all when no watched asset lives on this instance's chain", async () => {
    const count = { n: 0 };
    const out = await readFleetExposure(
      [{ address: PRICED, chainId: OTHER_CHAIN_ID, ticker: "FXRP" }],
      { call: fakeCall(healthy, count), ...FRESH },
    );
    // One client speaks to one chain. A totalSupply() answered by a different
    // chain is not a smaller number, it is a wrong one — so the asset comes back
    // absent and no call is made.
    expect(out.size).toBe(0);
    expect(count.n).toBe(0);
  });

  it("prices the in-scope assets and leaves the others out", async () => {
    const out = await readFleetExposure(
      [
        { address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" },
        { address: UNPRICEABLE, chainId: OTHER_CHAIN_ID, ticker: "FXRP" },
      ],
      { call: fakeCall(healthy), ...FRESH },
    );
    expect(out.size).toBe(1);
    expect(out.get(exposureKey(CHAIN_ID, PRICED))).toBeDefined();
    expect(out.get(exposureKey(OTHER_CHAIN_ID, UNPRICEABLE))).toBeUndefined();
  });
});

describe("readFleetExposure — caching", () => {
  const asset = { address: PRICED, chainId: CHAIN_ID, ticker: "FXRP" };
  /** One fleet read of a PLAIN OFT is two round trips: the token() probe, then
   *  the priced batch. A custodied shape adds a third (the balance batch), which
   *  is why this fixture is the plain one. The tests below count round trips, so
   *  they multiply by this rather than pinning a number that would silently mean
   *  something else if the batches were ever merged. */
  const CALLS_PER_READ = 2;

  it("serves one read for the whole TTL", async () => {
    const count = { n: 0 };
    const call = fakeCall(healthy, count);
    await readFleetExposure([asset], { call, now: () => 1_000_000 });
    await readFleetExposure([asset], { call, now: () => 1_000_000 + EXPOSURE_TTL_MS - 1 });
    expect(count.n).toBe(CALLS_PER_READ);
  });

  it("re-reads once the TTL is up", async () => {
    const count = { n: 0 };
    const call = fakeCall(healthy, count);
    await readFleetExposure([asset], { call, now: () => 1_000_000 });
    await readFleetExposure([asset], { call, now: () => 1_000_000 + EXPOSURE_TTL_MS });
    expect(count.n).toBe(2 * CALLS_PER_READ);
  });

  it("never serves an asset from a read that did not cover it", async () => {
    // A watchlist that gained an asset must not answer for it out of a cache
    // built before it existed — that would be a row invented rather than read.
    const count = { n: 0 };
    const call = fakeCall(healthy, count);
    await readFleetExposure([asset], { call, now: () => 1_000_000 });
    const grown = await readFleetExposure(
      [asset, { address: UNPRICEABLE, chainId: CHAIN_ID, ticker: "MOFT" }],
      { call, now: () => 1_000_000 + 1 },
    );
    expect(count.n).toBe(2 * CALLS_PER_READ);
    expect(grown.size).toBe(2);
  });
});
