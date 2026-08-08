import type { SentinelStatus } from "./api.ts";

/**
 * Where on-chain links point.
 *
 * Every component used to carry its own `const SEPOLIA = "https://sepolia.mantlescan.xyz"`.
 * That is correct for exactly one deployment. On the Flare instance a real
 * attestation hash rendered a sepolia.mantlescan.xyz URL that 404s — a proof
 * link that proves nothing, which is worse than showing no link, because a
 * judge who clicks it concludes the proof does not exist.
 *
 * The backend already knows the answer: it signs against SENTINEL_CHAIN_ID and
 * resolves explorers from the chain registry. So it serves them on /status and
 * this module just holds what it said.
 *
 * Every accessor returns `string | null`. Null means "we have no explorer we can
 * stand behind for this chain" and callers must render the bare hash or address
 * instead of a link. Nothing here ever falls back to a default chain.
 */

let sentinelExplorer: string | null = null;
let byChainId: Record<number, string> = {};
let namesByChainId: Record<number, string> = {};

/** Called whenever /status resolves. Cheap and idempotent. */
export function setChainConfig(status: SentinelStatus | null): void {
  sentinelExplorer = status?.chain?.explorer ?? null;
  const next: Record<number, string> = {};
  const names: Record<number, string> = {};
  for (const c of status?.chains ?? []) {
    if (c.explorer) next[c.chainId] = c.explorer;
    if (c.name) names[c.chainId] = c.name;
  }
  byChainId = next;
  namesByChainId = names;
}

/** Display name for a watched chain, or null when unknown. Labels that name a
 *  chain must use this — "Contract on Mantle" was hardcoded, and read as a
 *  factual claim about a Flare contract. */
export function chainNameFor(chainId: number | null | undefined): string | null {
  if (chainId == null) return null;
  return namesByChainId[chainId] ?? null;
}

/** Transaction link on the chain this instance's contracts live on — where
 *  attestation and AlertBus transactions land. */
export function txUrl(txHash: string | null | undefined): string | null {
  if (!txHash || !sentinelExplorer) return null;
  return `${sentinelExplorer}/tx/${txHash}`;
}

/** Address link on the chain this instance's contracts live on (registry, AlertBus). */
export function contractUrl(address: string | null | undefined): string | null {
  if (!address || !sentinelExplorer) return null;
  return `${sentinelExplorer}/address/${address}`;
}

/** Address link on the WATCHED chain — the OFT lives there, which is not
 *  necessarily where our contracts live. */
export function oftUrl(chainId: number | null | undefined, address: string | null | undefined): string | null {
  if (!address || chainId == null) return null;
  const base = byChainId[chainId];
  return base ? `${base}/address/${address}` : null;
}
