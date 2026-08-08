import { afterEach, describe, expect, it, vi } from "vitest";

// getWatched() must never turn an upstream watchlist outage into a silent empty
// fleet: Dune down + cold cache previously meant "poll nothing, report nothing,
// dashboards keep smiling" — a monitoring blackout displayed as safety.

const MANTLE_ADDR = "0x1111111111111111111111111111111111111111";
const ETH_ADDR = "0x2222222222222222222222222222222222222222";

interface MockOpts {
  mantle?: () => Promise<{ ticker: string; address: string; usdVolume: number }[]>;
  eth?: () => Promise<{ ticker: string; address: string }[]>;
}

const sendTelegram = vi.fn().mockResolvedValue(undefined);

async function loadSentinel(opts: MockOpts = {}) {
  vi.doMock("../services/dune.js", () => ({
    getMantleOfts:
      opts.mantle ?? (async () => [{ ticker: "MNT1", address: MANTLE_ADDR, usdVolume: 2_000_000 }]),
    getActiveOftsForChain: opts.eth ?? (async () => [{ ticker: "ETH1", address: ETH_ADDR }]),
    activeWatchlistChainKeys: () => ["ethereum"],
  }));
  // PARTIAL mock — see watchlist-scope.test.ts for why a full replacement is a
  // trap: it makes this suite fail whenever chain-registry grows an export.
  vi.doMock("../services/chain-registry.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/chain-registry.js")>()),
    getChainRef: (chainId: number) =>
      chainId === 1 ? { chainId: 1, chainKey: "ethereum", eligible: true } : null,
    getChainRefByKey: (key: string) =>
      key === "ethereum" ? { chainId: 1, chainKey: "ethereum", eligible: true } : null,
  }));
  vi.doMock("../services/alerts.js", () => ({ sendTelegram }));
  return await import("../services/sentinel.js");
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../services/dune.js");
  vi.doUnmock("../services/chain-registry.js");
  vi.doUnmock("../services/alerts.js");
  sendTelegram.mockClear();
});

describe("getWatched watchlist health", () => {
  it("reports healthy when all sources resolve", async () => {
    const s = await loadSentinel();
    const list = await s.getWatched(true);
    expect(list.map((w) => w.ticker)).toEqual(["MNT1", "ETH1", "DEMO"]);
    const health = s.getWatchlistHealth();
    expect(health.degraded).toBe(false);
    expect(health.reasons).toEqual([]);
    expect(health.lastRefreshAt).not.toBeNull();
  });

  it("flags degraded with per-source reasons when one source fails, still serving the rest", async () => {
    const s = await loadSentinel({
      eth: async () => {
        throw new Error("dune 500");
      },
    });
    const list = await s.getWatched(true);
    expect(list.map((w) => w.ticker)).toEqual(["MNT1", "DEMO"]);
    const health = s.getWatchlistHealth();
    expect(health.degraded).toBe(true);
    expect(health.reasons.join(" ")).toContain("ethereum");
  });

  it("serves the last good list instead of an empty fleet when every source fails", async () => {
    let fail = false;
    const s = await loadSentinel({
      mantle: async () => {
        if (fail) throw new Error("dune down");
        return [{ ticker: "MNT1", address: MANTLE_ADDR, usdVolume: 2_000_000 }];
      },
      eth: async () => {
        if (fail) throw new Error("dune down");
        return [{ ticker: "ETH1", address: ETH_ADDR }];
      },
    });
    await s.getWatched(true); // prime the cache
    fail = true;
    const list = await s.getWatched(true);
    expect(list.map((w) => w.ticker)).toEqual(["MNT1", "ETH1", "DEMO"]); // stale, not empty
    const health = s.getWatchlistHealth();
    expect(health.degraded).toBe(true);
    expect(health.servedStaleAt).not.toBeNull();
  });

  it("returns only DEMO on total failure with a cold cache — degraded, never crashing", async () => {
    const s = await loadSentinel({
      mantle: async () => {
        throw new Error("dune down");
      },
      eth: async () => {
        throw new Error("dune down");
      },
    });
    const list = await s.getWatched(true);
    expect(list.map((w) => w.ticker)).toEqual(["DEMO"]);
    expect(s.getWatchlistHealth().degraded).toBe(true);
  });

  it("fires the blackout alert once per outage and re-arms on recovery", async () => {
    let fail = true;
    const s = await loadSentinel({
      mantle: async () => {
        if (fail) throw new Error("dune down");
        return [{ ticker: "MNT1", address: MANTLE_ADDR, usdVolume: 2_000_000 }];
      },
      eth: async () => {
        if (fail) throw new Error("dune down");
        return [{ ticker: "ETH1", address: ETH_ADDR }];
      },
    });
    await s.getWatched(true);
    await s.getWatched(true); // still failing — no second alert
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(String(sendTelegram.mock.calls[0][1])).toContain("watchlist");

    fail = false;
    await s.getWatched(true); // recovery re-arms the latch
    expect(s.getWatchlistHealth().degraded).toBe(false);

    fail = true;
    await s.getWatched(true); // second outage alerts again
    expect(sendTelegram).toHaveBeenCalledTimes(2);
  });
});
