// Env-driven scoping for single-chain instances (Flare hackathon build).
// All env reads happen at CALL time so tests and long-lived processes see
// current values; no module-load capture.

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseWatchChains(raw: string | undefined): Set<string> | null {
  if (!raw || !raw.trim()) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function chainAllowed(chainKey: string): boolean {
  const allow = parseWatchChains(process.env.WATCH_CHAINS);
  return allow === null || allow.has(chainKey.toLowerCase());
}

export interface PinnedAsset {
  chainKey: string;
  address: string;
  ticker: string;
}

/** `chainKey:address:ticker` list parser, shared by WATCH_PINNED and ATTEST_PINNED.
 *  `label` only names the offending variable in the skip warning — one grammar,
 *  one parser, so the two lists can never drift apart in how they read. */
export function parsePins(raw: string | undefined, label = "WATCH_PINNED"): PinnedAsset[] {
  if (!raw) return [];
  const pins: PinnedAsset[] = [];
  for (const entry of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [chainKey, address, ticker] = entry.split(":").map((s) => s.trim());
    if (!chainKey || !address || !ADDR_RE.test(address)) {
      console.warn(`[watch-scope] ${label} entry malformed, skipped: "${entry}"`);
      continue;
    }
    pins.push({ chainKey: chainKey.toLowerCase(), address, ticker: ticker || "PINNED" });
  }
  return pins;
}

/** WATCH_PINNED — what this instance READS and scores. */
export function pinnedAssets(): PinnedAsset[] {
  return parsePins(process.env.WATCH_PINNED);
}

// ── Attest scope ─────────────────────────────────────────────────────────────
// Watching a token is a read. Signing a verdict about it into a permanent
// registry is a claim about someone else's contract. They are different acts, so
// they have different lists: WATCH_PINNED is read, ATTEST_PINNED is signed.
//
// They were the same list until 2026-08-05. Under the old `pinned` mode the
// attest gate matched any WATCH_PINNED entry, so widening the watch list to
// cover the Flare OFT fleet silently made three live third-party tokens
// attestable — measured, before any transaction, as "the authorised poll would
// sign FLR and DINERO". Widening what you look at must never widen what you
// sign. That is why these are two variables and not one.

export type AttestScopeMode = "all" | "allowlist" | "invalid";

/**
 * How ATTEST_SCOPE is to be interpreted. Read at CALL time.
 *
 *  - unset / empty → "all": attest everything watched. This is PRODUCTION's
 *    behaviour and must not change. Empty is treated as unset because an env
 *    file's empty slot means "not configured", the same way parseWatchChains
 *    reads an empty WATCH_CHAINS as "no restriction".
 *  - "allowlist"   → only the assets in ATTEST_PINNED.
 *  - anything else → "invalid", which callers MUST treat as attest-NOTHING.
 *
 * That last case is deliberate and is the reason this returns a mode rather than
 * a boolean. The predecessor mode `pinned` was removed in this change; a stale
 * `ATTEST_SCOPE=pinned` left in an env file must not silently degrade to "attest
 * everything", which is what an unrecognised-means-unset reading would do. An
 * operator who set the variable at all was trying to RESTRICT something; when we
 * cannot tell what, the only safe reading is "nothing".
 */
export function attestScopeMode(): AttestScopeMode {
  const raw = process.env.ATTEST_SCOPE;
  if (raw === undefined || raw.trim() === "") return "all";
  if (raw.trim() === "allowlist") return "allowlist";
  return "invalid";
}

/**
 * ATTEST_PINNED — what may be SIGNED on-chain. Never falls back to WATCH_PINNED
 * and never falls back to "everything": unset, empty and unparseable all yield
 * an empty list, which the caller turns into "attest nothing".
 *
 * Requirement 3 — an asset may be attested only if it is also watched. The live
 * watch list is async (Dune) and can be degraded, so gating a safety check on it
 * would make the gate fail open exactly when the fleet is least readable. What IS
 * statically knowable is whether this instance can read the asset at all, and
 * there are TWO ways it can:
 *
 *   1. the asset's chain is in WATCH_CHAINS, or
 *   2. the asset is itself in WATCH_PINNED.
 *
 * Case 2 is not a technicality. sentinel.ts:122 states that WATCH_PINNED
 * "bypasses chainAllowed" on purpose, so a pinned asset on an off-list chain IS
 * polled and scored. This filter used to test case 1 only and reject everything
 * else with "this instance never reads it" — a sentence that became false the
 * moment pins started bypassing the chain check. The effect was the bad kind of
 * wrong: the asset was watched and scored, could never be attested, and the
 * error blamed a chain scope that was not the reason.
 *
 * Entries failing BOTH tests are FILTERED OUT (never attestable) and logged at
 * error level — filtered rather than thrown, because attestInScope is called
 * from inside the verdict pipeline's try/catch, where a throw would be swallowed
 * into a generic "attest failed" and lose the reason. Dropping the entry fails
 * closed AND keeps the diagnosis.
 */
export function attestPinnedAssets(): PinnedAsset[] {
  // Same identity key sentinel.ts dedupes pins by, lowercased so a checksummed
  // ATTEST_PINNED entry still matches its lowercase WATCH_PINNED twin.
  const watchPinned = new Set(
    pinnedAssets().map((p) => `${p.chainKey}:${p.address.toLowerCase()}`),
  );
  return parsePins(process.env.ATTEST_PINNED, "ATTEST_PINNED").filter((p) => {
    if (chainAllowed(p.chainKey)) return true;
    if (watchPinned.has(`${p.chainKey}:${p.address.toLowerCase()}`)) return true;
    console.error(
      `[watch-scope] ATTEST_PINNED entry "${p.chainKey}:${p.address}:${p.ticker}" is on a chain outside ` +
        `WATCH_CHAINS="${process.env.WATCH_CHAINS ?? ""}" and is not in WATCH_PINNED either, so this ` +
        `instance never reads it and it is NOT attestable. Fix the config: an asset may only be ` +
        `attested if it is also watched — add its chain to WATCH_CHAINS, or add the asset to WATCH_PINNED.`,
    );
    return false;
  });
}
