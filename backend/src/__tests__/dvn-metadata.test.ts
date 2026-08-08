import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadDvnMeta, resetDvnMetaCache, dvnMetaFile, dvnMetaHash,
  resolveDvn, isDvnDeprecated, isDeadDvn, emptyDvnMeta,
  MetadataUnavailableError, DVN_META_SCHEMA_VERSION,
  type DvnMeta,
} from "../services/lz-config.js";

// Minimal shapes mirroring the two live endpoints. The DVN API is keyed by its OWN
// chainKey namespace ("zkconsensys"); deployments carries the Sentinel-facing chainKey
// ("linea") plus the eid that joins them.
const DVN_PAYLOAD = {
  mantle: { dvns: {
    "0xAAAA000000000000000000000000000000000001": { canonicalName: "LayerZero Labs", id: "layerzero-labs" },
    "0xDEAD000000000000000000000000000000000001": { canonicalName: "LZDeadDVN" },
  } },
  flare: { dvns: {
    // Same address as mantle's LIVE LZ Labs DVN, but a dead placeholder here.
    "0xAAAA000000000000000000000000000000000001": { canonicalName: "LZDeadDVN" },
  } },
  zkconsensys: { dvns: {
    "0xBBBB000000000000000000000000000000000001": { canonicalName: "BWare", id: "bware", deprecated: true },
    "0xBBBB000000000000000000000000000000000002": { canonicalName: "Nethermind", id: "nethermind" },
  } },
};
const DEPLOY_PAYLOAD = {
  "mantle-mainnet": { deployments: [{ chainKey: "mantle", eid: "30181", version: 2, stage: "mainnet", deadDVN: { address: "0xDEAD000000000000000000000000000000000001" } }] },
  "flare-mainnet": { deployments: [{ chainKey: "flare", eid: "30295", version: 2, stage: "mainnet" }] },
  // The alias: DVN API says "zkconsensys", the rest of Sentinel says "linea".
  "zkconsensys-mainnet": { deployments: [{ chainKey: "linea", eid: "30183", version: 2, stage: "mainnet" }] },
};

function mockFetch(opts: { fail?: boolean } = {}) {
  return vi.fn(async (url: string) => {
    if (opts.fail) throw new Error("network down");
    const body = url.includes("/dvns") ? DVN_PAYLOAD : DEPLOY_PAYLOAD;
    return { ok: true, status: 200, json: async () => body } as any;
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dvnmeta-"));
  vi.stubEnv("DATA_DIR", dir);
  resetDvnMetaCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetDvnMetaCache();
});

describe("loadDvnMeta — chainKey namespace join", () => {
  it("resolves the DVN-API alias to the chainKey the rest of Sentinel speaks", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const meta = await loadDvnMeta();
    // "zkconsensys" in the DVN API must land under "linea".
    expect(Object.keys(meta.byChain).sort()).toEqual(["flare", "linea", "mantle"]);
    expect(meta.byChain["zkconsensys"]).toBeUndefined();
    expect(resolveDvn("0xBBBB000000000000000000000000000000000002", "linea", meta)).toBe("Nethermind");
  });

  it("sees deprecated DVNs on an aliased chain (invisible before the join)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const meta = await loadDvnMeta();
    expect(isDvnDeprecated("0xBBBB000000000000000000000000000000000001", "linea", meta)).toBe(true);
    // Deprecation is per-chain: the same address is unknown on mantle, never "deprecated".
    expect(isDvnDeprecated("0xBBBB000000000000000000000000000000000001", "mantle", meta)).toBe(false);
  });
});

describe("loadDvnMeta — per-chain dead DVNs", () => {
  it("does not let a dead placeholder on one chain kill a live DVN on another", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const meta = await loadDvnMeta();
    const addr = "0xAAAA000000000000000000000000000000000001";
    // Dead on flare…
    expect(isDeadDvn(addr, "flare", meta)).toBe(true);
    // …but a real LayerZero Labs DVN on mantle. A flat union would return true here and
    // suppress the CRITICAL on any 1-of-1 using it.
    expect(isDeadDvn(addr, "mantle", meta)).toBe(false);
    expect(resolveDvn(addr, "mantle", meta)).toBe("LayerZero Labs");
  });

  it("picks up the deployments deadDVN.address for its own chain", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const meta = await loadDvnMeta();
    expect(isDeadDvn("0xDEAD000000000000000000000000000000000001", "mantle", meta)).toBe(true);
  });
});

describe("resolveDvn — no cross-chain name borrowing", () => {
  it("returns an address fragment rather than a name from another chain", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const meta = await loadDvnMeta();
    // Nethermind exists only on linea. Asking for it on mantle must not borrow the name.
    const out = resolveDvn("0xBBBB000000000000000000000000000000000002", "mantle", meta);
    expect(out).not.toBe("Nethermind");
    expect(out).toMatch(/^0x[0-9a-fA-F]{6}…$/);
  });

  it("fails closed with a null chainKey", () => {
    const meta = emptyDvnMeta();
    expect(isDvnDeprecated("0xBBBB000000000000000000000000000000000001", null, meta)).toBe(false);
    expect(isDeadDvn("0xAAAA000000000000000000000000000000000001", null, meta)).toBe(false);
  });
});

describe("dvnMetaHash — provenance", () => {
  it("is stable across key insertion order (canonicalized)", () => {
    const a: DvnMeta = {
      byChain: { mantle: { "0x02": { name: "B", deprecated: false, id: null }, "0x01": { name: "A", deprecated: false, id: null } }, base: {} },
      deadByChain: { mantle: new Set(["0xbb", "0xaa"]) },
      fetchedAt: 1,
    };
    const b: DvnMeta = {
      byChain: { base: {}, mantle: { "0x01": { name: "A", deprecated: false, id: null }, "0x02": { name: "B", deprecated: false, id: null } } },
      deadByChain: { mantle: new Set(["0xaa", "0xbb"]) },
      fetchedAt: 999, // fetchedAt is provenance, not content — must not move the hash
    };
    expect(dvnMetaHash(a)).toBe(dvnMetaHash(b));
  });

  it("changes when a deprecation flag flips", () => {
    const base = (deprecated: boolean): DvnMeta => ({
      byChain: { mantle: { "0x01": { name: "A", deprecated, id: null } } },
      deadByChain: {}, fetchedAt: 1,
    });
    expect(dvnMetaHash(base(false))).not.toBe(dvnMetaHash(base(true)));
  });

  it("changes when a dead address is added", () => {
    const m1: DvnMeta = { byChain: {}, deadByChain: {}, fetchedAt: 1 };
    const m2: DvnMeta = { byChain: {}, deadByChain: { mantle: new Set(["0xaa"]) }, fetchedAt: 1 };
    expect(dvnMetaHash(m1)).not.toBe(dvnMetaHash(m2));
  });
});

describe("loadDvnMeta — disk cache and fail-closed", () => {
  it("persists a fetched table to disk with its schemaVersion", async () => {
    vi.stubGlobal("fetch", mockFetch());
    await loadDvnMeta();
    expect(existsSync(dvnMetaFile())).toBe(true);
    const raw = JSON.parse(readFileSync(dvnMetaFile(), "utf8"));
    expect(raw.schemaVersion).toBe(DVN_META_SCHEMA_VERSION);
    expect(raw.byChain.linea).toBeDefined();
  });

  it("serves the stale disk copy when the live fetch fails", async () => {
    vi.stubGlobal("fetch", mockFetch());
    await loadDvnMeta();          // populate disk
    resetDvnMetaCache();          // simulate a cold start (Railway redeploy)
    vi.stubGlobal("fetch", mockFetch({ fail: true }));
    const meta = await loadDvnMeta();
    // Stale-but-real beats empty: the dead/deprecated tables still work.
    expect(isDeadDvn("0xAAAA000000000000000000000000000000000001", "flare", meta)).toBe(true);
    expect(isDvnDeprecated("0xBBBB000000000000000000000000000000000001", "linea", meta)).toBe(true);
  });

  it("throws MetadataUnavailableError on a cold start with no disk copy", async () => {
    vi.stubGlobal("fetch", mockFetch({ fail: true }));
    await expect(loadDvnMeta()).rejects.toBeInstanceOf(MetadataUnavailableError);
  });

  it("refuses a disk cache written under a different schemaVersion", async () => {
    // A v1 payload read by a v2 reader leaves deadByChain undefined → every dead pathway
    // silently becomes a false CRITICAL. Refuse it and fail closed instead.
    writeFileSync(dvnMetaFile(), JSON.stringify({
      schemaVersion: DVN_META_SCHEMA_VERSION - 1,
      byChain: { mantle: {} },
      globalFallback: {},
    }));
    vi.stubGlobal("fetch", mockFetch({ fail: true }));
    await expect(loadDvnMeta()).rejects.toBeInstanceOf(MetadataUnavailableError);
  });

  it("treats a parsed-but-empty DVN table as a failed fetch, not as valid metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as any));
    await expect(loadDvnMeta()).rejects.toBeInstanceOf(MetadataUnavailableError);
  });
});
