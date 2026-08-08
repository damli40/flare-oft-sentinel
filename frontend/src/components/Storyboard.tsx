import { useEffect, useRef, useState } from "react";
import { getSentinelStatus } from "../api.ts";
import type { SentinelStatus, WatchedStatus } from "../api.ts";
import { setChainConfig, contractUrl, oftUrl } from "../explorer.ts";
import "../storyboard.css";

// This page explains what the build does. Two rules govern every line of it:
//
//  1. No invented figures. Every number comes from /status, which is computed
//     from live on-chain reads under a pinned rule set. The previous version
//     shipped "$13.7B secured", "36 OFTs", "181,815 messages", scores of 92 and
//     28, an "Attested(id: 1042)" event and a block height — none of them
//     measured, all of them presented as readings. A page that invents telemetry
//     is the exact defect this tool audits other people for.
//  2. No hardcoded chain names. The chain comes from /status like everywhere
//     else, so this file needs no entry in the chain guard's allowlist.
//
// Where a figure does not exist, the slot is cut rather than filled.

const DEMO_TICKER = "MOFT";

function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : String(n);
}

function bandClass(risk: string | null | undefined): string {
  if (risk === "CRITICAL") return "danger";
  if (risk === "AT_RISK") return "warn";
  if (risk === "PASS") return "ok";
  return "";
}

function bandLabel(risk: string | null | undefined): string {
  if (risk === "CRITICAL") return "● critical";
  if (risk === "AT_RISK") return "● at risk";
  if (risk === "PASS") return "● clean";
  return "● not yet read";
}

export function Storyboard({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<SentinelStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    getSentinelStatus()
      .then((s) => { setChainConfig(s); setStatus(s); })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) e.target.classList.add("show"); }),
      { threshold: 0.18, root }
    );
    root.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { io.disconnect(); window.removeEventListener("keydown", onKey); };
  }, [onClose, status]);

  const chainName = status?.chain?.name ?? null;
  const watched: WatchedStatus[] = status?.watched ?? [];
  const assessed = watched.filter((w) => w.assessment);
  const demo = watched.find((w) => w.ticker === DEMO_TICKER) ?? null;
  const breakdown = status?.msiBreakdown ?? null;

  // Ordered worst-first so the board leads with what needs attention.
  const rank: Record<string, number> = { CRITICAL: 0, AT_RISK: 1, PASS: 2 };
  const board = [...watched].sort(
    (a, b) =>
      (rank[a.assessment?.riskLevel ?? ""] ?? 3) - (rank[b.assessment?.riskLevel ?? ""] ?? 3) ||
      (a.assessment?.score ?? 101) - (b.assessment?.score ?? 101)
  );

  const unavailable = (
    <p className="lead">
      Live readings are unavailable right now, so this section is blank rather than filled with
      example values.
    </p>
  );

  return (
    <div className="story" ref={ref}>
      <button className="sb-back" onClick={onClose}>← Back to app</button>

      {/* HERO */}
      <header className="hero">
        <div className="radar"><span></span><span></span><span></span></div>
        <div className="wrap">
          <div className="badge">
            <span className="dot"></span> Flare Summer Signal 2026
          </div>
          <h1 className="grad">OFT Sentinel</h1>
          <p className="lead">
            A monitor that re-reads the live LayerZero configuration behind every OFT
            {chainName ? ` on ${chainName}` : ""}, scores it against a fixed rule set, and publishes a
            verdict anyone can recompute from the same inputs. No model sits in the verdict path.
          </p>
          <div className="statbar">
            <span><b>{watched.length || "—"}</b> OFTs watched</span>
            <span><b>{assessed.length || "—"}</b> assessed</span>
            <span><b>{status?.rulesVersion ?? "—"}</b> rule set</span>
          </div>
        </div>
        <div className="scroll-hint">scroll ↓</div>
      </header>

      {/* 01 — WHAT IT WATCHES */}
      <section>
        <div className="wrap reveal">
          <div className="num">01: THE FLEET</div>
          <h2>Coverage is the whole rail, not the busy part of it.</h2>
          <p className="lead">
            Two sources decide what gets watched. A traffic query supplies the OFTs moving real
            messages. Everything else is pinned by hand, because an activity threshold on its own
            leaves a live bridge unmonitored the moment it goes quiet — and a quiet bridge is exactly
            where a configuration change goes unnoticed.
          </p>
          <div className="dvn-row">
            <div className="dvn">from the traffic query · OFTs above the activity threshold</div>
            <div className="dvn">pinned by the operator · real volume, below that threshold</div>
          </div>
          <p className="lead">
            The demo token below is pinned for a third reason: it is ours, so the detection path can
            be shown end to end without touching anyone else's contract.
          </p>
        </div>
      </section>

      {/* 02 — WHAT A VERDICT IS */}
      <section>
        <div className="wrap reveal">
          <div className="num">02: THE VERDICT</div>
          <h2>A fixed rule set over a live read.</h2>
          <p className="lead">
            Each cycle reads the configuration straight off the endpoint — libraries, DVN sets,
            confirmations, peers — and runs one deterministic rule set over it. The same input always
            produces the same verdict, so the result can be recomputed by anyone holding the record
            rather than taken on trust.
          </p>

          <div className="pipe">
            <div className="node sentinel">
              <h3><span className="ico">📡</span> Read <span className="tag">on-chain</span></h3>
              <p>
                <code>getSendLibrary()</code>, <code>getReceiveLibrary()</code>,{" "}
                <code>getConfig()</code> and <code>peers()</code>, read across more than one RPC so
                a single endpoint cannot decide the answer alone.
              </p>
            </div>
            <div className="conn"></div>
            <div className="node">
              <h3><span className="ico">📐</span> Score <span className="tag">rules {status?.rulesVersion ?? "—"}</span></h3>
              <p>
                Deterministic checks only: library pinning, effective DVN count, dead or deprecated
                verifiers, peer symmetry, owner type. No language model contributes to the score.
              </p>
            </div>
            <div className="conn"></div>
            <div className="node attest">
              <h3><span className="ico">⛓️</span> Record <span className="tag" style={{ color: "var(--blue)", borderColor: "var(--blue)" }}>hash</span></h3>
              <p>
                The findings, score, rule version and the DVN table they were judged against are
                hashed into one record. The hash is what gets written; the record is what lets you
                recompute it.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 03 — THE BOARD */}
      <section>
        <div className="wrap reveal">
          <div className="num">03: THE BOARD</div>
          <h2>Every watched OFT, as it reads right now.</h2>
          <p className="lead">
            These are live values from this instance, not a snapshot pasted into the page. A clean
            result is the common case, and it is reported as plainly as a finding.
          </p>

          {failed || (!status && !failed) ? (
            unavailable
          ) : board.length === 0 ? (
            <p className="lead">The watchlist is empty on this instance.</p>
          ) : (
            <div className="board">
              <div className="brow head"><div>OFT</div><div>Score</div><div>Status</div><div>Corridors</div></div>
              {board.map((w) => {
                const url = oftUrl(w.chainId, w.address);
                return (
                  <div className="brow" key={`${w.chainId}:${w.address}`}>
                    <div className="sym">
                      {w.ticker}{" "}
                      <small>
                        {url ? (
                          <a href={url} target="_blank" rel="noreferrer">{w.address.slice(0, 6)}…{w.address.slice(-4)}</a>
                        ) : (
                          `${w.address.slice(0, 6)}…${w.address.slice(-4)}`
                        )}
                      </small>
                    </div>
                    <div className={`sc ${bandClass(w.assessment?.riskLevel)}`}>{pct(w.assessment?.score)}</div>
                    <div><span className={`st ${bandClass(w.assessment?.riskLevel)}`}>{bandLabel(w.assessment?.riskLevel)}</span></div>
                    <div>{w.corridors?.length ?? "—"}</div>
                  </div>
                );
              })}
            </div>
          )}

          {breakdown && (
            <div className="chips">
              <div className="chip">✅ <b>{breakdown.safe}</b> clean</div>
              <div className="chip">⚠️ <b>{breakdown.atRisk}</b> at risk</div>
              <div className="chip">🚨 <b>{breakdown.critical}</b> critical</div>
              <div className="chip">○ <b>{breakdown.unassessed}</b> not yet read</div>
            </div>
          )}
        </div>
      </section>

      {/* 04 — THE DEMO OFT */}
      <section>
        <div className="wrap reveal">
          <div className="num">04: THE DEMO TOKEN</div>
          <h2>An asset that is ours to break.</h2>
          <p className="lead">
            Showing detection on somebody else's token means either waiting for them to make a
            mistake or describing one they did not make. So we deployed our own OFT
            {chainName ? ` on ${chainName}` : ""} and left it on the endpoint's default configuration.
            It holds no value and nothing depends on it.
          </p>
          <p className="lead">
            Endpoint defaults are mutable by the protocol rather than pinned by the token, which is
            the property the rule set flags. Its live reading sits in the board above; the same rules
            that judge every other row judge this one.
          </p>
          {demo ? (
            <div className="block">
              <div className="line"><span className="k">ticker</span><span className="v">{demo.ticker}</span></div>
              <div className="line"><span className="k">address</span><span className="v">{demo.address}</span></div>
              <div className="line"><span className="k">score / risk</span>
                <span className="v">{pct(demo.assessment?.score)} · {demo.assessment?.riskLevel ?? "not yet read"}</span>
              </div>
              <div className="line"><span className="k">corridors read</span><span className="v">{demo.corridors?.length ?? "—"}</span></div>
            </div>
          ) : status ? (
            <p className="lead">The demo token is not on this instance's watchlist.</p>
          ) : (
            unavailable
          )}
        </div>
      </section>

      {/* 05 — THE RECORD */}
      <section>
        <div className="wrap reveal">
          <div className="num">05: THE RECORD</div>
          <h2>What actually gets written, and when.</h2>
          <p className="lead">
            A verdict is written to the registry when a configuration <em>changes</em>, or when it
            reads unsafe and stays that way. A clean cycle writes nothing — the registry is a record
            of findings and changes, not a certificate that everything is fine. Saying otherwise
            would be the same overstatement the rules exist to catch.
          </p>

          <div className="block">
            <div className="line"><span className="k">contract</span>
              <span className="v">
                {status?.registry
                  ? (contractUrl(status.registry)
                      ? <a href={contractUrl(status.registry)!} target="_blank" rel="noreferrer">AuditRegistry ↗</a>
                      : "AuditRegistry")
                  : "AuditRegistry"}
                {chainName ? ` · ${chainName}` : ""}
              </span>
            </div>
            <div className="line"><span className="k">records</span><span className="v">oft · chainId · verdictHash · score · risk · agentId · timestamp</span></div>
            <div className="line"><span className="k">verdictHash</span><span className="v">keccak256 of the decision record</span></div>
            <div className="line"><span className="k">rule set</span><span className="v">{status?.rulesVersion ?? "—"}, pinned inside the record</span></div>
          </div>

          <p className="lead">
            Because the rule version and the DVN table are pinned inside the record, a verdict can be
            recomputed later and compared against the hash. That is the whole claim: not that you
            should believe the score, but that you can check it.
          </p>
        </div>
      </section>

      <footer>
        <div className="wrap">
          OFT Sentinel · deterministic LayerZero config monitoring ·{" "}
          <a href="https://x.com/rookie_of_Ph" target="_blank" rel="noreferrer">@rookie_of_Ph</a><br />
          <span style={{ fontFamily: "var(--mono)", fontSize: "12px" }}>Flare Summer Signal · 2026</span>
        </div>
      </footer>
    </div>
  );
}
