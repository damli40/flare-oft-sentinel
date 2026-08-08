/**
 * build-chain-registry.ts — regenerate backend/chain-registry.json.
 *
 * Pipeline (Task 1 of the multi-chain scaling design):
 *   1. Load the pre-built RPC sweep (RPC_SWEEP_PATH, 161 V2-EVM-mainnet chains,
 *      430 keyless endpoints, produced 2026-07-08). The sweep is the frozen
 *      candidate set — this script re-verifies and prunes, it never invents new
 *      endpoints (adding one is a curated, human-reviewed edit to the sweep).
 *   2. Fetch the LZ deployments API and reuse loadEidMap's filtering (EIDs
 *      30000–39999, EVM 0x endpoints, chainType === "evm") to confirm each sweep
 *      chain is still a V2 EVM mainnet chain and to reconcile its nativeChainId.
 *      Non-EVM chains are skipped silently. Deployments fetch failure degrades to
 *      the sweep's own eid/chainId (logged).
 *   3. Live-verify EVERY rpc with an eth_chainId call (8 s timeout); keep only
 *      endpoints whose result equals the chain's chainId. Drop the rest.
 *   4. Apply the quorum rule (≥2 rpcs from ≥2 DISTINCT normalized providers).
 *   5. Fetch the Etherscan v2 chainlist and mark etherscanFree by chainId match.
 *   6. Write chain-registry.json sorted by chainKey; print a summary table.
 *
 * TWO VERIFIED GOTCHAS baked in (see design §7 Task 1):
 *   (a) Send a browser User-Agent on every verification call — drpc.org /
 *       publicnode.com / ankr.com / blastapi.io return 403 to default library
 *       UAs, producing ~50 false "dead endpoint" negatives.
 *   (b) Normalize provider labels BEFORE the distinct-provider count (lowercase,
 *       strip `other-`, collapse thirdweb variants). Counting `thirdweb` and
 *       `other-thirdweb` as distinct would falsely satisfy the quorum rule.
 *
 * Run: npx tsx src/scripts/build-chain-registry.ts
 * Idempotent: two back-to-back runs produce identical output modulo generatedAt
 * (endpoints rot between runs; a drop of a few is expected, a cliff is a bug —
 * usually the missing UA header).
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { normalizeProvider, meetsQuorum } from "../services/chain-registry.js";
import { MULTICALL3_ADDRESS, mapLimit } from "../services/multicall.js";
import type { ChainRef, ChainRpc } from "../types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (compatible; oft-sentinel-registry/1.0)";
const VERIFY_TIMEOUT_MS = 8_000;
// Keep concurrency modest: shared public proxies (thirdweb, tatum, …) throttle
// concurrent bursts from one IP, which produced ~11 false eligibility flips at
// concurrency 24. 10 in-flight + transient-retry keeps them from rate-limiting.
const VERIFY_CONCURRENCY = 10;
const VERIFY_RETRIES = 3; // transient failures only (never a chainId mismatch)
// The capability probe retries ONCE per endpoint, not VERIFY_RETRIES times —
// see probeMulticall3 for why that asymmetry is deliberate.
const PROBE_RETRIES = 1;
const PROBE_RETRY_DELAY_MS = 250;

const DEPLOYMENTS_URL = "https://metadata.layerzero-api.com/v1/metadata/deployments";
const CHAINLIST_URL = "https://api.etherscan.io/v2/chainlist";

function sweepPath(): string {
  if (process.env.RPC_SWEEP_PATH) return resolve(process.env.RPC_SWEEP_PATH);
  // backend/src/scripts → repo root → docs/superpowers/specs/…
  return join(HERE, "..", "..", "..", "docs", "superpowers", "specs", "2026-07-08-chain-rpc-sweep.json");
}

function outputPath(): string {
  if (process.env.CHAIN_REGISTRY_PATH) return resolve(process.env.CHAIN_REGISTRY_PATH);
  return join(HERE, "..", "..", "chain-registry.json");
}

interface SweepChain {
  chainKey: string;
  eid: number;
  chainId: number;
  eligible?: boolean;
  rpcs: ChainRpc[];
  note?: string;
}
interface Sweep {
  chains: Record<string, SweepChain>;
}

interface DeployInfo { eid: number; nativeChainId: number | null; chainType: string | null }

/** chainKey → deployments metadata for V2 EVM mainnet chains (reuses loadEidMap's
 *  EID/endpoint filtering, plus chainType/nativeChainId from chainDetails). */
async function loadDeployments(): Promise<Record<string, DeployInfo> | null> {
  try {
    const res = await fetch(DEPLOYMENTS_URL, { headers: { "user-agent": UA } });
    const raw = (await res.json()) as Record<string, any>;
    const byKey: Record<string, DeployInfo> = {};
    for (const [, val] of Object.entries(raw)) {
      const chainType: string | null = val?.chainDetails?.chainType ?? null;
      const nativeChainId: number | null =
        typeof val?.chainDetails?.nativeChainId === "number" ? val.chainDetails.nativeChainId : null;
      for (const dep of val?.deployments ?? []) {
        if (dep.version !== 2) continue;
        const eid = Number(dep.eid);
        if (eid < 30000 || eid >= 40000) continue; // exclude sandboxes/legacy
        const ep: string = dep.endpointV2?.address ?? dep.endpoint?.address ?? "";
        if (!ep.startsWith("0x")) continue; // non-EVM endpoint
        const chainKey = dep.chainKey as string;
        if (!chainKey) continue;
        byKey[chainKey] = { eid, nativeChainId, chainType };
      }
    }
    return byKey;
  } catch (e: any) {
    console.warn(`[build-registry] deployments API unavailable (${e.message}); using sweep eid/chainId as-is`);
    return null;
  }
}

/** Set of chainIds that Etherscan v2 serves (proxy for "etherscanFree").
 *  On an unexpected shape, returns null → degrade to true for listed chains. */
async function loadEtherscanChainIds(): Promise<Set<number> | null> {
  try {
    const res = await fetch(CHAINLIST_URL, { headers: { "user-agent": UA } });
    const json = (await res.json()) as { result?: { chainid?: string | number; status?: number }[] };
    if (!Array.isArray(json.result)) return null;
    const ids = new Set<number>();
    for (const row of json.result) {
      // status 0 = offline; anything else (1 ok / 2 degraded) is usable.
      if (Number(row.status) === 0) continue;
      const id = Number(row.chainid);
      if (Number.isFinite(id)) ids.add(id);
    }
    return ids;
  } catch (e: any) {
    console.warn(`[build-registry] chainlist unavailable (${e.message}); etherscanFree=false for all`);
    return null;
  }
}

type Probe = "ok" | "mismatch" | "transient";

/** One eth_chainId probe. "mismatch" = a valid response with the WRONG chainId
 *  (permanent — never retried); "transient" = timeout / non-2xx / network /
 *  malformed (retryable — public proxies 429 under burst). */
async function probeRpc(url: string, expectedChainId: number): Promise<Probe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return "transient";
    const json = (await res.json()) as { result?: unknown };
    if (typeof json.result !== "string" || !json.result.startsWith("0x")) return "transient";
    return Number(BigInt(json.result)) === expectedChainId ? "ok" : "mismatch";
  } catch {
    return "transient";
  } finally {
    clearTimeout(timer);
  }
}

async function verifyRpc(url: string, expectedChainId: number): Promise<boolean> {
  for (let attempt = 0; attempt <= VERIFY_RETRIES; attempt++) {
    const r = await probeRpc(url, expectedChainId);
    if (r === "ok") return true;
    if (r === "mismatch") return false; // deterministic wrong chain — do not retry
    if (attempt < VERIFY_RETRIES) {
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1) + Math.floor(Math.random() * 200)));
    }
  }
  return false;
}

/** One eth_getCode against the canonical Multicall3 address.
 *  `true`/`false` are DEFINITIVE answers from the chain; `null` means the
 *  endpoint could not answer (timeout, non-2xx, JSON-RPC error, malformed body)
 *  and says nothing about the chain — the caller must not read it as either. */
async function probeMulticall3Once(rpcUrl: string): Promise<boolean | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [MULTICALL3_ADDRESS, "latest"],
      }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: unknown };
    // A JSON-RPC error object leaves `result` absent — indistinguishable here
    // from a malformed body, and neither is an answer about the chain.
    if (typeof j?.result !== "string" || !j.result.startsWith("0x")) return null;
    return j.result.length > 2;
  } catch {
    return null;
  }
}

/** Is Multicall3 deployed at the canonical address on this chain?
 *  Walks the chain's live-verified endpoints and takes the FIRST DEFINITIVE
 *  answer. Consulting only rpcs[0] would let one flaky proxy decide: sei's
 *  drpc endpoint returns "Temporary internal error" while sei-apis.com returns
 *  the bytecode, which silently costs the chain its batching and makes the flag
 *  flap between runs. Exhausting every endpoint without a definitive answer
 *  yields false — an unprobed chain reads unbatched, which is always safe.
 *
 *  RETRY BUDGET (deliberate asymmetry with verifyRpc, which retries 3x): each
 *  endpoint gets ONE retry before we fall through to the next. Multi-endpoint
 *  chains already have the fall-through as their redundancy, so more retries
 *  would mostly buy latency; the one retry exists for the chain with a SINGLE
 *  verified endpoint, which otherwise sits one 429 away from a spurious false.
 *  Under-retrying here is the safe direction — it can only cost a chain its
 *  batching (an unbatched read is still a correct read), never mark a chain
 *  batchable that is not. So the budget is capped rather than exhaustive. */
async function probeMulticall3(rpcUrls: string[]): Promise<boolean> {
  for (const url of rpcUrls) {
    for (let attempt = 0; attempt <= PROBE_RETRIES; attempt++) {
      const answer = await probeMulticall3Once(url);
      if (answer !== null) return answer;
      if (attempt < PROBE_RETRIES) {
        await new Promise((res) =>
          setTimeout(res, PROBE_RETRY_DELAY_MS * (attempt + 1) + Math.floor(Math.random() * 150)),
        );
      }
    }
  }
  return false;
}

/** Test-only exports (`_` prefix, same convention as _resetChainRegistryCache).
 *  Exported so the null-vs-false fail-safe property can be unit-tested with a
 *  stubbed fetch — it is the whole safety guarantee of the flag and the earlier
 *  version of this probe got it wrong. Not part of the script's public surface. */
export { probeMulticall3Once as _probeMulticall3Once, probeMulticall3 as _probeMulticall3 };

async function main(): Promise<void> {
  const sweep = JSON.parse(readFileSync(sweepPath(), "utf8")) as Sweep;
  const sweepChains = Object.values(sweep.chains);
  const totalEndpoints = sweepChains.reduce((n, c) => n + (c.rpcs?.length ?? 0), 0);
  console.log(`[build-registry] sweep: ${sweepChains.length} chains, ${totalEndpoints} candidate endpoints`);

  const [deployments, etherscanIds] = await Promise.all([loadDeployments(), loadEtherscanChainIds()]);

  // Flatten every (chainKey, rpc) pair and verify with bounded concurrency.
  type Pair = { chainKey: string; chainId: number; rpc: ChainRpc };
  const skippedNonEvm: string[] = [];
  const kept: SweepChain[] = [];
  for (const c of sweepChains) {
    const dep = deployments?.[c.chainKey];
    if (dep && dep.chainType && dep.chainType !== "evm") {
      skippedNonEvm.push(c.chainKey); // non-EVM — skip silently (design non-goal)
      continue;
    }
    // Reconcile chainId with the deployments API (authoritative) when available.
    const chainId = dep?.nativeChainId ?? c.chainId;
    const eid = dep?.eid ?? c.eid;
    kept.push({ ...c, chainId, eid });
  }

  const pairs: Pair[] = [];
  for (const c of kept) for (const rpc of c.rpcs ?? []) pairs.push({ chainKey: c.chainKey, chainId: c.chainId, rpc });
  const results = await mapLimit(pairs, VERIFY_CONCURRENCY, async (p) => ({ p, ok: await verifyRpc(p.rpc.url, p.chainId) }));

  const passedByChain = new Map<string, ChainRpc[]>();
  let passedEndpoints = 0;
  for (const { p, ok } of results) {
    if (!ok) continue;
    passedEndpoints++;
    if (!passedByChain.has(p.chainKey)) passedByChain.set(p.chainKey, []);
    passedByChain.get(p.chainKey)!.push(p.rpc);
  }

  // Capability probe: eth_getCode per chain over its live-verified endpoints.
  // Chains with no verified endpoint are simply left false.
  const probeTargets = [...passedByChain.entries()].filter(([, rpcs]) => rpcs.length > 0);
  const probeResults = await mapLimit(probeTargets, VERIFY_CONCURRENCY, async ([chainKey, rpcs]) => ({
    chainKey,
    multicall3: await probeMulticall3(rpcs.map((r) => r.url)),
  }));
  const multicall3ByChain = new Map(probeResults.map((r) => [r.chainKey, r.multicall3]));

  // Build the registry, sorted by chainKey.
  const chains: Record<string, ChainRef & { note: string }> = {};
  let eligibleCount = 0;
  const changedEligibility: string[] = [];
  for (const c of kept.sort((a, b) => a.chainKey.localeCompare(b.chainKey))) {
    const rpcs = passedByChain.get(c.chainKey) ?? [];
    const eligible = meetsQuorum(rpcs);
    if (eligible) eligibleCount++;
    if (typeof c.eligible === "boolean" && c.eligible !== eligible) changedEligibility.push(c.chainKey);
    const etherscanFree = etherscanIds ? etherscanIds.has(c.chainId) : false;
    let note = c.note ?? "";
    if (!eligible && rpcs.length === 0) {
      note = note || "No keyless RPC endpoint verified live.";
    } else if (!eligible) {
      note = note || `Only ${new Set(rpcs.map((r) => normalizeProvider(r.provider))).size} distinct provider(s) verified live — needs ≥2 for quorum.`;
    }
    chains[c.chainKey] = {
      chainKey: c.chainKey,
      eid: c.eid,
      chainId: c.chainId,
      eligible,
      etherscanFree,
      multicall3: multicall3ByChain.get(c.chainKey) === true,
      rpcs: rpcs.map((r) => ({ url: r.url, provider: r.provider })),
      note,
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: `${DEPLOYMENTS_URL} + verified RPC sweep (${sweepPath()})`,
    chains,
  };
  writeFileSync(outputPath(), JSON.stringify(out, null, 2) + "\n");

  const ineligibleCount = Object.keys(chains).length - eligibleCount;
  console.log("─".repeat(60));
  console.log(`  chains written    : ${Object.keys(chains).length}`);
  console.log(`  eligible          : ${eligibleCount}`);
  console.log(`  ineligible        : ${ineligibleCount}`);
  console.log(`  endpoints verified: ${passedEndpoints} / ${totalEndpoints} (dropped ${totalEndpoints - passedEndpoints})`);
  console.log(`  skipped non-EVM   : ${skippedNonEvm.length}${skippedNonEvm.length ? " (" + skippedNonEvm.join(", ") + ")" : ""}`);
  console.log(`  etherscanFree     : ${Object.values(chains).filter((c) => c.etherscanFree).length}`);
  console.log(`  multicall3        : ${Object.values(chains).filter((c) => c.multicall3).length}`);
  if (changedEligibility.length)
    console.log(`  eligibility changed vs sweep: ${changedEligibility.join(", ")}`);
  console.log(`  written to        : ${outputPath()}`);
  console.log("─".repeat(60));
}

// Run only when invoked as the entry point. Importing this module (the probe
// unit tests do) must not kick off a 400-endpoint live sweep.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error("[build-registry] FAILED:", e);
    process.exit(1);
  });
}
