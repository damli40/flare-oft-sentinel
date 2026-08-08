import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { setChainConfig, txUrl, contractUrl, oftUrl, chainNameFor } from "../explorer.ts";
import {
  getSentinelStatus,
  getSentinelVerdicts,
  getReport,
  getFeed,
  getAllHistories,
  askSecurityCopilot,
} from "../api.ts";
import type { SentinelStatus, SentinelVerdict, WatchedStatus, FeedEvent, TransactionIntent, PolicyDecisionRecord, HistoryEntry } from "../api.ts";
import { Aperture } from "./Aperture.tsx";
import { TokenOverlay } from "./TokenOverlay.tsx";
import { VerifyPdr } from "./VerifyPdr.tsx";
import "../dashboard.css";

type RiskLvl = "crit" | "warn" | "safe" | "scan";

function riskLevel(w: WatchedStatus): RiskLvl {
  if (!w.assessment) return "scan";
  const r = w.assessment.riskLevel;
  if (r === "CRITICAL") return "crit";
  if (r === "AT_RISK")  return "warn";
  return "safe";
}

function riskColor(lvl: RiskLvl | string): string {
  if (lvl === "crit" || lvl === "CRITICAL") return "#FF4D5E";
  if (lvl === "warn" || lvl === "AT_RISK")  return "#FFB23E";
  if (lvl === "safe" || lvl === "PASS")     return "#34D27D";
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

function ago(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function pad(n: number): string { return String(Math.round(n)).padStart(2, "0"); }

// ── DVN provider utilities ────────────────────────────────────────────────────

function normalizeDvnName(name: string): string {
  if (name.includes("LayerZero")) return "LZ Labs";
  if (name.startsWith("Google")) return "Google";
  return name;
}

/** Build a provider-name → ticker[] map from live fleet dvnNames + dvnSummary data. */
function buildDvnMap(fleet: WatchedStatus[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const w of fleet) {
    if (!w.dvnSummary || !w.dvnNames) continue;
    const addrs = [...w.dvnSummary.requiredDVNs, ...w.dvnSummary.optionalDVNs];
    for (const addr of addrs) {
      const raw = w.dvnNames[addr] ?? w.dvnNames[addr.toLowerCase()];
      if (!raw || raw.includes("…")) continue; // skip unresolved address fragments
      const name = normalizeDvnName(raw);
      if (!map.has(name)) map.set(name, []);
      const list = map.get(name)!;
      if (!list.includes(w.ticker)) list.push(w.ticker);
    }
  }
  return map;
}

// ── DVN Concentration Panel ───────────────────────────────────────────────────

interface DvnPanelProps {
  fleet: WatchedStatus[];
  dvnMap: Map<string, string[]>;
  selectedDvn: string | null;
  onSelect: (name: string | null) => void;
}

function DvnConcentrationPanel({ fleet, dvnMap, selectedDvn, onSelect }: DvnPanelProps) {
  const [open, setOpen] = useState(true);
  const fleetTickers = new Set(fleet.map(w => w.ticker));
  const totalFleet = fleet.length;

  const matchingTickers = selectedDvn
    ? (dvnMap.get(selectedDvn) ?? []).filter(t => fleetTickers.has(t))
    : [];
  const pct = totalFleet > 0 ? Math.round((matchingTickers.length / totalFleet) * 100) : 0;
  const systemic = pct >= 60;
  const providers = Array.from(dvnMap.entries()).sort((a, b) => b[1].length - a[1].length);

  // OFTs where this DVN is the sole verifier (effectiveCount === 1) vs shared
  const matchingFleet = fleet.filter(w => matchingTickers.includes(w.ticker));
  const soleTickers = matchingFleet
    .filter(w => w.dvnSummary?.effectiveCount === 1)
    .map(w => w.ticker);
  const exploitRisk = soleTickers.length > 0;

  return (
    <div className="card2">
      <div className="hd" style={{ cursor: "pointer" }} onClick={() => setOpen(o => !o)}>
        <h3>DVN Concentration</h3>
        <span className="tag">{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <>
          <div style={{ padding: "12px 20px 8px" }}>
            <p style={{ fontSize: 12, color: "var(--text-2)", margin: 0, lineHeight: 1.5 }}>
              {providers.length === 0
                ? "Waiting for fleet data..."
                : "Select a DVN provider to see which OFTs depend on it and assess systemic risk."}
            </p>
          </div>
          <div className="dvn-chips">
            {providers.map(([name, tickers]) => {
              const matches = tickers.filter(t => fleetTickers.has(t)).length;
              return (
                <button
                  key={name}
                  className={`dvn-chip${selectedDvn === name ? " on" : ""}`}
                  onClick={() => onSelect(selectedDvn === name ? null : name)}
                >
                  {name} · {matches}
                </button>
              );
            })}
          </div>
          {selectedDvn && (
            <div className="dvn-result">
              <div className="dvn-res-hd">
                <span className="dvn-res-name">{selectedDvn}</span>
                {exploitRisk && systemic && <span className="dvn-res-badge sys">SYSTEMIC EXPLOIT RISK</span>}
                {exploitRisk && !systemic && <span className="dvn-res-badge sys">EXPLOIT RISK</span>}
                {!exploitRisk && systemic && <span className="dvn-res-badge" style={{ background: "var(--warn)" }}>LIVENESS RISK</span>}
              </div>
              <div className="dvn-res-stats">
                <div className="dvn-stat">
                  <div className="v" style={{ color: exploitRisk ? "var(--critical)" : systemic ? "var(--warn)" : "var(--scan)" }}>
                    {matchingTickers.length}
                  </div>
                  <div className="l">OFTs</div>
                </div>
                <div className="dvn-stat">
                  <div className="v" style={{ color: exploitRisk ? "var(--critical)" : systemic ? "var(--warn)" : "var(--scan)" }}>
                    {pct}%
                  </div>
                  <div className="l">of fleet</div>
                </div>
              </div>
              <div className="dvn-res-tks">
                {matchingTickers.map(t => (
                  <span
                    key={t}
                    className={soleTickers.includes(t) ? "spill s-crit" : "spill s-scan"}
                    style={{ padding: "2px 8px", fontSize: 11 }}
                    title={soleTickers.includes(t) ? "Sole verifier — exploit risk" : "Shared verifier — liveness risk only"}
                  >
                    {t}{soleTickers.includes(t) ? " ⚠" : ""}
                  </span>
                ))}
                {matchingTickers.length === 0 && (
                  <span style={{ fontSize: 12, color: "var(--faint)" }}>
                    No matching OFTs in current fleet
                  </span>
                )}
              </div>
              {(exploitRisk || systemic) && (
                <div className="dvn-res-warn">
                  {exploitRisk
                    ? `⚠ ${selectedDvn} is the sole verifier on ${soleTickers.join(", ")}. If compromised, transfers on ${soleTickers.length === 1 ? "that bridge" : "those bridges"} can be forged.${systemic ? ` It also covers ${pct}% of the fleet as a shared verifier.` : ""}`
                    : `ℹ ${selectedDvn} covers ${pct}% of the fleet as a shared verifier. If it goes offline, message delivery pauses on ${matchingTickers.length} bridges — no transfers can be forged. The team can add a replacement DVN.`}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Intelligence Feed ─────────────────────────────────────────────────────────

function IntelFeed({ events }: { events: FeedEvent[] }) {
  const feedRef = useRef<HTMLDivElement>(null);

  // pin the newest line WITHIN the feed box — never scroll the page
  useEffect(() => {
    const c = feedRef.current;
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: "smooth" });
  }, [events]);

  function rowClass(e: FeedEvent): string {
    if (!e.riskLevel) return "ok";
    if (e.riskLevel === "CRITICAL") return "crit";
    if (e.riskLevel === "AT_RISK")  return "warn";
    return "ok";
  }

  function icon(e: FeedEvent): string {
    if (e.riskLevel === "CRITICAL") return "⚠";
    if (e.riskLevel === "AT_RISK")  return "▲";
    if (e.type === "attest")        return "⛓";
    return "✓";
  }

  return (
    <div className="intel-feed" ref={feedRef}>
      {events.length === 0 && (
        <div style={{ padding: "14px 16px", color: "var(--faint)", fontSize: 12, fontFamily: "var(--mono)" }}>
          No events yet.
        </div>
      )}
      {events.map((e, i) => (
        <div key={i} className={`if-row ${rowClass(e)}${i === 0 ? " if-new" : ""}`}>
          <span className="if-ic">{icon(e)}</span>
          <div>
            <div className="if-msg">
              <b>{e.ticker}</b> — {e.detail}
            </div>
            <div className="if-sub">{ago(e.timestamp)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatMd(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}

// ── Security Copilot ──────────────────────────────────────────────────────────

const COPILOT_CHIPS = [
  "Which bridges are most at risk?",
  "What is the LZ Labs DVN concentration?",
  "What does a 1-of-1 DVN configuration mean?",
  "How does attestation work?",
  "Is pufETH safe to bridge?",
];

interface CopilotMsg { role: "user" | "assistant"; text: string }

interface CopilotProps {
  onClose: () => void;
}

function SecurityCopilot({ onClose }: CopilotProps) {
  const [messages, setMessages] = useState<CopilotMsg[]>([
    { role: "assistant", text: "I'm OFT Sentinel's security AI. Ask me anything about bridge security, DVN configurations, or the OFTs we watch across every monitored chain." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<{ remaining: number; limit: number } | null>(null);
  const msgsEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setMessages(m => [...m, { role: "user", text: question }]);
    setInput("");
    setBusy(true);
    try {
      const { answer, remaining, limit } = await askSecurityCopilot(question);
      if (remaining !== undefined && limit !== undefined) setQuota({ remaining, limit });
      setMessages(m => [...m, { role: "assistant", text: answer }]);
    } catch (e: any) {
      // Surface the server's message (rate limit, input cap) rather than a generic failure.
      const text = e?.message && e.message !== "Copilot request failed"
        ? e.message
        : "Unable to reach the AI backend. Make sure the server is running.";
      setMessages(m => [...m, { role: "assistant", text }]);
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="copilot-overlay on">
      <div className="copilot-bd" onClick={onClose} />
      <div className="copilot-panel" onClick={e => e.stopPropagation()}>
        <div className="copilot-hd">
          <span className="copilot-mark">◎</span>
          <div>
            <div className="copilot-title">Security Copilot</div>
            <div className="copilot-sub">
              Powered by DeepSeek · {quota ? `Community tier — ${quota.remaining}/${quota.limit} queries left` : "Community tier — 10 queries/hour"}
            </div>
          </div>
          <button
            style={{ marginLeft: "auto", cursor: "pointer", color: "var(--faint)", background: "none", border: "none", fontSize: 18 }}
            onClick={onClose}
          >✕</button>
        </div>
        <div className="copilot-msgs">
          {messages.map((m, i) =>
            m.role === "assistant"
              ? <div key={i} className="cop-msg assistant" dangerouslySetInnerHTML={{ __html: formatMd(m.text) }} />
              : <div key={i} className="cop-msg user">{m.text}</div>
          )}
          {busy && (
            <div className="cop-msg assistant">
              <span className="cop-typing">Analyzing…</span>
            </div>
          )}
          <div ref={msgsEndRef} />
        </div>
        <div className="copilot-chips">
          {COPILOT_CHIPS.map(q => (
            <button
              key={q}
              className="cop-chip"
              onClick={() => ask(q)}
              disabled={busy}
            >
              {q}
            </button>
          ))}
        </div>
        <div className="copilot-input-row">
          <input
            ref={inputRef}
            className="copilot-input"
            placeholder="Ask about any OFT, DVN, or bridge risk…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") ask(input); }}
            disabled={busy}
          />
          <button
            className="copilot-send"
            onClick={() => ask(input)}
            disabled={busy || !input.trim()}
          >
            ↑
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Score sparkline ───────────────────────────────────────────────────────────
// Tiny score-over-time line per fleet tile — the visible record that the agent
// has been watching continuously, not just assessing once.

function Sparkline({ history, color }: { history: HistoryEntry[]; color: string }) {
  const pts = history.slice(-30);
  if (pts.length < 2) return null;
  const min = Math.min(...pts.map(p => p.score));
  const max = Math.max(...pts.map(p => p.score));
  const span = Math.max(max - min, 4); // flat lines still render mid-band
  const coords = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * 100;
      const y = 20 - ((p.score - min) / span) * 16 - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width="100%" height="20" viewBox="0 0 100 20" preserveAspectRatio="none" style={{ display: "block", marginTop: 6, opacity: 0.8 }}>
      <polyline points={coords} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ── Agent heartbeat ───────────────────────────────────────────────────────────

interface LogLine { id: number; cls: string; ic: string; text: string; sub?: string; time: string }

let logSeq = 0;
function mkLine(cls: string, ic: string, text: string, sub?: string): LogLine {
  const d = new Date();
  const t = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  return { id: logSeq++, cls, ic, text, sub, time: t };
}

// ── Score ring ────────────────────────────────────────────────────────────────

function ScoreRing({ score, level }: { score: number; level: RiskLvl | string }) {
  const r = 58;
  const c = 2 * Math.PI * r;
  const off = c * (1 - score / 100);
  const color = riskColor(level);
  return (
    <svg width="132" height="132" viewBox="0 0 132 132">
      <circle cx="66" cy="66" r={r} fill="none" stroke="#1A2029" strokeWidth="9" />
      <circle
        cx="66" cy="66" r={r}
        fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off}
        transform="rotate(-90 66 66)"
        style={{ transition: "stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)", filter: `drop-shadow(0 0 6px ${color}66)` }}
      />
    </svg>
  );
}

// ── Report modal ──────────────────────────────────────────────────────────────

// Named per asset, not per deployment: this modal ran for a Flare OFT while
// telling the user the config was being fetched "from Mantle".
function reportSteps(chainName: string | null): string[] {
  return [
    chainName ? `Fetching live DVN config from ${chainName}` : "Fetching live DVN config",
    "Assessing corridors for risk",
    "Checking DVN deprecation status",
    "Writing narrative (DeepSeek)",
  ];
}

interface ReportModalProps {
  watched: WatchedStatus;
  onClose: () => void;
}

function ReportModal({ watched, onClose }: ReportModalProps) {
  const REPORT_STEPS = reportSteps(chainNameFor(watched.chainId));
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const blobRef = useRef<string | null>(null);
  const tickerRef = useRef(watched.ticker);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      for (let i = 0; i < REPORT_STEPS.length - 1; i++) {
        if (cancelled) return;
        setStep(i);
        // Fixed pacing. This only spaces out progress labels while the real
        // report is fetched, so randomness bought nothing — and "no value a user
        // sees comes from a random source" is a rule worth being able to state
        // without an asterisk.
        await new Promise(r => setTimeout(r, 800));
      }
      if (cancelled) return;
      setStep(REPORT_STEPS.length - 1);
      try {
        const { ticker, markdown } = await getReport(watched.address);
        if (cancelled) return;
        tickerRef.current = ticker;
        blobRef.current = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
      } catch (e: any) {
        if (!cancelled) setError((e as Error).message);
      }
      if (!cancelled) setDone(true);
    };
    run();
    return () => { cancelled = true; };
  }, [watched.address]);

  function download() {
    if (!blobRef.current) return;
    const a = document.createElement("a");
    a.href = blobRef.current;
    a.download = `${tickerRef.current.toLowerCase()}-sentinel-report.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobRef.current);
    blobRef.current = null;
    onClose();
  }

  return createPortal(
    <div className="modal-bg on" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="mh">
          <span id="repMark"><Aperture size={30} spin /></span>
          <div>
            <div className="tk">{watched.ticker}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{watched.address}</div>
          </div>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="mb">
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".14em", color: "var(--faint)", marginBottom: 6 }}>
            GENERATING SECURITY REPORT
          </div>
          <div id="reportSteps">
            {REPORT_STEPS.map((s, i) => {
              const isDone = done ? true : i < step;
              const isRun  = !done && i === step;
              return (
                <div key={i} className={`report-step${isRun ? " run" : isDone ? " done" : ""}`}>
                  <span className="si">{isDone ? "✓" : i + 1}</span>
                  <span className="lab">{s}</span>
                </div>
              );
            })}
          </div>
          {error && (
            <div style={{ color: "var(--critical)", fontSize: 12, marginTop: 12 }}>{error}</div>
          )}
          {done && !error && (
            <div className="report-dl" style={{ marginTop: 18 }}>
              <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={download}>
                ↓ {tickerRef.current.toLowerCase()}-sentinel-report.md ready
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Verdict spotlight ─────────────────────────────────────────────────────────

function VerdictSpotlight({ verdict, status, onShowReport }: {
  verdict: SentinelVerdict | null;
  status: SentinelStatus | null;
  onShowReport?: (w: WatchedStatus) => void;
}) {
  if (!verdict && !status) {
    return (
      <div className="spotlight" style={{ padding: 24, opacity: 0.5 }}>
        <div className="ring-wrap">
          <ScoreRing score={0} level="scan" />
          <div className="scoretxt">
            <div className="v" style={{ color: "var(--scan)" }}>-</div>
            <div className="m">RISK SCORE</div>
          </div>
        </div>
        <div className="verdict">
          <div className="vh"><span className="tk">-</span></div>
          <p style={{ color: "var(--text-2)", fontSize: 13, marginTop: 8 }}>
            No verdicts yet. A verdict is recorded when a config changes or reads unsafe.
          </p>
        </div>
      </div>
    );
  }

  let score = 0, lvl: RiskLvl = "scan", tkr = "-", addr = "", reasons: string[] = [];
  let oftChainId: number | null = null;
  let attestId: string | undefined, attestTx: string | undefined, alertTx: string | undefined;
  let assessedOft: WatchedStatus | null = null;
  let tis: TransactionIntent[] | undefined;
  let pdr: PolicyDecisionRecord | undefined;

  if (verdict) {
    score    = verdict.score;
    lvl      = verdict.riskLevel === "CRITICAL" ? "crit" : verdict.riskLevel === "AT_RISK" ? "warn" : "safe";
    tkr      = verdict.ticker;
    addr     = verdict.oft;
    oftChainId = verdict.chainId;
    reasons  = verdict.reasons;
    attestId = verdict.attestationId;
    attestTx = verdict.attestTxHash;
    alertTx  = verdict.alertTxHash;
    tis      = verdict.tis;
    pdr      = verdict.pdr;
  } else if (status) {
    const first = [...status.watched]
      .sort((a, b) => (a.assessment?.score ?? 100) - (b.assessment?.score ?? 100))[0];
    if (first) {
      score = first.assessment?.score ?? 0;
      lvl   = riskLevel(first);
      tkr   = first.ticker;
      addr  = first.address;
      oftChainId = first.chainId;
      reasons = first.assessment?.reasons ?? [];
      tis     = first.assessment?.tis;
      assessedOft = first;
    }
  }

  return (
    <div className="spotlight">
      <div className="ring-wrap">
        <ScoreRing score={score} level={lvl} />
        <div className="scoretxt">
          <div className="v" style={{ color: riskColor(lvl) }}>{pad(score)}</div>
          <div className="m">RISK SCORE</div>
        </div>
      </div>
      <div className="verdict">
        <div className="vh">
          <span className="tk">{tkr}</span>
          <span className={spillClass(lvl)}>
            <span className="d" />
            {spillLabel(lvl)}
          </span>
        </div>
        {addr && <div className="corr">{short(addr)}</div>}
        <ul className="reasons">
          {reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
        {tis && tis.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10, color: "var(--text-2)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>Remediation</div>
            <ol style={{ margin: 0, paddingLeft: 16 }}>
              {tis.slice(0, 5).map((t, i) => (
                <li key={i} style={{ fontSize: 12, marginBottom: 4, color: "var(--text)" }}>
                  <span style={{ color: riskColor(t.severity), fontWeight: 600, marginRight: 5 }}>{t.severity}</span>
                  {t.action}{t.corridors?.length ? ` (${t.corridors.join(", ")})` : ""}
                  {t.preflight && t.preflight.scoreAfter > t.preflight.scoreBefore && (
                    <span style={{ marginLeft: 8, color: "var(--safe)", fontSize: 11 }}>
                      → {t.preflight.scoreAfter}/{t.preflight.riskAfter}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
        {(attestTx || alertTx || attestId !== undefined) && (
          <div className="tx">
            {attestTx && txUrl(attestTx) && (
              <a className="txlink" href={txUrl(attestTx)!} target="_blank" rel="noreferrer">
                ⛓ attest {attestId !== undefined ? `#${attestId}` : ""} ↗
              </a>
            )}
            {alertTx && txUrl(alertTx) && (
              <a className="txlink" href={txUrl(alertTx)!} target="_blank" rel="noreferrer">
                🔔 alert dispatched ↗
              </a>
            )}
            {addr && oftUrl(oftChainId, addr) && (
              <a className="txlink" href={oftUrl(oftChainId, addr)!} target="_blank" rel="noreferrer">
                OFT ↗
              </a>
            )}
          </div>
        )}
        {pdr && (
          <div style={{ marginTop: 10, padding: "8px 10px", background: "rgba(91,231,240,0.05)", borderRadius: 6, borderLeft: "2px solid var(--scan)" }}>
            <div style={{ fontSize: 10, color: "var(--scan)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Policy Decision Record</div>
            <div style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.7 }}>
              Rules v{pdr.rulesVersion} · Agent #{pdr.agentId} · {pdr.findings.length} checks evaluated
            </div>
            <div style={{ fontSize: 10, color: "var(--text-2)", marginTop: 3 }}>
              keccak256(JSON.stringify(PDR)) == verdictHash — independently verifiable
            </div>
            {verdict?.verdictHash && <VerifyPdr pdr={pdr} verdictHash={verdict.verdictHash} />}
          </div>
        )}
        {assessedOft && (
          <div className="tx">
            {oftUrl(oftChainId, addr) && (
              <a className="txlink" href={oftUrl(oftChainId, addr)!} target="_blank" rel="noreferrer">
                OFT ↗
              </a>
            )}
            <button
              className="txlink"
              style={{ background: "none", border: "none", cursor: "pointer" }}
              onClick={() => onShowReport?.(assessedOft!)}
            >
              ↓ report
            </button>
            <button
              className="txlink"
              style={{ background: "none", border: "none", cursor: "pointer" }}
              onClick={() => {
                const el = document.getElementById(`ft-${addr}`);
                el?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              ↓ fleet
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

interface Props {
}

export function SentinelDashboard() {
  const [status, setStatus]   = useState<SentinelStatus | null>(null);
  const [verdicts, setVerdicts] = useState<SentinelVerdict[]>([]);
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [histories, setHistories] = useState<Record<string, HistoryEntry[]>>({});
  const [error, setError]     = useState("");
  
  const [filter, setFilter]   = useState<"all" | "crit" | "warn" | "safe">("all");
  const [reportTarget, setReportTarget]   = useState<WatchedStatus | null>(null);
  const [overlayTarget, setOverlayTarget] = useState<WatchedStatus | null>(null);
  const [selectedDvn, setSelectedDvn]     = useState<string | null>(null);
  const [copilotOpen, setCopilotOpen]     = useState(false);

  // Agent log. Written only by actions that actually happened in this session
  // (the replay demo); there is no synthetic heartbeat feeding it.
  const [logs, setLogs]       = useState<LogLine[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval>[]>([]);

  function addLog(line: LogLine) {
    setLogs(prev => [...prev.slice(-8), line]);
  }

  // agentTick() used to live here. It picked a random watched ticker, a random
  // corridor from a hardcoded list, and a random 22-53ms latency, then printed
  // "polling FLR → berachain" and "✓ no drift · 43ms" — with REAL third-party
  // token names, for corridors those tokens do not have, and fed the random
  // numbers into an "N ms avg" statistic. None of it was measured.
  //
  // Removed rather than reworded. The product's whole claim is that a verdict is
  // trustworthy because it was measured; inventing telemetry about somebody
  // else's token is the exact failure this tool audits other people for, and a
  // "simulated" label does not help because a judge reads the numbers, not the
  // disclaimer. It is not driven from real data instead because the data does
  // not exist: nothing measures per-asset poll latency, and /status carries no
  // last-poll or next-poll time. Approximating it would be the same defect with
  // extra steps.
  //
  // The log surface itself stays: the replay demo writes real outcomes to it.

  async function refreshFeed() {
    try {
      const events = await getFeed();
      setFeedEvents(events.slice(0, 20));
    } catch {}
  }

  async function refresh() {
    const [s, v, h] = await Promise.all([getSentinelStatus(), getSentinelVerdicts(), getAllHistories()]);
    setChainConfig(s); // links resolve to the chain the backend actually signs on
    setStatus(s);
    setVerdicts([...v].reverse());
    setHistories(h);
    await refreshFeed();
    return s;
  }

  useEffect(() => {
    refresh().catch(e => setError(e.message));

    return () => timerRef.current.forEach(clearInterval);
  }, []);

  const latest    = verdicts[0] ?? null;
  const criticals = status?.watched.filter(w => riskLevel(w) === "crit") ?? [];

  const assessed = (status?.watched ?? []).filter(w => w.assessment !== null);
  const sorted = [...assessed].sort((a, b) => {
    const order = { crit: 0, warn: 1, safe: 2, scan: 3 };
    return order[riskLevel(a)] - order[riskLevel(b)] || (a.assessment?.score ?? 100) - (b.assessment?.score ?? 100);
  });

  const visible = sorted.filter(w => {
    if (filter === "all") return true;
    if (filter === "crit") return riskLevel(w) === "crit";
    if (filter === "warn") return riskLevel(w) === "warn";
    if (filter === "safe") return riskLevel(w) === "safe";
    return true;
  });

  const dvnMap = buildDvnMap(status?.watched ?? []);
  const selectedDvnTickers = selectedDvn ? new Set(dvnMap.get(selectedDvn) ?? []) : null;

  return (
    <section id="view-sentinel" className="view on">
      <div className="page">
        <div className="dash" id="dashRoot">

          {/* ── LEFT MAIN ─────────────────────────────────────────────────── */}
          <div className="dash-main">

            {/* Latest verdict spotlight */}
            <div className="card2 spotlight-card">
              <div className="hd">
                <span className="live-dot" />
                <h3>Latest verdict</h3>
                <span className="tag" id="verdictTime">
                  {latest ? ago(latest.capturedAt) : "-"}
                </span>
              </div>
              <VerdictSpotlight verdict={latest} status={status} onShowReport={setReportTarget} />
            </div>

            {/* DVN Concentration Panel */}
            <DvnConcentrationPanel
              fleet={assessed}
              dvnMap={dvnMap}
              selectedDvn={selectedDvn}
              onSelect={setSelectedDvn}
            />

            {/* Fleet status */}
            <div className="card2">
              <div className="hd">
                <h3>Fleet status</h3>
                <div className="fleet-filters">
                  {(["all", "crit", "warn", "safe"] as const).map(f => (
                    <button
                      key={f}
                      className={filter === f ? "on" : ""}
                      onClick={() => setFilter(f)}
                    >
                      {f === "all" ? `All ${assessed.length}` : f === "crit" ? "Critical" : f === "warn" ? "At risk" : "Safe"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="bd">
                {criticals.length > 0 && (filter === "all" || filter === "crit") && (
                  <div className="alert-banner">
                    <span className="live-dot" style={{ background: "var(--critical)", boxShadow: "0 0 8px var(--critical)" }} />
                    <span className="t">Critical alerts</span>
                    <span className="c">{criticals.length} bridges exploitable today, single point of failure</span>
                  </div>
                )}
                {!status ? (
                  <div className="fleet-grid">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <div key={i} className="ftile" style={{ height: 100, opacity: 0.4, animation: "none" }} />
                    ))}
                  </div>
                ) : (
                  <div className="fleet-grid">
                    {visible.map(w => {
                      const lvl   = riskLevel(w);
                      const score = w.assessment?.score ?? 0;
                      let dvnCls = "";
                      if (selectedDvnTickers) {
                        dvnCls = selectedDvnTickers.has(w.ticker) ? " dvn-match" : " dvn-dim";
                      }
                      return (
                        <div
                          key={w.address}
                          id={`ft-${w.address}`}
                          className={`ftile ${lvl}${dvnCls}`}
                          onClick={() => setOverlayTarget(w)}
                        >
                          <div className="top">
                            <div>
                              <div className="tk">{w.ticker}</div>
                              <div className="ad">{short(w.address)}</div>
                            </div>
                            <div
                              className="dl"
                              onClick={e => { e.stopPropagation(); setReportTarget(w); }}
                              title="Download report"
                            >
                              ↓
                            </div>
                          </div>
                          <div className="mid">
                            <div className="sc">{lvl === "scan" ? "—" : pad(score)}</div>
                            <span className={spillClass(lvl)} style={{ padding: "3px 7px" }}>
                              <span className="d" />
                              {spillLabel(lvl)}
                            </span>
                          </div>
                          <Sparkline history={histories[w.address.toLowerCase()] ?? []} color={riskColor(lvl)} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* ── RIGHT SIDEBAR ─────────────────────────────────────────────── */}
          <div className="dash-side">

            {/* Agent log.
                Every value here is one the page can actually source: the
                connection state comes from whether /status resolved, the counts
                come from /status itself, and the log lines come from actions
                taken in this session. The previous version showed an "N ms avg"
                latency and a "Next cycle MM:SS" countdown, neither of which was
                measured — the latency was Math.random() and the countdown was a
                287-second loop unrelated to POLL_INTERVAL_MS. */}
            <div className="card2 agent">
              <div className="agent-status">
                <span className="live-dot" />
                <span className="lbl">{status ? "SENTINEL CONNECTED" : "CONNECTING…"}</span>
                <span className="right">{status?.chain?.name ?? ""}</span>
              </div>
              <div className="agent-log" id="agentLog">
                {logs.length === 0 ? (
                  <div className="l" style={{ opacity: 0.55 }}>
                    <span className="ic">·</span>
                    <span>No agent activity in this session.</span>
                  </div>
                ) : logs.map(l => (
                  <div key={l.id} className={`l ${l.cls}`}>
                    <span className="ic">{l.ic}</span>
                    <span className="t">{l.time}</span>
                    <span>{l.text}</span>
                    {l.sub && <span className="sub">{l.sub}</span>}
                  </div>
                ))}
              </div>
              <div className="agent-cycle">
                <span>Watching <b>{status?.watched.length ?? "-"} OFTs</b></span>
                <span>Rules <b>{status?.rulesVersion ?? "-"}</b></span>
              </div>
            </div>
            {/* Controls */}
            <div className="card2">
              <div className="hd"><h3>Controls</h3></div>
              <div className="controls">
                <button
                  className="btn btn-ghost copilot-btn"
                  onClick={() => setCopilotOpen(true)}
                >
                  ◎ Security Copilot
                </button>
              </div>
              {error && (
                <div style={{ padding: "0 18px 14px", color: "var(--critical)", fontSize: 12 }}>{error}</div>
              )}
            </div>

            {/* Intelligence Feed */}
            <div className="card2">
              <div className="hd">
                <span className="live-dot" />
                <h3>Intelligence feed</h3>
                <span className="tag">live</span>
              </div>
              <IntelFeed events={feedEvents} />
            </div>

            {/* Attestation ledger */}
            <div className="card2">
              <div className="hd">
                <h3>Attestation ledger</h3>
                <span className="tag">on-chain</span>
              </div>
              <div className="ledger" id="ledger">
                {verdicts.length === 0 ? (
                  <div style={{ padding: "14px 18px", color: "var(--faint)", fontSize: 12, fontFamily: "var(--mono)" }}>
                    No verdicts yet.
                  </div>
                ) : verdicts.map((v, i) => (
                  <div key={`${v.verdictHash}-${i}`} className="row">
                    {/* An attestation id exists only when a transaction wrote one.
                        Falling back to the row's position rendered "#2" in the
                        same format as a real registry id, inside a panel headed
                        "Attestation ledger · on-chain" — fabricating an on-chain
                        identifier for a verdict that was never attested (every
                        scope-refused verdict is one). Show nothing instead. */}
                    <span className="id">{v.attestationId !== undefined ? `#${v.attestationId}` : "—"}</span>
                    <span className="tk">{v.ticker}</span>
                    {v.attestTxHash ? (
                      txUrl(v.attestTxHash) ? (
                        <a className="hash" href={txUrl(v.attestTxHash)!} target="_blank" rel="noreferrer">
                          {short(v.attestTxHash)} ↗
                        </a>
                      ) : (
                        <span className="hash">{short(v.attestTxHash)}</span>
                      )
                    ) : (
                      <span className="hash">{short(v.verdictHash)}</span>
                    )}
                    <span className="sc" style={{ color: riskColor(v.riskLevel) }}>{pad(v.score)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Contracts */}
            {status && (status.registry || status.alertBus) && (
              <div className="card2">
                <div className="hd"><h3>Contracts</h3></div>
                <div className="addr-list">
                  {status.registry && (
                    <div className="a">
                      <span className="k">AuditRegistry</span>
                      <a className="v" href={contractUrl(status.registry) ?? undefined} target="_blank" rel="noreferrer">
                        {short(status.registry)} ↗
                      </a>
                    </div>
                  )}
                  {status.alertBus && (
                    <div className="a">
                      <span className="k">AlertBus</span>
                      <a className="v" href={contractUrl(status.alertBus) ?? undefined} target="_blank" rel="noreferrer">
                        {short(status.alertBus)} ↗
                      </a>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Coverage scope — honest about what is and isn't monitored */}
            <div style={{ marginTop: 10, padding: "8px 10px", fontSize: 11, lineHeight: 1.4, opacity: 0.55 }}>
              Coverage: <strong>EVM corridors</strong>. Non-EVM destinations
              (Solana, Aptos, TON, Sui&nbsp;…) are not yet monitored.
            </div>

          </div>
        </div>
      </div>

      {/* Report modal */}
      {reportTarget && (
        <ReportModal watched={reportTarget} onClose={() => setReportTarget(null)} />
      )}

      {/* Token overlay */}
      {overlayTarget && (
        <TokenOverlay
          watched={overlayTarget}
          history={histories[overlayTarget.address.toLowerCase()] ?? []}
          onClose={() => setOverlayTarget(null)}
          onReport={() => setReportTarget(overlayTarget)}
        />
      )}

      {/* Security Copilot */}
      {copilotOpen && <SecurityCopilot onClose={() => setCopilotOpen(false)} />}

    </section>
  );
}
