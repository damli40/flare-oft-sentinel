import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseWatchChains,
  chainAllowed,
  parsePins,
  pinnedAssets,
  attestScopeMode,
  attestPinnedAssets,
} from "../services/watch-scope.js";

// Several cases assert the UNSET behaviour ("no filter", "not pinned"), so the
// run must not depend on what happens to be exported in the ambient shell —
// `WATCH_CHAINS=flare npm start` is how this build is meant to be run locally.
// stubEnv(name, undefined) deletes; unstubAllEnvs puts the real value back.
beforeEach(() => {
  for (const name of ["WATCH_CHAINS", "WATCH_PINNED", "ATTEST_SCOPE", "ATTEST_PINNED"])
    vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("parseWatchChains", () => {
  it("returns null when unset or blank (no filter)", () => {
    expect(parseWatchChains(undefined)).toBeNull();
    expect(parseWatchChains("  ")).toBeNull();
  });
  it("parses a comma list, trimmed and lowercased", () => {
    expect(parseWatchChains(" Flare , mantle ")).toEqual(new Set(["flare", "mantle"]));
  });
});

describe("chainAllowed", () => {
  it("allows everything when WATCH_CHAINS is unset", () => {
    expect(chainAllowed("mantle")).toBe(true);
  });
  it("filters when set", () => {
    vi.stubEnv("WATCH_CHAINS", "flare");
    expect(chainAllowed("flare")).toBe(true);
    expect(chainAllowed("mantle")).toBe(false);
  });
});

describe("parsePins", () => {
  const ADDR = "0x00502397F31ee5989a24329ed3dFED55828e6786";
  it("parses chainKey:address with default ticker PINNED", () => {
    expect(parsePins(`flare:${ADDR}`)).toEqual([{ chainKey: "flare", address: ADDR, ticker: "PINNED" }]);
  });
  it("parses an explicit ticker and multiple entries", () => {
    expect(parsePins(`flare:${ADDR}:DEMOFT, mantle:${ADDR}:X`)).toEqual([
      { chainKey: "flare", address: ADDR, ticker: "DEMOFT" },
      { chainKey: "mantle", address: ADDR, ticker: "X" },
    ]);
  });
  it("drops malformed entries (bad address, missing parts) and keeps good ones", () => {
    // The drop is meant to be visible, not silent — assert the warning here and
    // keep it out of the suite's output at the same time.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parsePins(`flare:nothex,flare:${ADDR}`)).toEqual([{ chainKey: "flare", address: ADDR, ticker: "PINNED" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("nothex");
    expect(parsePins("")).toEqual([]);
    expect(parsePins(undefined)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1); // empty input is not a malformed entry
  });
});

describe("parsePins label", () => {
  it("names the variable the malformed entry came from", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parsePins("garbage", "ATTEST_PINNED");
    expect(String(warn.mock.calls[0][0])).toContain("ATTEST_PINNED");
    parsePins("garbage");
    expect(String(warn.mock.calls[1][0])).toContain("WATCH_PINNED"); // default label
  });
});

describe("attestScopeMode", () => {
  it("is 'all' when unset or blank — production must keep attesting everything", () => {
    expect(attestScopeMode()).toBe("all");
    vi.stubEnv("ATTEST_SCOPE", "");
    expect(attestScopeMode()).toBe("all");
    vi.stubEnv("ATTEST_SCOPE", "   ");
    expect(attestScopeMode()).toBe("all");
  });
  it("is 'allowlist' for the allowlist mode", () => {
    vi.stubEnv("ATTEST_SCOPE", "allowlist");
    expect(attestScopeMode()).toBe("allowlist");
    vi.stubEnv("ATTEST_SCOPE", " allowlist ");
    expect(attestScopeMode()).toBe("allowlist");
  });
  it("is 'invalid' for any other value, including the removed 'pinned'", () => {
    vi.stubEnv("ATTEST_SCOPE", "pinned");
    expect(attestScopeMode()).toBe("invalid");
    vi.stubEnv("ATTEST_SCOPE", "ALLOWLIST"); // exact-string only, like the rest of this codebase
    expect(attestScopeMode()).toBe("invalid");
  });
});

describe("pinnedAssets", () => {
  it("reads WATCH_PINNED at call time", () => {
    vi.stubEnv("WATCH_PINNED", "flare:0x00502397F31ee5989a24329ed3dFED55828e6786:DEMOFT");
    expect(pinnedAssets()).toHaveLength(1);
  });
});

describe("attestPinnedAssets", () => {
  const ADDR = "0x00502397F31ee5989a24329ed3dFED55828e6786";

  it("reads ATTEST_PINNED, never WATCH_PINNED", () => {
    vi.stubEnv("WATCH_PINNED", `flare:${ADDR}:WATCHED`);
    expect(attestPinnedAssets()).toEqual([]); // ATTEST_PINNED unset → nothing signable
    vi.stubEnv("ATTEST_PINNED", `flare:${ADDR}:MOFT`);
    expect(attestPinnedAssets()).toEqual([{ chainKey: "flare", address: ADDR, ticker: "MOFT" }]);
  });

  it("returns [] for unset, empty and unparseable input", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(attestPinnedAssets()).toEqual([]);
    vi.stubEnv("ATTEST_PINNED", "");
    expect(attestPinnedAssets()).toEqual([]);
    vi.stubEnv("ATTEST_PINNED", "garbage,::,flare:nothex:X");
    expect(attestPinnedAssets()).toEqual([]);
  });

  it("filters entries on chains outside WATCH_CHAINS and says so loudly", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("WATCH_CHAINS", "flare");
    vi.stubEnv("ATTEST_PINNED", `mantle:${ADDR}:OFFCHAIN,flare:${ADDR}:MOFT`);
    expect(attestPinnedAssets()).toEqual([{ chainKey: "flare", address: ADDR, ticker: "MOFT" }]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("mantle");
  });
});
