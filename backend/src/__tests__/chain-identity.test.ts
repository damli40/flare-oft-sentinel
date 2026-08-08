import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { explorerBase, sentinelChain } from "../services/chain-registry.js";
import { oftExplorerUrl, sentinelTxUrl } from "../services/alerts.js";

// Explorer links must resolve to the chain this instance actually runs on.
// Every component and service used to carry its own
// `const SEPOLIA = "https://sepolia.mantlescan.xyz"`, which is right for exactly
// one deployment: on Flare a real attestation hash rendered a URL that 404s. A
// proof link that lands on nothing is worse than no link, because the reader
// concludes the proof does not exist.

beforeEach(() => {
  for (const n of ["SENTINEL_CHAIN_ID", "SENTINEL_CHAIN_NAME"]) vi.stubEnv(n, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("explorer resolution follows the configured chain", () => {
  it("defaults to Mantle Sepolia when SENTINEL_CHAIN_ID is unset (production unchanged)", () => {
    const c = sentinelChain();
    expect(c.chainId).toBe(5003);
    expect(c.name).toBe("Mantle Sepolia");
    expect(c.explorer).toBe("https://sepolia.mantlescan.xyz");
  });

  it("resolves the Flare instance to a Flare explorer, never a Mantle one", () => {
    vi.stubEnv("SENTINEL_CHAIN_ID", "14");
    vi.stubEnv("SENTINEL_CHAIN_NAME", "Flare");
    const c = sentinelChain();
    expect(c.chainId).toBe(14);
    expect(c.name).toBe("Flare");
    expect(c.explorer).toContain("flare");
    expect(c.explorer).not.toContain("mantlescan");
  });

  it("builds attestation tx links on the configured chain", () => {
    const hash = "0x" + "ab".repeat(32);
    vi.stubEnv("SENTINEL_CHAIN_ID", "14");
    expect(sentinelTxUrl(hash)).toBe(`https://flare-explorer.flare.network/tx/${hash}`);
    vi.stubEnv("SENTINEL_CHAIN_ID", "5003");
    expect(sentinelTxUrl(hash)).toBe(`https://sepolia.mantlescan.xyz/tx/${hash}`);
  });

  it("returns null rather than guessing when the chain has no known explorer", () => {
    vi.stubEnv("SENTINEL_CHAIN_ID", "999999");
    expect(sentinelChain().explorer).toBeNull();
    expect(sentinelTxUrl("0xdead")).toBeNull();
    expect(explorerBase(999999)).toBeNull();
  });

  it("links a watched OFT to ITS chain's explorer, including Flare", () => {
    const addr = "0x560C03079FE54Fa53e15b48C615b1ef76D6DF621";
    expect(oftExplorerUrl(14, addr)).toBe(`https://flare-explorer.flare.network/address/${addr}`);
    expect(oftExplorerUrl(1, addr)).toBe(`https://etherscan.io/address/${addr}`);
    expect(oftExplorerUrl(5000, addr)).toBe(`https://mantlescan.xyz/address/${addr}`);
    // Unmapped chain: blockscan resolves by address across chains, so it is a
    // correct page rather than a wrong one.
    expect(oftExplorerUrl(999999, addr)).toBe(`https://blockscan.com/address/${addr}`);
  });
});

// ── No user-facing value may come from a random source ──────────────────────
// agentTick() invented a ticker, a corridor and a 22-53ms latency, printed them
// beside REAL third-party token names, and fed the random numbers into an
// "N ms avg" statistic. A product whose claim is "this was measured" must not
// ship a panel that makes numbers up.

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(here, "..", "..", "..", "frontend", "src");
const read = (p: string) => readFileSync(join(FRONTEND, p), "utf8");

describe("no fabricated telemetry in the UI", () => {
  const files = [
    "components/SentinelDashboard.tsx",
    "components/TokenOverlay.tsx",
    "components/FlareRailStatus.tsx",
  ];

  // FlowAnimation.tsx is deliberately NOT in this list. It is a decorative
  // canvas on the landing page: moving dots between chain badges, no figures, no
  // token names, no claim of live traffic. It is flagged in task-16-report.md as
  // a judgement call rather than silently exempted here.
  it.each(files)("%s contains no random source", (f) => {
    const src = read(f);
    // Comments explaining the removal are allowed; executable calls are not.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/crypto\.getRandomValues/);
  });

  it("the dashboard no longer fabricates latency or a cycle countdown", () => {
    const src = read("components/SentinelDashboard.tsx");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/agentTick/);
    expect(code).not.toMatch(/ms avg/);
    expect(code).not.toMatch(/Next cycle/);
    expect(code).not.toMatch(/setAvgMs/);
  });

  it("no component hardcodes an explorer base", () => {
    for (const f of [...files, "App.tsx"]) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/https:\/\/[a-z.]*mantlescan\.xyz/);
      expect(code, f).not.toMatch(/https:\/\/flarescan\.com/);
    }
  });
});
