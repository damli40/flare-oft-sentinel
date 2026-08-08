import { useState } from "react";
import type { MantleOft, WatchedChain, WatchedStatus } from "../api.ts";

function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function statusCls(w: WatchedStatus): string {
  if (!w.assessment) return "spill s-scan";
  const r = w.assessment.riskLevel;
  if (r === "CRITICAL") return "spill s-crit";
  if (r === "AT_RISK") return "spill s-warn";
  return "spill s-safe";
}

function statusLabel(w: WatchedStatus): string {
  if (!w.assessment) return "Scanning";
  const r = w.assessment.riskLevel;
  if (r === "CRITICAL") return "Critical";
  if (r === "AT_RISK") return "At risk";
  return "Safe";
}

const RISK_RANK: Record<string, number> = { CRITICAL: 0, AT_RISK: 1, PASS: 2 };

interface Props {
  status: WatchedStatus[] | undefined;
  /** Chain names/order from /status — the backend registry is the only namer. */
  chains: WatchedChain[] | undefined;
  /** Dune volume data — Mantle only; used to add a volume column on that tab. */
  ofts: MantleOft[] | null;
}

export function FleetBoard({ status, chains: served, ofts }: Props) {
  const watched = status ?? [];

  // Chains as served by the backend; fall back to deriving them from the fleet
  // (id-only names) so the board still works against an older backend.
  const chains: WatchedChain[] = served ?? (() => {
    const counts = new Map<number, number>();
    watched.forEach(w => counts.set(w.chainId, (counts.get(w.chainId) ?? 0) + 1));
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([chainId, count]) => ({ chainId, chainKey: null, name: `Chain ${chainId}`, count }));
  })();

  const [selected, setSelected] = useState<number | null>(null);
  const activeChain = selected ?? chains[0]?.chainId ?? null;

  // Mantle volume lookup (by address, ticker as fallback)
  const volByAddr = new Map<string, number>();
  const volByTicker = new Map<string, number>();
  ofts?.forEach(o => {
    if (o.address) volByAddr.set(o.address.toLowerCase(), o.usdVolume);
    volByTicker.set(o.ticker.toUpperCase(), o.usdVolume);
  });
  const volumeOf = (w: WatchedStatus): number | null =>
    w.chainId === 5000
      ? volByAddr.get(w.address.toLowerCase()) ?? volByTicker.get(w.ticker.toUpperCase()) ?? null
      : null;
  const showVolume = activeChain === 5000 && volByAddr.size + volByTicker.size > 0;

  const rows = watched
    .filter(w => w.chainId === activeChain)
    .sort((a, b) => {
      if (showVolume) return (volumeOf(b) ?? 0) - (volumeOf(a) ?? 0);
      const ra = a.assessment ? RISK_RANK[a.assessment.riskLevel] ?? 3 : 3;
      const rb = b.assessment ? RISK_RANK[b.assessment.riskLevel] ?? 3 : 3;
      return ra - rb || a.ticker.localeCompare(b.ticker);
    });

  return (
    <div>
      {chains.length > 0 && (
        <div className="fleet-tabs">
          {chains.map(c => (
            <button
              key={c.chainId}
              className={`fleet-tab${c.chainId === activeChain ? " on" : ""}`}
              onClick={() => setSelected(c.chainId)}
            >
              {c.name} <span className="n">{c.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="board">
        <table>
          <thead>
            <tr>
              <th className="rank">#</th>
              <th>Token</th>
              <th>Address</th>
              {showVolume && <th style={{ textAlign: "right" }}>All-time Volume</th>}
              <th style={{ textAlign: "right" }}>Sentinel status</th>
            </tr>
          </thead>
          <tbody>
            {!status && Array.from({ length: 8 }).map((_, i) => (
              <tr key={i}>
                <td className="rank" style={{ color: "var(--ghost)" }}>{String(i + 1).padStart(2, "0")}</td>
                <td><div style={{ height: 14, width: 60, background: "var(--surface-3)", borderRadius: 4 }} /></td>
                <td><div style={{ height: 12, width: 120, background: "var(--surface-3)", borderRadius: 4 }} /></td>
                <td style={{ textAlign: "right" }}><div style={{ height: 20, width: 64, background: "var(--surface-3)", borderRadius: 7, marginLeft: "auto" }} /></td>
              </tr>
            ))}
            {status && rows.length === 0 && (
              <tr><td colSpan={showVolume ? 5 : 4} style={{ padding: "20px 18px", color: "var(--text-2)", fontSize: 13 }}>No OFTs watched on this chain yet.</td></tr>
            )}
            {rows.map((w, i) => {
              const vol = showVolume ? volumeOf(w) : null;
              return (
                <tr key={`${w.chainId}:${w.address}`}>
                  <td className="rank">{String(i + 1).padStart(2, "0")}</td>
                  <td><div className="tk">{w.ticker}</div></td>
                  <td className="addr">{shortAddr(w.address)}</td>
                  {showVolume && <td className="vol">{vol !== null ? formatUsd(vol) : "—"}</td>}
                  <td style={{ textAlign: "right" }}>
                    <span className={statusCls(w)}>
                      <span className="d" />
                      {statusLabel(w)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
