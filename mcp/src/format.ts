// Distillers: the prod /status payload is ~660KB; tool results must carry only
// what an agent needs to decide its next call.

export type RiskLevel = "PASS" | "AT_RISK" | "CRITICAL";
export type RowRisk = RiskLevel | "UNASSESSED";

export interface StatusPayload {
  rulesVersion: string;
  chains: Array<{ chainId: number; name: string }>;
  watched: WatchedEntry[];
  /** The chain this instance's contracts live on, served by /status. Explorer
   *  links are built from it instead of a constant, because a constant is right
   *  for one deployment and 404s on every other. Null explorer means the backend
   *  has no verified explorer for that chain, so we render no link at all. */
  chain?: { chainId: number; name: string; explorer: string | null };
}

/** Attestation tx link, or null. Never guess a base: a proof link that lands on
 *  nothing reads as "the proof does not exist". */
export function explorerTxUrl(status: StatusPayload, txHash?: string | null): string | null {
  const base = status.chain?.explorer;
  return base && txHash ? `${base}/tx/${txHash}` : null;
}

export interface DvnCorridor {
  corridor: string;
  eid: number;
  uln: {
    requiredCount: number;
    optionalThreshold: number;
    effectiveCount: number;
    requiredDVNs: string[];
    optionalDVNs: string[];
    names?: Record<string, string>;
  } | null;
}

export interface WatchedEntry {
  ticker: string;
  address: string;
  chainId: number;
  lastSnapshotAt: number | null;
  corridors: string[];
  assessment?: {
    score: number;
    riskLevel: RiskLevel;
    reasons: string[];
    tis: Array<{ action: string; severity?: string; corridors?: string[] }>;
  } | null;
  dvnCorridors?: DvnCorridor[];
  latestVerdict?: {
    verdict: string;
    verdictHash: string;
    capturedAt: number;
    attestTxHash?: string | null;
    attestationId?: string | null;
  } | null;
}

export interface FleetRow {
  ticker: string;
  address: string;
  chainId: number;
  chain: string;
  riskLevel: RowRisk;
  score: number | null;
  corridors: string[];
  lastSnapshotAt: number | null;
}

export function fleetRows(status: StatusPayload): FleetRow[] {
  const chainName = new Map(status.chains.map((c) => [c.chainId, c.name]));
  return status.watched.map((w) => ({
    ticker: w.ticker,
    address: w.address,
    chainId: w.chainId,
    chain: chainName.get(w.chainId) ?? String(w.chainId),
    riskLevel: w.assessment?.riskLevel ?? "UNASSESSED",
    score: w.assessment?.score ?? null,
    corridors: w.corridors ?? [],
    lastSnapshotAt: w.lastSnapshotAt ?? null,
  }));
}

export interface DvnRef { address: string; name: string | null }

export interface CorridorConfig {
  corridor: string;
  eid: number;
  requiredCount: number;
  optionalThreshold: number;
  effectiveCount: number;
  unreadable: boolean;
  requiredDVNs: DvnRef[];
  optionalDVNs: DvnRef[];
}

/** Per-corridor DVN config rows. A null uln means the corridor could not be
 *  read this cycle — surface that honestly rather than dropping the row. */
export function corridorSummary(entry: WatchedEntry): CorridorConfig[] {
  return (entry.dvnCorridors ?? []).map((c) => {
    if (!c.uln) {
      return {
        corridor: c.corridor, eid: c.eid,
        requiredCount: 0, optionalThreshold: 0, effectiveCount: 0,
        unreadable: true, requiredDVNs: [], optionalDVNs: [],
      };
    }
    const named = (addr: string): DvnRef => ({ address: addr, name: c.uln?.names?.[addr] ?? null });
    return {
      corridor: c.corridor,
      eid: c.eid,
      requiredCount: c.uln.requiredCount,
      optionalThreshold: c.uln.optionalThreshold,
      effectiveCount: c.uln.effectiveCount,
      unreadable: false,
      requiredDVNs: c.uln.requiredDVNs.map(named),
      optionalDVNs: c.uln.optionalDVNs.map(named),
    };
  });
}

export interface HistoryRow {
  oft: string;
  chainId: number;
  score: number;
  riskLevel: RiskLevel;
  capturedAt: number;
}

export interface VerdictRow {
  oft: string;
  chainId: number;
  capturedAt: number;
  verdict: string;
  reasons: string[];
  attestTxHash?: string | null;
}

export interface DriftRow {
  capturedAt: number;
  score: number;
  riskLevel: RiskLevel;
  event?: { verdict: string; reasons: string[]; attestTxHash: string | null };
}

/** Score history scoped to ONE oft+chain (the /history endpoint is address-only
 *  and the same address deploys cross-chain), newest first, attested events
 *  joined on capturedAt (verdict rows share the snapshot cycle's clock). */
export function driftRows(
  history: HistoryRow[],
  verdicts: VerdictRow[],
  address: string,
  chainId: number,
  limit: number,
): DriftRow[] {
  const needle = address.toLowerCase();
  const events = new Map(
    verdicts
      .filter((v) => v.oft.toLowerCase() === needle && v.chainId === chainId)
      .map((v) => [v.capturedAt, v]),
  );
  return history
    .filter((h) => h.oft.toLowerCase() === needle && h.chainId === chainId)
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, limit)
    .map((h) => {
      const ev = events.get(h.capturedAt);
      return {
        capturedAt: h.capturedAt,
        score: h.score,
        riskLevel: h.riskLevel,
        event: ev ? { verdict: ev.verdict, reasons: ev.reasons, attestTxHash: ev.attestTxHash ?? null } : undefined,
      };
    });
}

export type ResolveResult = { ok: true; entry: WatchedEntry } | { ok: false; error: string };

/** Resolve address(+chain) against the watched fleet. The same OFT address is
 *  routinely deployed on multiple chains, so an
 *  ambiguous address is an error that lists the candidates — never a guess. */
export function resolveAsset(status: StatusPayload, address: string, chain?: string | number): ResolveResult {
  const chainName = new Map(status.chains.map((c) => [c.chainId, c.name]));
  const nameOf = (id: number) => chainName.get(id) ?? String(id);
  const needle = address.toLowerCase();
  const matches = status.watched.filter((w) => w.address.toLowerCase() === needle);
  if (matches.length === 0) {
    return { ok: false, error: `${address} is not watched — call list_fleet to see the fleet.` };
  }
  if (chain !== undefined) {
    const key = String(chain).toLowerCase();
    const onChain = matches.filter((w) => nameOf(w.chainId).toLowerCase() === key || String(w.chainId) === key);
    if (onChain.length === 0) {
      return {
        ok: false,
        error: `${address} is not watched on chain "${chain}" — it is watched on: ${matches.map((w) => nameOf(w.chainId)).join(", ")}.`,
      };
    }
    return { ok: true, entry: onChain[0] };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `${address} is deployed on multiple chains: ${matches.map((w) => `${nameOf(w.chainId)} (${w.chainId})`).join(", ")}. Pass the chain parameter to pick one.`,
    };
  }
  return { ok: true, entry: matches[0] };
}

/** One-line fleet posture, e.g. "175 OFTs watched across 3 chains — 22 CRITICAL / 75 AT_RISK / 64 PASS / 13 UNASSESSED (rules 4.1.0)". */
export function fleetSummary(rows: FleetRow[], rulesVersion: string): string {
  const bands: Record<RowRisk, number> = { CRITICAL: 0, AT_RISK: 0, PASS: 0, UNASSESSED: 0 };
  for (const r of rows) bands[r.riskLevel]++;
  const chains = new Set(rows.map((r) => r.chainId)).size;
  const parts = (Object.keys(bands) as RowRisk[])
    .filter((b) => bands[b] > 0)
    .map((b) => `${bands[b]} ${b}`);
  return `${rows.length} OFTs watched across ${chains} chain(s) — ${parts.join(" / ")} (rules ${rulesVersion})`;
}
