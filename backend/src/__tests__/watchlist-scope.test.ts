import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A Sentinel instance can be scoped to a single chain (WATCH_CHAINS) and told to
// watch assets Dune has not indexed yet (WATCH_PINNED) — that pair is what makes
// a freshly-launched chain monitorable on day one, before any 7-day activity
// history exists. Both must be INERT when unset: the default fleet stays the
// full multi-chain fleet, Mantle leaderboard and the replay demo asset included.
//
// Mock idiom (dune / chain-registry / alerts via vi.doMock + dynamic import) is
// copied from watchlist-health.test.ts, which is the house pattern for getWatched.

const MANTLE_ADDR = "0x1111111111111111111111111111111111111111";
const ETH_ADDR = "0x2222222222222222222222222222222222222222";
const FLARE_ADDR = "0x3333333333333333333333333333333333333333";
const PIN_ADDR = "0x00502397F31ee5989a24329ed3dFED55828e6786";

const sendTelegram = vi.fn().mockResolvedValue(undefined);

const getMantleOfts = vi.fn(async (_force?: boolean) => [
  { ticker: "MNT1", address: MANTLE_ADDR, usdVolume: 2_000_000 },
]);

const ACTIVE_ROWS: Record<string, { ticker: string; address: string }[]> = {
  ethereum: [{ ticker: "ETH1", address: ETH_ADDR }],
  flare: [{ ticker: "FLR1", address: FLARE_ADDR }],
};
const getActiveOftsForChain = vi.fn(async (chainKey: string, _force?: boolean) => ACTIVE_ROWS[chainKey] ?? []);

const REFS: Record<string, { chainId: number; chainKey: string; eligible: boolean }> = {
  ethereum: { chainId: 1, chainKey: "ethereum", eligible: true },
  flare: { chainId: 14, chainKey: "flare", eligible: true },
  mantle: { chainId: 5000, chainKey: "mantle", eligible: true },
};

async function loadSentinel() {
  vi.doMock("../services/dune.js", () => ({
    getMantleOfts,
    getActiveOftsForChain,
    activeWatchlistChainKeys: () => ["ethereum", "flare"],
  }));
  // PARTIAL mock: keep every real export and override only the two lookups this
  // suite needs. A full replacement broke the moment an unrelated module started
  // importing something else from chain-registry (sentinelChain), which is a
  // failure of the double, not of the code under test.
  vi.doMock("../services/chain-registry.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/chain-registry.js")>()),
    getChainRef: (chainId: number) => Object.values(REFS).find((r) => r.chainId === chainId) ?? null,
    getChainRefByKey: (key: string) => REFS[key] ?? null,
  }));
  vi.doMock("../services/alerts.js", () => ({ sendTelegram }));
  return await import("../services/sentinel.js");
}

// The unset cases are the ones that guard existing behavior, so the run must not
// depend on what happens to be exported in the ambient shell — `WATCH_CHAINS=flare
// npm start` is how this build is meant to be run locally.
beforeEach(() => {
  for (const name of ["WATCH_CHAINS", "WATCH_PINNED"]) vi.stubEnv(name, undefined);
  getMantleOfts.mockClear();
  getActiveOftsForChain.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../services/dune.js");
  vi.doUnmock("../services/chain-registry.js");
  vi.doUnmock("../services/alerts.js");
  sendTelegram.mockClear();
});

describe("getWatched scoping", () => {
  it("watches the whole fleet when WATCH_CHAINS is unset (existing behavior)", async () => {
    const s = await loadSentinel();
    const list = await s.getWatched(true);
    expect(list.map((w) => w.ticker)).toEqual(["MNT1", "ETH1", "FLR1", "DEMO"]);
    expect(getMantleOfts).toHaveBeenCalledTimes(1);
    expect(getActiveOftsForChain.mock.calls.map((c) => c[0])).toEqual(["ethereum", "flare"]);
    expect(s.getWatchlistHealth().degraded).toBe(false);
  });

  it("polls only the scoped chain and drops the Mantle demo when WATCH_CHAINS=flare", async () => {
    vi.stubEnv("WATCH_CHAINS", "flare");
    const s = await loadSentinel();
    const list = await s.getWatched(true);
    expect(list.map((w) => w.ticker)).toEqual(["FLR1"]); // no MNT1, no ETH1, no DEMO
    expect(getMantleOfts).not.toHaveBeenCalled();
    expect(getActiveOftsForChain.mock.calls.map((c) => c[0])).toEqual(["flare"]);
    expect(s.getWatchlistHealth().degraded).toBe(false);
  });

  it("watches a pinned asset Dune never returned, at the registry chainId", async () => {
    vi.stubEnv("WATCH_CHAINS", "flare");
    vi.stubEnv("WATCH_PINNED", `flare:${PIN_ADDR}:DEMOFT`);
    const s = await loadSentinel();
    const list = await s.getWatched(true);
    expect(list).toContainEqual({ ticker: "DEMOFT", address: PIN_ADDR, chainId: 14 });
    expect(list.map((w) => w.ticker)).toEqual(["FLR1", "DEMOFT"]);
  });

  it("watches a pin on a chain OUTSIDE WATCH_CHAINS — an operator pin outranks the scope", async () => {
    // A pin is an explicit operator instruction, not a discovery result, so the
    // chain allowlist must not silently drop it. Mantle is scoped out here: its
    // Dune leaderboard is never called and the replay demo asset is gone, yet the pinned
    // Mantle asset is still watched, at the registry chainId.
    vi.stubEnv("WATCH_CHAINS", "flare");
    vi.stubEnv("WATCH_PINNED", `mantle:${PIN_ADDR}:MNTPIN`);
    const s = await loadSentinel();
    const list = await s.getWatched(true);
    expect(list).toContainEqual({ ticker: "MNTPIN", address: PIN_ADDR, chainId: 5000 });
    expect(list.map((w) => w.ticker)).toEqual(["FLR1", "MNTPIN"]); // no MNT1, no DEMO
    expect(getMantleOfts).not.toHaveBeenCalled();
  });

  it("keeps a pin that duplicates a Dune row to a single entry", async () => {
    vi.stubEnv("WATCH_CHAINS", "flare");
    vi.stubEnv("WATCH_PINNED", `flare:${FLARE_ADDR}:DUPE`);
    const s = await loadSentinel();
    const list = await s.getWatched(true);
    expect(list.filter((w) => w.address.toLowerCase() === FLARE_ADDR.toLowerCase())).toHaveLength(1);
    expect(list.map((w) => w.ticker)).toEqual(["FLR1"]); // the Dune row wins, pin is a no-op
  });

  it("skips a pin whose chain has no eligible registry ref, warning instead of crashing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("WATCH_CHAINS", "flare");
    vi.stubEnv("WATCH_PINNED", `notachain:${PIN_ADDR}:GHOST`);
    const s = await loadSentinel();
    const list = await s.getWatched(true);
    expect(list.map((w) => w.ticker)).toEqual(["FLR1"]); // unchanged — the pin is dropped
    expect(warn.mock.calls.flat().join(" ")).toContain("notachain");
  });
});
