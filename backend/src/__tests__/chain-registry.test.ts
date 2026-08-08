import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { _probeMulticall3, _probeMulticall3Once } from "../scripts/build-chain-registry.js";
import {
  getChainRef,
  getChainRefByKey,
  listEligibleChains,
  meetsQuorum,
  distinctProviderCount,
  normalizeProvider,
  _resetChainRegistryCache,
  chainDisplayName,
} from "../services/chain-registry.js";

// Isolated registry fixtures via CHAIN_REGISTRY_PATH; cache reset between tests.
let dir: string;
const savedPath = process.env.CHAIN_REGISTRY_PATH;
const savedMantleRpc = process.env.MANTLE_RPC;
const savedAlchemyKey = process.env.ALCHEMY_API_KEY;
const savedDrpcKey = process.env.DRPC_API_KEY;

function writeRegistry(chains: Record<string, unknown>): string {
  const file = join(dir, "chain-registry.json");
  writeFileSync(file, JSON.stringify({ generatedAt: "x", source: "test", chains }));
  process.env.CHAIN_REGISTRY_PATH = file;
  _resetChainRegistryCache();
  return file;
}

const rpc = (url: string, provider: string) => ({ url, provider });

const twoProviderChain = {
  chainKey: "mantle",
  eid: 30181,
  chainId: 5000,
  eligible: true,
  etherscanFree: true,
  rpcs: [rpc("https://rpc.mantle.xyz", "official"), rpc("https://mantle.drpc.org", "drpc")],
  note: "",
};

const oneProviderChain = {
  chainKey: "solo",
  eid: 39999,
  chainId: 99999,
  eligible: true, // file lies — loader must still mark it ineligible
  etherscanFree: false,
  rpcs: [rpc("https://a.solo.xyz", "official"), rpc("https://b.solo.xyz", "official")],
  note: "single provider",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chainreg-"));
  delete process.env.MANTLE_RPC;
  delete process.env.ALCHEMY_API_KEY;
  delete process.env.DRPC_API_KEY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedPath === undefined) delete process.env.CHAIN_REGISTRY_PATH;
  else process.env.CHAIN_REGISTRY_PATH = savedPath;
  if (savedMantleRpc === undefined) delete process.env.MANTLE_RPC;
  else process.env.MANTLE_RPC = savedMantleRpc;
  if (savedAlchemyKey === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = savedAlchemyKey;
  if (savedDrpcKey === undefined) delete process.env.DRPC_API_KEY;
  else process.env.DRPC_API_KEY = savedDrpcKey;
  _resetChainRegistryCache();
});

describe("provider normalization + quorum rule", () => {
  it("normalizes labels (lowercase, strip other-, collapse thirdweb)", () => {
    expect(normalizeProvider("DRPC")).toBe("drpc");
    expect(normalizeProvider("other-thirdweb")).toBe("thirdweb");
    expect(normalizeProvider("thirdweb")).toBe("thirdweb");
    expect(normalizeProvider("42161.rpc.thirdweb.com")).toBe("thirdweb");
    expect(normalizeProvider("other-nodies")).toBe("nodies");
  });

  it("counts distinct providers after normalization", () => {
    expect(distinctProviderCount([rpc("a", "thirdweb"), rpc("b", "other-thirdweb")])).toBe(1);
    expect(distinctProviderCount([rpc("a", "drpc"), rpc("b", "official")])).toBe(2);
  });

  it("requires >=2 rpcs from >=2 distinct providers", () => {
    expect(meetsQuorum([rpc("a", "drpc")])).toBe(false); // one endpoint
    expect(meetsQuorum([rpc("a", "official"), rpc("b", "official")])).toBe(false); // same provider
    expect(meetsQuorum([rpc("a", "official"), rpc("b", "drpc")])).toBe(true);
  });
});

describe("registry lookups", () => {
  beforeEach(() => writeRegistry({ mantle: twoProviderChain, solo: oneProviderChain }));

  it("looks up by chainId", () => {
    expect(getChainRef(5000)?.chainKey).toBe("mantle");
    expect(getChainRef(123456)).toBeNull();
  });

  it("looks up by chainKey", () => {
    expect(getChainRefByKey("mantle")?.chainId).toBe(5000);
    expect(getChainRefByKey("nope")).toBeNull();
  });

  it("marks a single-provider chain ineligible even if the file says eligible", () => {
    expect(getChainRef(99999)?.eligible).toBe(false);
    expect(getChainRef(5000)?.eligible).toBe(true);
  });

  it("listEligibleChains excludes chains that fail the quorum rule", () => {
    const keys = listEligibleChains().map((c) => c.chainKey);
    expect(keys).toContain("mantle");
    expect(keys).not.toContain("solo");
  });
});

describe("MANTLE_RPC has no effect on the read path", () => {
  // The MANTLE_RPC read-path override was deleted 2026-07-20. It was a
  // backward-compat shim for single-chain deployments that no longer exist,
  // and it demoted the keyed Alchemy endpoint to a fallback on the one chain
  // whose primary was an unkeyed public endpoint. MANTLE_RPC still belongs to
  // the hardhat deploy config under contracts/, which is why the variable
  // lives on — these tests pin that the BACKEND read path ignores it.

  it("keeps the keyed providers at the front on mantle even when MANTLE_RPC is set", () => {
    process.env.ALCHEMY_API_KEY = "akey";
    process.env.DRPC_API_KEY = "dkey";
    process.env.MANTLE_RPC = "https://custom-mantle.example/rpc";
    writeRegistry({ mantle: twoProviderChain });
    const ref = getChainRef(5000)!;
    // Alchemy primary, keyed dRPC as the distinct-provider cross-check peer.
    expect(ref.rpcs[0].url).toBe("https://mantle-mainnet.g.alchemy.com/v2/akey");
    expect(ref.rpcs[1].url).toBe("https://lb.drpc.live/mantle/dkey");
    expect(ref.rpcs.some((r) => r.url === "https://custom-mantle.example/rpc")).toBe(false);
  });

  // Kills a "soft" reintroduction of the override that only applies when no
  // keyed providers are configured: with no keys set, registry order must
  // still govern completely.
  it("leaves registry order untouched on mantle when MANTLE_RPC is set and no keys are", () => {
    process.env.MANTLE_RPC = "https://custom-mantle.example/rpc";
    writeRegistry({ mantle: twoProviderChain });
    const ref = getChainRef(5000)!;
    expect(ref.rpcs.map((r) => r.url)).toEqual([
      "https://rpc.mantle.xyz",
      "https://mantle.drpc.org",
    ]);
  });

  it("still meets quorum and stays eligible on mantle", () => {
    process.env.MANTLE_RPC = "https://custom-mantle.example/rpc";
    writeRegistry({ mantle: twoProviderChain });
    expect(getChainRef(5000)!.eligible).toBe(true);
  });
});

describe("keyed provider overrides (ALCHEMY_API_KEY / DRPC_API_KEY)", () => {
  const ethChain = {
    chainKey: "ethereum",
    eid: 30101,
    chainId: 1,
    eligible: true,
    etherscanFree: true,
    rpcs: [rpc("https://eth.merkle.io", "meowrpc"), rpc("https://ethereum-rpc.publicnode.com", "publicnode")],
    note: "",
  };

  it("prepends a keyed alchemy endpoint for mapped chains, publics preserved behind it", () => {
    process.env.ALCHEMY_API_KEY = "testkey";
    writeRegistry({ ethereum: ethChain });
    const ref = getChainRef(1)!;
    expect(ref.rpcs[0]).toEqual({ url: "https://eth-mainnet.g.alchemy.com/v2/testkey", provider: "alchemy" });
    expect(ref.rpcs.some((r) => r.url === "https://eth.merkle.io")).toBe(true);
    expect(ref.rpcs.some((r) => r.url === "https://ethereum-rpc.publicnode.com")).toBe(true);
  });

  it("prepends a keyed drpc endpoint using the drpc network slug", () => {
    process.env.DRPC_API_KEY = "dkey";
    const baseChain = { ...ethChain, chainKey: "base", eid: 30184, chainId: 8453 };
    writeRegistry({ base: baseChain });
    const ref = getChainRef(8453)!;
    expect(ref.rpcs[0]).toEqual({ url: "https://lb.drpc.live/base/dkey", provider: "drpc" });
  });

  it("with both keys set, order is alchemy (primary) then drpc (first quorum peer)", () => {
    process.env.ALCHEMY_API_KEY = "akey";
    process.env.DRPC_API_KEY = "dkey";
    writeRegistry({ ethereum: ethChain });
    const ref = getChainRef(1)!;
    expect(ref.rpcs[0].provider).toBe("alchemy");
    expect(ref.rpcs[1]).toEqual({ url: "https://lb.drpc.live/ethereum/dkey", provider: "drpc" });
    expect(ref.rpcs.length).toBe(4);
  });

  it("leaves unmapped chains untouched even when keys are set", () => {
    process.env.ALCHEMY_API_KEY = "akey";
    process.env.DRPC_API_KEY = "dkey";
    writeRegistry({ solo: oneProviderChain });
    const ref = getChainRef(99999)!;
    expect(ref.rpcs.map((r) => r.provider)).toEqual(["official", "official"]);
  });

  it("is a no-op when neither key is set", () => {
    writeRegistry({ ethereum: ethChain });
    const ref = getChainRef(1)!;
    expect(ref.rpcs.length).toBe(2);
    expect(ref.rpcs[0].provider).toBe("meowrpc");
  });

  it("does not duplicate a keyed URL already present in the registry file", () => {
    process.env.ALCHEMY_API_KEY = "akey";
    const withKeyed = {
      ...ethChain,
      rpcs: [rpc("https://eth-mainnet.g.alchemy.com/v2/akey", "alchemy"), rpc("https://eth.merkle.io", "meowrpc")],
    };
    writeRegistry({ ethereum: withKeyed });
    const ref = getChainRef(1)!;
    expect(ref.rpcs.filter((r) => r.url.includes("alchemy")).length).toBe(1);
  });

  it("keyed providers count toward the quorum invariant", () => {
    // One distinct public provider — ineligible on file rpcs alone; the keyed
    // endpoint is a real second provider, so quorum is genuinely met.
    process.env.ALCHEMY_API_KEY = "akey";
    const thin = { ...ethChain, rpcs: [rpc("https://eth.merkle.io", "meowrpc")] };
    writeRegistry({ ethereum: thin });
    expect(getChainRef(1)?.eligible).toBe(true);
  });

  it("a thin chain stays ineligible without a key", () => {
    const thin = { ...ethChain, rpcs: [rpc("https://eth.merkle.io", "meowrpc")] };
    writeRegistry({ ethereum: thin });
    expect(getChainRef(1)?.eligible).toBe(false);
  });
});

describe("missing / malformed file", () => {
  it("throws when the registry file is missing", () => {
    process.env.CHAIN_REGISTRY_PATH = join(dir, "does-not-exist.json");
    _resetChainRegistryCache();
    expect(() => getChainRef(5000)).toThrow(/cannot read\/parse/);
  });

  it("throws when the registry is malformed (no chains)", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ nope: true }));
    process.env.CHAIN_REGISTRY_PATH = file;
    _resetChainRegistryCache();
    expect(() => getChainRef(5000)).toThrow(/malformed/);
  });
});

describe("multicall3 flag", () => {
  it("defaults to false when the registry omits it", () => {
    writeRegistry({ mantle: twoProviderChain }); // no multicall3 key at all
    expect(getChainRef(5000)!.multicall3).toBe(false);
  });

  it("is true when the registry declares it", () => {
    writeRegistry({ mantle: { ...twoProviderChain, multicall3: true } });
    expect(getChainRef(5000)!.multicall3).toBe(true);
  });

  it("coerces a non-boolean to false", () => {
    writeRegistry({ mantle: { ...twoProviderChain, multicall3: "yes" } });
    expect(getChainRef(5000)!.multicall3).toBe(false);
  });

  it("does not let the flag affect eligibility", () => {
    // Eligibility is the quorum rule and nothing else. Pin BOTH directions:
    // the flag can neither cost a quorum-passing chain its eligibility, nor
    // buy eligibility for a chain that fails quorum.
    const eligibilityOf = (entry: Record<string, unknown>): boolean => {
      writeRegistry({ mantle: entry });
      return getChainRef(5000)!.eligible;
    };
    // Same 2-distinct-provider entry, flag true / false / absent → invariant.
    expect(eligibilityOf({ ...twoProviderChain, multicall3: true })).toBe(true);
    expect(eligibilityOf({ ...twoProviderChain, multicall3: false })).toBe(true);
    expect(eligibilityOf({ ...twoProviderChain })).toBe(true); // key absent

    // A single-provider chain fails quorum; multicall3: true must not rescue it.
    writeRegistry({ solo: { ...oneProviderChain, multicall3: true } });
    expect(getChainRef(99999)!.multicall3).toBe(true); // flag really is set
    expect(getChainRef(99999)!.eligible).toBe(false);
    expect(listEligibleChains().map((c) => c.chainKey)).not.toContain("solo");
  });
});

describe("committed chain-registry.json artifact", () => {
  // Later tasks batch reads on these three. A regeneration that came back
  // all-false, or a hand-edit, would otherwise ship green.
  it("carries multicall3: true for ethereum, base and mantle", () => {
    const artifact = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "chain-registry.json");
    // Read the file directly — getChainRef honours CHAIN_REGISTRY_PATH, which
    // these tests repoint at fixtures. Shape is { chains: { <chainKey>: … } }.
    const parsed = JSON.parse(readFileSync(artifact, "utf8")) as {
      chains?: Record<string, { multicall3?: unknown }>;
    };
    expect(parsed.chains, "artifact has no chains map").toBeTruthy();
    for (const key of ["ethereum", "base", "mantle"]) {
      expect(parsed.chains![key], `${key} missing from the committed registry`).toBeTruthy();
      expect(parsed.chains![key].multicall3, `${key}.multicall3`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Generator probe: the null-vs-false distinction IS the fail-safe guarantee.
// A wrong `true` makes Task 3 batch reads on a chain with no Multicall3 and
// fail every read there, so the only input that may ever produce `true` is a
// well-formed positive answer. Everything else must read as "no answer" (null,
// fall through) or "definitively absent" (false).
// ---------------------------------------------------------------------------
describe("multicall3 probe (build-chain-registry)", () => {
  // Real Multicall3 runtime bytecode prefix, as an endpoint would return it.
  const BYTECODE = "0x6080604052600436106100f35760003560e01c80634d2301cc11610095";

  type Stub =
    | { kind: "throw" }
    | { kind: "http"; status: number }
    | { kind: "badJson" }
    | { kind: "body"; body: unknown };

  const ok = (body: unknown) => ({ kind: "body", body } as Stub);
  const rpcError = ok({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000, message: "Temporary internal error. Please retry" },
  });

  function respond(s: Stub): Promise<unknown> {
    switch (s.kind) {
      case "throw":
        return Promise.reject(new Error("socket hang up / aborted"));
      case "http":
        return Promise.resolve({ ok: false, status: s.status, json: async () => ({}) });
      case "badJson":
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON at position 0");
          },
        });
      case "body":
        return Promise.resolve({ ok: true, status: 200, json: async () => s.body });
    }
  }

  /** Stub global fetch from a url → response plan. An array is consumed one
   *  entry per call (last entry repeats), which lets a test model "429 then
   *  answers". Returns the recorded call order — one entry PER ATTEMPT. */
  function stubFetch(plan: Record<string, Stub | Stub[]>): string[] {
    const calls: string[] = [];
    const seen: Record<string, number> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        const entry = plan[url];
        if (entry === undefined) return Promise.reject(new Error(`unplanned fetch to ${url}`));
        if (!Array.isArray(entry)) return respond(entry);
        const i = Math.min(seen[url] ?? 0, entry.length - 1);
        seen[url] = (seen[url] ?? 0) + 1;
        return respond(entry[i]);
      }),
    );
    return calls;
  }

  afterEach(() => vi.unstubAllGlobals());

  describe("probeMulticall3Once", () => {
    it("returns null on a JSON-RPC error response", async () => {
      stubFetch({ "https://a": rpcError });
      expect(await _probeMulticall3Once("https://a")).toBeNull();
    });

    it("returns null when the request throws or times out", async () => {
      stubFetch({ "https://a": { kind: "throw" } });
      expect(await _probeMulticall3Once("https://a")).toBeNull();
    });

    it("returns null on an HTTP non-ok", async () => {
      stubFetch({ "https://a": { kind: "http", status: 429 }, "https://b": { kind: "http", status: 503 } });
      expect(await _probeMulticall3Once("https://a")).toBeNull();
      expect(await _probeMulticall3Once("https://b")).toBeNull();
    });

    it("returns null when the body is not JSON", async () => {
      stubFetch({ "https://a": { kind: "badJson" } });
      expect(await _probeMulticall3Once("https://a")).toBeNull();
    });

    it("returns null when result is not a string", async () => {
      stubFetch({
        "https://num": ok({ result: 1234 }),
        "https://null": ok({ result: null }),
        "https://obj": ok({ result: { code: "0xdead" } }),
        "https://arr": ok({ result: ["0xdead"] }),
        "https://absent": ok({ jsonrpc: "2.0", id: 1 }),
      });
      for (const u of ["https://num", "https://null", "https://obj", "https://arr", "https://absent"]) {
        expect(await _probeMulticall3Once(u), u).toBeNull();
      }
    });

    it("returns null when result is a string that does not start with 0x", async () => {
      stubFetch({
        "https://raw": ok({ result: "6080604052600436106100f3" }),
        "https://empty": ok({ result: "" }),
        "https://text": ok({ result: "not available" }),
      });
      for (const u of ["https://raw", "https://empty", "https://text"]) {
        expect(await _probeMulticall3Once(u), u).toBeNull();
      }
    });

    it('returns false for "0x" — a definitive "no contract there"', async () => {
      stubFetch({ "https://a": ok({ result: "0x" }) });
      expect(await _probeMulticall3Once("https://a")).toBe(false);
    });

    it("returns true only for real bytecode", async () => {
      stubFetch({ "https://a": ok({ result: BYTECODE }) });
      expect(await _probeMulticall3Once("https://a")).toBe(true);
    });
  });

  describe("probeMulticall3 (across endpoints)", () => {
    it("falls through to the next endpoint on a JSON-RPC error", async () => {
      // The sei case: drpc errors, sei-apis.com answers. Must not read as false.
      const calls = stubFetch({ "https://bad": rpcError, "https://good": ok({ result: BYTECODE }) });
      expect(await _probeMulticall3(["https://bad", "https://good"])).toBe(true);
      expect(calls).toEqual(["https://bad", "https://bad", "https://good"]); // 1 retry, then next
    });

    it("falls through when an endpoint throws / times out", async () => {
      const calls = stubFetch({ "https://dead": { kind: "throw" }, "https://good": ok({ result: BYTECODE }) });
      expect(await _probeMulticall3(["https://dead", "https://good"])).toBe(true);
      expect(calls).toContain("https://good");
    });

    it("falls through on an HTTP non-ok", async () => {
      const calls = stubFetch({ "https://429": { kind: "http", status: 429 }, "https://good": ok({ result: BYTECODE }) });
      expect(await _probeMulticall3(["https://429", "https://good"])).toBe(true);
      expect(calls).toContain("https://good");
    });

    it("stops at the first DEFINITIVE answer, without consulting later endpoints", async () => {
      // "0x" is an answer, not a failure — no fall-through, no retry.
      const calls = stubFetch({ "https://a": ok({ result: "0x" }), "https://b": ok({ result: BYTECODE }) });
      expect(await _probeMulticall3(["https://a", "https://b"])).toBe(false);
      expect(calls).toEqual(["https://a"]);
    });

    it("retries a single endpoint once before giving up (429 then answer)", async () => {
      // The single-verified-endpoint chain: one 429 must not cost it the flag.
      const calls = stubFetch({ "https://solo": [{ kind: "http", status: 429 }, ok({ result: BYTECODE })] });
      expect(await _probeMulticall3(["https://solo"])).toBe(true);
      expect(calls).toEqual(["https://solo", "https://solo"]);
    });

    it("returns false — never true — when every endpoint fails", async () => {
      const calls = stubFetch({
        "https://a": rpcError,
        "https://b": { kind: "throw" },
        "https://c": { kind: "http", status: 500 },
      });
      expect(await _probeMulticall3(["https://a", "https://b", "https://c"])).toBe(false);
      expect(calls.length).toBe(6); // every endpoint tried twice, none skipped
    });

    it("returns false for a chain with zero verified endpoints, without any fetch", async () => {
      const calls = stubFetch({});
      expect(await _probeMulticall3([])).toBe(false);
      expect(calls).toEqual([]);
    });

    it("NO input path yields true except a well-formed positive answer", async () => {
      // The one assertion this whole block exists for.
      const nonPositive: Stub[] = [
        rpcError,
        { kind: "throw" },
        { kind: "http", status: 429 },
        { kind: "http", status: 500 },
        { kind: "badJson" },
        ok({ result: 1 }),
        ok({ result: null }),
        ok({ jsonrpc: "2.0", id: 1 }),
        ok({ result: "6080" }),
        ok({ result: "0x" }),
      ];
      for (const [i, s] of nonPositive.entries()) {
        vi.unstubAllGlobals();
        stubFetch({ "https://x": s });
        expect(await _probeMulticall3(["https://x"]), `shape #${i}`).toBe(false);
      }
      // …and the positive control, so the loop above cannot pass vacuously.
      vi.unstubAllGlobals();
      stubFetch({ "https://x": ok({ result: BYTECODE }) });
      expect(await _probeMulticall3(["https://x"])).toBe(true);
    }, 30_000);
  });
});

describe("chainDisplayName", () => {
  it("capitalizes a plain chainKey", () => {
    expect(chainDisplayName("ethereum")).toBe("Ethereum");
    expect(chainDisplayName("base")).toBe("Base");
    expect(chainDisplayName("mantle")).toBe("Mantle");
  });

  it("uses the accepted spelling where capitalization is wrong", () => {
    expect(chainDisplayName("bsc")).toBe("BNB Chain");
    expect(chainDisplayName("zksync")).toBe("zkSync");
    expect(chainDisplayName("opbnb")).toBe("opBNB");
  });

  it("never throws on missing input", () => {
    expect(chainDisplayName(null)).toBe("Unknown");
    expect(chainDisplayName(undefined)).toBe("Unknown");
  });
});
