import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { WatchedStatus, TransactionIntent, HistoryEntry } from "../api.ts";
import { txUrl, oftUrl, chainNameFor } from "../explorer.ts";

type RiskLvl = "crit" | "warn" | "safe" | "scan";

function riskLevel(w: WatchedStatus): RiskLvl {
  if (!w.assessment) return "scan";
  const r = w.assessment.riskLevel;
  if (r === "CRITICAL") return "crit";
  if (r === "AT_RISK")  return "warn";
  return "safe";
}

function riskColor(lvl: RiskLvl): string {
  if (lvl === "crit") return "#FF4D5E";
  if (lvl === "warn") return "#FFB23E";
  if (lvl === "safe") return "#34D27D";
  return "#5BE7F0";
}

function spillClass(lvl: RiskLvl): string {
  if (lvl === "crit") return "spill s-crit";
  if (lvl === "warn") return "spill s-warn";
  if (lvl === "safe") return "spill s-safe";
  return "spill s-scan";
}

function spillLabel(lvl: RiskLvl): string {
  if (lvl === "crit") return "Critical";
  if (lvl === "warn") return "At risk";
  if (lvl === "safe") return "Safe";
  return "Scanning";
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function pad(n: number): string { return String(Math.round(n)).padStart(2, "0"); }

function ScoreRing({ score, level }: { score: number; level: RiskLvl }) {
  const r   = 58;
  const c   = 2 * Math.PI * r;
  const off = c * (1 - score / 100);
  const col = riskColor(level);
  return (
    <svg width="132" height="132" viewBox="0 0 132 132">
      <circle cx="66" cy="66" r={r} fill="none" stroke="#1A2029" strokeWidth="9" />
      <circle
        cx="66" cy="66" r={r}
        fill="none" stroke={col} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off}
        transform="rotate(-90 66 66)"
        style={{ transition: "stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)", filter: `drop-shadow(0 0 6px ${col}66)` }}
      />
    </svg>
  );
}

function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Score-over-time line chart — the per-OFT view of the continuous monitoring
// record accumulated in score-history.jsonl since the Sentinel started watching.
function HistoryChart({ history, color }: { history: HistoryEntry[]; color: string }) {
  if (history.length < 2) return null;
  const W = 320, H = 72, PAD = 4;
  const coords = history
    .map((p, i) => {
      const x = PAD + (i / (history.length - 1)) * (W - PAD * 2);
      const y = H - PAD - (p.score / 100) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", background: "rgba(255,255,255,0.02)", borderRadius: 6 }}>
        {[25, 50, 75].map(s => (
          <line key={s} x1={PAD} x2={W - PAD} y1={H - PAD - (s / 100) * (H - PAD * 2)} y2={H - PAD - (s / 100) * (H - PAD * 2)} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        ))}
        <polyline points={coords} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--faint)", fontFamily: "var(--mono)", marginTop: 3 }}>
        <span>{fmtDay(history[0].capturedAt)}</span>
        <span>{history.length} checks</span>
        <span>{fmtDay(history[history.length - 1].capturedAt)}</span>
      </div>
    </div>
  );
}

interface TokenOverlayProps {
  watched: WatchedStatus;
  history?: HistoryEntry[];
  onClose: () => void;
  onReport: () => void;
}

export function TokenOverlay({ watched, history = [], onClose, onReport }: TokenOverlayProps) {
  const lvl   = riskLevel(watched);
  const score = watched.assessment?.score ?? 0;
  const v     = watched.latestVerdict;

  const reasons: string[] = v?.reasons.length
    ? v.reasons
    : watched.assessment?.reasons ?? [];

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // lock page scroll while open so the fixed overlay aligns to the viewport
  // (prevents the close-X clipping off-screen on mobile after scrolling)
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return createPortal(
    <div className="token-overlay on">
      <div className="to-bd" onClick={onClose} />
      <div className="to-panel">

        {/* ── Header ── */}
        <div className="to-hd">
          <span className="to-tkn">{watched.ticker}</span>
          <span className={spillClass(lvl)} style={{ marginLeft: 10 }}>
            <span className="d" />{spillLabel(lvl)}
          </span>
          <span className="to-adr">{watched.address}</span>
          <button className="to-x" onClick={onClose}>✕</button>
        </div>

        {/* ── Body ── */}
        <div className="to-main">

          {/* Left: score ring + reasons */}
          <div className="to-score-col">
            <div style={{ position: "relative" }}>
              <ScoreRing score={score} level={lvl} />
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 40, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.03em", color: riskColor(lvl) }}>
                  {pad(score)}
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".18em", color: "var(--faint)", marginTop: 4 }}>
                  RISK SCORE
                </span>
              </div>
            </div>
            {reasons.length > 0 && (
              <ul className="to-rl">
                {reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
          </div>

          {/* Right: detail */}
          <div className="to-detail-col">

            {/* On-chain proof */}
            {(v?.attestTxHash || v?.alertTxHash) && (
              <div>
                <div className="to-sec-lbl">On-chain proof</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {v.attestTxHash && txUrl(v.attestTxHash) && (
                    <a className="txlink" href={txUrl(v.attestTxHash)!} target="_blank" rel="noreferrer">
                      ⛓ attest{v.attestationId !== undefined ? ` #${v.attestationId}` : ""} ↗
                    </a>
                  )}
                  {v.alertTxHash && txUrl(v.alertTxHash) && (
                    <a className="txlink" href={txUrl(v.alertTxHash)!} target="_blank" rel="noreferrer">
                      🔔 alert dispatched ↗
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* DVN configuration */}
            {watched.dvnSummary && (
              <div>
                <div className="to-sec-lbl">DVN Configuration</div>
                <div className="to-dvn-thresh">
                  {watched.dvnSummary.optionalThreshold > 0 ? (
                    <>
                      Effective: <b>{watched.dvnSummary.effectiveCount} DVNs</b>
                      <span style={{ color: "var(--faint)", marginLeft: 6, fontSize: 11 }}>
                        ({watched.dvnSummary.requiredCount} required + {watched.dvnSummary.optionalThreshold}-of-{watched.dvnSummary.optionalDVNs.length} optional)
                      </span>
                    </>
                  ) : (
                    <>
                      Required: <b>{watched.dvnSummary.requiredCount}-of-{watched.dvnSummary.requiredDVNs.length}</b> DVNs
                    </>
                  )}
                  {watched.dvnSummary.effectiveCount <= 1 && (
                    <span style={{ color: "var(--critical)", marginLeft: 8, fontSize: 11 }}>⚠ single point of failure</span>
                  )}
                </div>
                <div>
                  {watched.dvnSummary.requiredDVNs.map((addr, i) => {
                    const name = watched.dvnNames?.[addr] ?? `DVN ${i + 1}`;
                    const bad = watched.dvnSummary!.effectiveCount <= 1;
                    return (
                      <div key={addr} className="to-dvn-row">
                        <div>
                          <div className="to-dvn-nm">{name}</div>
                          <div className="to-dvn-ad">{addr.slice(0, 10)}…{addr.slice(-6)}</div>
                        </div>
                        <span className={`to-dvn-st ${bad ? "bad" : "ok"}`}>
                          {bad ? "⚠ sole checker" : "✓ required"}
                        </span>
                      </div>
                    );
                  })}
                  {watched.dvnSummary.optionalDVNs?.map((addr, i) => {
                    const name = watched.dvnNames?.[addr] ?? `Optional DVN ${i + 1}`;
                    return (
                      <div key={addr} className="to-dvn-row">
                        <div>
                          <div className="to-dvn-nm">{name}</div>
                          <div className="to-dvn-ad">{addr.slice(0, 10)}…{addr.slice(-6)}</div>
                        </div>
                        <span className="to-dvn-st opt">optional</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Remediation steps (TIS with pre-flight) */}
            {(() => {
              const tis: TransactionIntent[] = watched.latestVerdict?.tis?.length
                ? watched.latestVerdict.tis
                : watched.assessment?.tis ?? [];
              if (!tis.length) return null;
              const sevColor = (s: string) =>
                s === "CRITICAL" ? "#FF4D5E" : s === "HIGH" ? "#FFB23E" : s === "MEDIUM" ? "#5BE7F0" : "#8899aa";
              return (
                <div>
                  <div className="to-sec-lbl">Remediation steps</div>
                  <ol style={{ margin: 0, paddingLeft: 16 }}>
                    {tis.slice(0, 5).map((t, i) => (
                      <li key={i} style={{ fontSize: 12, marginBottom: 6, color: "var(--text)" }}>
                        <span style={{ color: sevColor(t.severity), fontWeight: 600, marginRight: 5 }}>{t.severity}</span>
                        {t.action}{t.corridors?.length ? ` (${t.corridors.join(", ")})` : ""}
                        {t.preflight && t.preflight.scoreAfter > t.preflight.scoreBefore && (
                          <span style={{ marginLeft: 8, color: "#34D27D", fontSize: 11 }}>
                            → {t.preflight.scoreAfter}/{t.preflight.riskAfter}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })()}

            {/* Score history */}
            {history.length >= 2 && (
              <div>
                <div className="to-sec-lbl">Score history</div>
                <HistoryChart history={history} color={riskColor(lvl)} />
              </div>
            )}

            {/* Monitored corridors */}
            <div>
              <div className="to-sec-lbl">Monitored corridors</div>
              {watched.corridors?.length ? (
                <div className="to-corrs">
                  {watched.corridors.map(c => (
                    <span key={c} className="to-corr">{c}</span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--faint)", paddingTop: 4 }}>Scanning routes…</div>
              )}
            </div>

            {/* Contract */}
            <div>
              <div className="to-sec-lbl">
                Contract{chainNameFor(watched.chainId) ? ` on ${chainNameFor(watched.chainId)}` : ""}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {oftUrl(watched.chainId, watched.address) ? (
                  <a className="txlink" href={oftUrl(watched.chainId, watched.address)!} target="_blank" rel="noreferrer">
                    {short(watched.address)} ↗
                  </a>
                ) : (
                  <span className="txlink">{short(watched.address)}</span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="to-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => { onClose(); onReport(); }}
              >
                ↓ Generate report
              </button>
              {oftUrl(watched.chainId, watched.address) && (
                <a
                  className="btn btn-ghost btn-sm"
                  href={oftUrl(watched.chainId, watched.address)!}
                  target="_blank"
                  rel="noreferrer"
                >
                  Explorer ↗
                </a>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
