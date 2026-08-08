import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ChainRef, ChainRpc } from "../types.js";

// The chain registry is a COMMITTED build artifact (public data only) that ships
// with the code — unlike custody declarations, which are operator input on the
// runtime volume. It is therefore resolved relative to the module (backend root)
// and NOT under DATA_DIR. A missing or malformed file is a build error: fail
// loudly at first read rather than silently monitoring nothing.
const REGISTRY_BASENAME = "chain-registry.json";

interface RawRegistry {
  generatedAt?: string;
  source?: string;
  chains: Record<string, ChainRef>;
}

/** Normalize a provider label so quorum counting can't be fooled by cosmetic
 *  variants: lowercase, strip an `other-` prefix, and collapse every thirdweb
 *  proxy variant (`{chainId}.rpc.thirdweb.com` is one generic keyless proxy).
 *  Must match the generator's normalization exactly. */
export function normalizeProvider(provider: string): string {
  let p = (provider ?? "").toLowerCase().trim();
  if (p.startsWith("other-")) p = p.slice("other-".length);
  if (p.includes("thirdweb")) return "thirdweb";
  return p;
}

/** Distinct normalized providers backing verified endpoints. */
export function distinctProviderCount(rpcs: ChainRpc[]): number {
  return new Set(rpcs.map((r) => normalizeProvider(r.provider))).size;
}

/** Quorum invariant: a chain is monitorable only with ≥2 RPCs from ≥2 distinct
 *  providers. Enforced here (not just trusted from the file) so a mislabeled
 *  registry can never bypass the multi-RPC quorum. */
export function meetsQuorum(rpcs: ChainRpc[]): boolean {
  return rpcs.length >= 2 && distinctProviderCount(rpcs) >= 2;
}

export function registryFile(): string {
  if (process.env.CHAIN_REGISTRY_PATH) return resolve(process.env.CHAIN_REGISTRY_PATH);
  // <backend>/chain-registry.json — two levels up from src/services/.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", REGISTRY_BASENAME);
}

// Cached per process. Keyed by the resolved file path so a test that swaps
// CHAIN_REGISTRY_PATH gets a fresh load instead of a stale cache.
let cache: { path: string; byChainId: Map<number, ChainRef>; byKey: Map<string, ChainRef> } | null = null;

/** Keyed-endpoint overrides. When an env key is set, prepend that provider's
 *  keyed endpoint for the networks the key has been verified against — keyed
 *  endpoints are far more reliable than anonymous public ones, which is the
 *  root cause of per-corridor read flakes. Keys live in env ONLY: the committed
 *  registry stays public data, and rpc URLs are never serialized via the API.
 *  Order: alchemy becomes the primary read client, keyed drpc the first
 *  quorum/fallback peer, public endpoints remain as deeper fallbacks. */
interface KeyedProvider {
  envVar: string;
  provider: string;
  url: (network: string, key: string) => string;
  /** chainId → provider-specific network slug; only verified networks belong here. */
  networks: Record<number, string>;
}

const KEYED_PROVIDERS: KeyedProvider[] = [
  {
    envVar: "ALCHEMY_API_KEY",
    provider: "alchemy",
    url: (network, key) => `https://${network}.g.alchemy.com/v2/${key}`,
    networks: { 1: "eth-mainnet", 8453: "base-mainnet", 5000: "mantle-mainnet" },
  },
  {
    envVar: "DRPC_API_KEY",
    provider: "drpc",
    url: (network, key) => `https://lb.drpc.live/${network}/${key}`,
    networks: { 1: "ethereum", 8453: "base", 5000: "mantle" },
  },
];

function applyKeyedProviderOverrides(ref: ChainRef): ChainRef {
  const existing = ref.rpcs ?? [];
  const keyed: ChainRpc[] = [];
  for (const p of KEYED_PROVIDERS) {
    const key = process.env[p.envVar];
    const network = p.networks[ref.chainId];
    if (!key || !network) continue;
    const url = p.url(network, key);
    if (existing.some((r) => r.url === url)) continue;
    keyed.push({ url, provider: p.provider });
  }
  if (keyed.length === 0) return ref;
  return { ...ref, rpcs: [...keyed, ...existing] };
}

function load(): { byChainId: Map<number, ChainRef>; byKey: Map<string, ChainRef> } {
  const path = registryFile();
  if (cache && cache.path === path) return cache;

  let raw: RawRegistry;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as RawRegistry;
  } catch (e: any) {
    throw new Error(`chain-registry: cannot read/parse ${path}: ${e.message}`);
  }
  if (!raw || typeof raw !== "object" || !raw.chains || typeof raw.chains !== "object") {
    throw new Error(`chain-registry: malformed registry at ${path} (missing "chains")`);
  }

  const byChainId = new Map<number, ChainRef>();
  const byKey = new Map<string, ChainRef>();
  for (const [chainKey, entry] of Object.entries(raw.chains)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`chain-registry: malformed entry for "${chainKey}"`);
    }
    // Enforce the quorum invariant at load time: eligible only if the file says
    // so AND the endpoints actually satisfy ≥2-distinct-provider quorum. This
    // makes it impossible for a mislabeled registry to bypass invariant 3.
    // Quorum is measured on the keyed-augmented list: a keyed endpoint is a
    // real distinct provider, so it legitimately restores quorum.
    const withKeyed = applyKeyedProviderOverrides(entry);
    const eligible = entry.eligible && meetsQuorum(withKeyed.rpcs ?? []);
    // Capability flag, not an eligibility input: a chain without Multicall3 is
    // still fully monitorable, it just reads unbatched. The registry is a build
    // artifact, so coerce strictly — absent/stale/non-boolean must degrade to
    // false (individual calls), never to true (batching against no contract).
    const multicall3 = (entry as { multicall3?: unknown }).multicall3 === true;
    const ref = { ...withKeyed, eligible, multicall3 };
    byChainId.set(ref.chainId, ref);
    byKey.set(ref.chainKey, ref);
  }
  cache = { path, byChainId, byKey };
  return cache;
}

/** Force a reload on the next lookup — for tests that swap the registry file. */
export function _resetChainRegistryCache(): void {
  cache = null;
}

export function getChainRef(chainId: number): ChainRef | null {
  return load().byChainId.get(chainId) ?? null;
}

export function getChainRefByKey(chainKey: string): ChainRef | null {
  return load().byKey.get(chainKey) ?? null;
}

export function listEligibleChains(): ChainRef[] {
  return [...load().byKey.values()].filter((c) => c.eligible);
}

// Display names live next to the registry so that adding a chain names it
// everywhere at once — the frontend renders /status `chains` verbatim and has
// no chain-name table of its own. Override only where capitalizing the
// chainKey isn't the accepted spelling.
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  bsc: "BNB Chain",
  opbnb: "opBNB",
  okx: "OKX",
  xdc: "XDC",
  xlayer: "X Layer",
  zksync: "zkSync",
  zkevm: "Polygon zkEVM",
  coredao: "Core DAO",
  dfk: "DFK Chain",
  megaeth: "MegaETH",
  injectiveevm: "Injective EVM",
  cronosevm: "Cronos",
  cronoszkevm: "Cronos zkEVM",
};

export function chainDisplayName(chainKey: string | null | undefined): string {
  if (!chainKey) return "Unknown";
  return DISPLAY_NAME_OVERRIDES[chainKey] ?? chainKey.charAt(0).toUpperCase() + chainKey.slice(1);
}

// ── Block explorers ──────────────────────────────────────────────────────────
// One table, because the alternative is what we had: the same
// "https://sepolia.mantlescan.xyz" literal copied into report.ts, alerts.ts and
// two React components. On the Flare instance every one of those produced a link
// to the wrong chain, and an attestation hash that 404s. A judge who clicks a
// proof link and lands on nothing has learned something worse than if we had
// shown no link at all.
//
// Unmapped chains return null rather than a guess. Callers decide whether to
// render a plain address or nothing — never a link we cannot stand behind.
const CHAIN_EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  14: "https://flare-explorer.flare.network", // Blockscout: the Flare explorer where
                                              // this build's contracts verified (Task 6)
  8453: "https://basescan.org",
  5000: "https://mantlescan.xyz",
  5003: "https://sepolia.mantlescan.xyz",
};

/** Explorer base for a chain, or null when we have no verified one. */
export function explorerBase(chainId: number): string | null {
  return CHAIN_EXPLORERS[chainId] ?? null;
}

// Native currency per chain. Used only to build the viem chain object, where it
// feeds unit formatting in error text — it never affects a transaction. It was
// hardcoded to `{ name: "Mantle", symbol: "MNT" }` in both attestor.ts and
// alerts.ts, so every Flare error message quoted amounts in MNT.
const DEFAULT_RPC: Record<number, string> = {
  14: "https://flare-api.flare.network/ext/C/rpc",
  5003: "https://rpc.sepolia.mantle.xyz",
};

const NATIVE_CURRENCY: Record<number, { name: string; symbol: string }> = {
  1: { name: "Ether", symbol: "ETH" },
  14: { name: "Flare", symbol: "FLR" },
  8453: { name: "Ether", symbol: "ETH" },
  5000: { name: "Mantle", symbol: "MNT" },
  5003: { name: "Mantle", symbol: "MNT" },
};

export interface SentinelChain {
  chainId: number;
  name: string;
  /** Fallback RPC when SENTINEL_RPC is unset. Lives here so the identity modules
   *  (attestor, alerts) hold no chain literal of their own. */
  defaultRpc: string;
  /** null when unmapped — callers must not invent a link. */
  explorer: string | null;
  /** Display-only (viem error formatting); never used to compute a value. */
  nativeCurrency: { name: string; symbol: string; decimals: 18 };
}

/** The chain this instance's AuditRegistry lives on, i.e. where attestation and
 *  AlertBus transactions land. Read at CALL time from the same env the attestor
 *  signs against (SENTINEL_CHAIN_ID / SENTINEL_CHAIN_NAME), so the link and the
 *  transaction can never disagree about which chain they mean. Defaults match
 *  attestor.ts so production behaviour is unchanged. */
export function sentinelChain(): SentinelChain {
  const chainId = Number(process.env.SENTINEL_CHAIN_ID ?? 5003);
  const fromRegistry = getChainRef(chainId)?.chainKey;
  return {
    chainId,
    // chainDisplayName never returns null (it answers "Unknown"), so it must only
    // be consulted when the registry actually knows the chain — otherwise the
    // production default silently became "Unknown" instead of "Mantle Sepolia".
    // 5003 is a testnet and is deliberately not in the registry.
    name: process.env.SENTINEL_CHAIN_NAME ?? (fromRegistry ? chainDisplayName(fromRegistry) : "Mantle Sepolia"),
    explorer: explorerBase(chainId),
    // Production default preserved exactly: 5003 -> Mantle Sepolia.
    defaultRpc: DEFAULT_RPC[chainId] ?? DEFAULT_RPC[5003],
    // Unmapped chains fall back to ETH rather than to the previous hardcoded
    // MNT. Still a guess, but a display-only one on a path that cannot move
    // funds; the value is stated here so it is visible rather than buried.
    nativeCurrency: { ...(NATIVE_CURRENCY[chainId] ?? { name: "Ether", symbol: "ETH" }), decimals: 18 },
  };
}
