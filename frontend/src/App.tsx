import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { Aperture } from "./components/Aperture.tsx";
import { Storyboard } from "./components/Storyboard.tsx";
import { FleetBoard } from "./components/FleetBoard.tsx";
import { SentinelDashboard } from "./components/SentinelDashboard.tsx";
import { FlowAnimation } from "./components/FlowAnimation.tsx";
import { OftArchitecture } from "./components/OftArchitecture.tsx";
import { getMantleOfts, getSentinelStatus } from "./api.ts";
import type { MantleOft, SentinelStatus, WatchedChain } from "./api.ts";
import "./landing.css";
import "./architecture.css";

type View = "app" | "story" | "sentinel";

function pad(n: number) { return String(Math.round(n)).padStart(2, "0"); }

// Chain names come ONLY from /status `chains` (the backend chain registry).
// Never hardcode a chain name in frontend copy — adding a chain on the backend
// must update every mention here automatically.
function watchedChains(status: SentinelStatus | null): WatchedChain[] {
  if (!status) return [];
  if (status.chains?.length) return status.chains;
  // older backend: derive from the fleet, id-only names
  const counts = new Map<number, number>();
  status.watched.forEach(w => counts.set(w.chainId, (counts.get(w.chainId) ?? 0) + 1));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([chainId, count]) => ({ chainId, chainKey: null, name: `Chain ${chainId}`, count }));
}

/** "Ethereum, Base, and Mantle" — for prose; null until status loads. */
function chainProse(chains: WatchedChain[]): string | null {
  if (chains.length === 0) return null;
  const names = chains.map(c => c.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// Radar blips (decorative): [level, ring radius % of ringset, angle°] — placed
// ON the orbit rings (radii 44/33/22 = half the 88/66/44% ring diameters) so
// they stay on the rings at any card size or aspect ratio.
const BLIPS: [string, number, number][] = [
  ["crit", 44, 205], ["crit", 33, 55], ["crit", 22, 290],
  ["warn", 44, 100], ["warn", 33, 250], ["warn", 22, 150],
  ["safe", 44, 335], ["safe", 33, 20],
];

function blipColor(l: string) {
  if (l === "crit") return "#FF4D5E";
  if (l === "warn") return "#FFB23E";
  return "#34D27D";
}

function RadarCard() {
  return (
    <div className="radar-card">
      <div className="ringset">
        {[88, 66, 44, 22].map(p => (
          <div key={p} className="ring" style={{ width: `${p}%`, height: `${p}%` }} />
        ))}
        <div className="sweep" />
        {BLIPS.map(([lvl, r, deg], i) => {
          const size = lvl === "crit" ? 9 : lvl === "warn" ? 7 : 5;
          const color = blipColor(lvl);
          const rad = (deg * Math.PI) / 180;
          return (
            <div
              key={i}
              className="radar-blip"
              style={{
                left: `${50 + r * Math.cos(rad)}%`,
                top: `${50 + r * Math.sin(rad)}%`,
                transform: "translate(-50%, -50%)",
                width: size, height: size,
                background: color,
                boxShadow: `0 0 ${lvl === "crit" ? 10 : 5}px ${color}`,
                animation: `live-pulse ${1.4 + i * 0.2}s infinite`,
              }}
            />
          );
        })}
        <Aperture size={64} spin />
      </div>
    </div>
  );
}

interface HeroProps {
  ofts: MantleOft[] | null;
  status: SentinelStatus | null;
  onSentinel: () => void;
  onFleet: () => void;
}

function HeroSection({ ofts, status, onSentinel, onFleet }: HeroProps) {
  const chains = watchedChains(status);
  const prose = chainProse(chains);
  const oftsWatched = status?.watched.length ?? ofts?.length ?? 0;
  const criticals = status?.watched.filter(w => w.assessment?.riskLevel === "CRITICAL").length ?? 0;
  const lastPollMs = status?.watched.reduce((m, w) => Math.max(m, w.lastSnapshotAt ?? 0), 0) ?? 0;

  // tick "last poll" every second via DOM — no re-render
  const lastPollRef = useRef(lastPollMs);
  lastPollRef.current = lastPollMs;
  useEffect(() => {
    const id = setInterval(() => {
      const el = document.getElementById("s-last");
      if (el) el.textContent = lastPollRef.current ? ago(lastPollRef.current) : "-";
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="hero">
      <div className="hero-copy">
        <span className="kicker">
          <span className="live-dot" style={{ background: "var(--scan)", boxShadow: "0 0 8px var(--scan)" }} />
          AUTONOMOUS OFT SECURITY · {chains.length ? chains.map(c => c.name).join(" · ").toUpperCase() : "MULTI-CHAIN"}
        </span>
        <h1>
          Configurable trust,<br />
          continuously <span className="grad">proven.</span>
        </h1>
        <p className="lede">
          LayerZero lets every token pick its own verifiers, thresholds, and libraries,
          <b> the most flexible security model in crypto</b>. <b>OFT Sentinel</b> reads that config
          live across {prose ?? "every chain it watches"} every hour, and writes a signed on-chain
          record when a config drifts or reads unsafe.
        </p>
        <div className="cta-row">
          <button className="btn btn-primary" onClick={onSentinel}>
            Open the live Sentinel →
          </button>
          <button className="btn btn-ghost" onClick={onFleet}>
            See the fleet
          </button>
        </div>
        <a
          className="btn btn-ghost cta-telegram"
          href="https://t.me/oft_sentinel_watcher"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M21.9 4.1c.2-.9-.6-1.6-1.5-1.3L2.7 9.6c-1 .4-.9 1.8 0 2.1l4.5 1.4 1.7 5.4c.3.9 1.4 1.1 2 .5l2.5-2.4 4.6 3.4c.8.6 1.9.2 2.1-.8l1.8-15.1zM8.2 12.6l9.6-6-7.5 7-.3 3-1.8-4z" />
          </svg>
          Get live alerts on Telegram
        </a>
        <div className="live-strip">
          <div className="stat">
            <div className="v tnum" id="s-chains">{chains.length || "-"}</div>
            <div className="l">CHAINS</div>
          </div>
          <div className="stat">
            <div className="v tnum" id="s-ofts">{oftsWatched || "-"}</div>
            <div className="l">OFTs WATCHED</div>
          </div>
          <div className="stat">
            <div className="v tnum" id="s-crit" style={{ color: "var(--critical)" }}>
              {status ? String(criticals) : "-"}
            </div>
            <div className="l">CRITICAL NOW</div>
          </div>
          <div className="stat">
            <div className="v tnum" id="s-last" style={{ color: "var(--scan)" }}>
              {lastPollMs ? ago(lastPollMs) : "-"}
            </div>
            <div className="l">LAST SWEEP</div>
          </div>
        </div>
      </div>
      <RadarCard />
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("app");
  const [ofts, setOfts] = useState<MantleOft[] | null>(null);
  const [status, setStatus] = useState<SentinelStatus | null>(null);

  useEffect(() => {
    getMantleOfts()
      .then(r => setOfts(r.ofts))
      .catch(() => {}); // volume column simply stays empty if Dune is down
    getSentinelStatus()
      .then(setStatus)
      .catch(() => {}); // silent fail if backend is not running
  }, []);

  // land at the top whenever the view changes — instant (bypass the global
  // scroll-behavior:smooth)
  useLayoutEffect(() => { window.scrollTo({ top: 0, behavior: "instant" }); }, [view]);

  function scrollToFleet() {
    const el = document.getElementById("boardSec");
    if (el) window.scrollTo({ top: el.offsetTop - 70, behavior: "smooth" });
  }

  const chains = watchedChains(status);
  const prose = chainProse(chains);

  if (view === "story") return <Storyboard onClose={() => setView("app")} />;

  if (view === "sentinel") {
    return (
      <div className="app">
        <Header view="sentinel" onNav={v => { setView(v as View); window.scrollTo(0, 0); }} oftCount={status?.watched.length} />
        <SentinelDashboard />
      </div>
    );
  }

  return (
    <div className="app">
      <Header view="app" onNav={v => { setView(v as View); window.scrollTo(0, 0); }} oftCount={status?.watched.length} />

      <section id="view-home" className="view on">
        <div className="page">
          <HeroSection
            ofts={ofts}
            status={status}
            onSentinel={() => setView("sentinel")}
            onFleet={scrollToFleet}
          />

          <div className="props">
            <div className="prop">
              <div className="ic">📡</div>
              <h3>Live monitoring</h3>
              <p>
                Every{" "}
                <span className="tip">
                  OFT
                  <span className="tipbox"><b>OFT</b>: a token that can move across multiple blockchains via LayerZero.</span>
                </span>
                {" "}on {prose ?? "every watched chain"}, re-checked every hour. The agent reads each bridge's live on-chain config and looks for dangerous drift.
              </p>
              <div className="metric">
                {status ? `${status.watched.length} OFTs · ${chains.length} chains · hourly` : "watching the fleet · hourly"}
              </div>
            </div>
            <div className="prop">
              <div className="ic">⛓️</div>
              <h3>On-chain proof</h3>
              <p>
                When a config drifts or reads unsafe, the verdict is written as an{" "}
                <span className="tip">
                  attestation
                  <span className="tipbox"><b>Attestation</b>: a cryptographic receipt written permanently to the blockchain.</span>
                </span>
                {" "}to a smart contract{status?.chain?.name ? ` on ${status.chain.name}` : ""}, a permanent
                verifiable record anyone can audit.
              </p>
              <div className="metric">AuditRegistry{status?.chain?.name ? ` · ${status.chain.name}` : ""}</div>
            </div>
            <div className="prop">
              <div className="ic">📄</div>
              <h3>AI security reports</h3>
              <p>
                Download a full, plain-language audit for any bridge: an AI-written narrative plus deterministic{" "}
                <span className="tip">
                  DVN
                  <span className="tipbox"><b>DVN</b>: the security checker that verifies each cross-chain message is real.</span>
                </span>
                {" "}tables. Free, instant.
              </p>
              <div className="metric">DeepSeek narrative + config tables</div>
            </div>
          </div>

          <FlowAnimation />

          <OftArchitecture />

          <div className="sec-title" id="boardSec">
            <h2>The fleet</h2>
            <div className="meta">LIVE SENTINEL STATUS · BY CHAIN</div>
          </div>

          <FleetBoard status={status?.watched} chains={status?.chains} ofts={ofts} />

          <div className="cta-band">
            <div>
              <h2>Don't see your chain or token?</h2>
              <p>
                Sentinel adds chains and OFTs on request. Reach out and we'll put your
                bridge config on watch, with hourly checks and a signed on-chain record
                of what changes.
              </p>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <a
                className="btn btn-primary"
                style={{ textDecoration: "none" }}
                href="https://x.com/rookie_of_Ph"
                target="_blank"
                rel="noopener noreferrer"
              >
                DM on X →
              </a>
              <a
                className="btn btn-ghost"
                style={{ textDecoration: "none" }}
                href="https://t.me/damitheG"
                target="_blank"
                rel="noopener noreferrer"
              >
                Message on Telegram →
              </a>
            </div>
          </div>

          <footer className="foot">
            <div>OFT Sentinel · Autonomous security for LayerZero OFTs{chains.length ? ` · ${chains.map(c => c.name).join(" · ")}` : ""}</div>
            <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
              <button
                onClick={() => setView("story")}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--faint)", fontSize: 12.5, fontFamily: "var(--mono)" }}
              >
                How it works ↗
              </button>
              <span>Flare Summer Signal · 2026</span>
            </div>
          </footer>
        </div>
      </section>
    </div>
  );
}

// ── Shared header ─────────────────────────────────────────────────────────────

function Header({ view, onNav, oftCount }: { view: View; onNav: (v: string) => void; oftCount?: number }) {
  return (
    <header className="appbar">
      <div className="brand" onClick={() => onNav("app")} style={{ cursor: "pointer" }}>
        <Aperture size={26} spin />
        <span className="wm">
          <span className="lite">OFT</span> SENTINEL
        </span>
      </div>
      <nav className="nav">
        <button
          id="nav-home"
          className={view === "app" ? "on" : ""}
          onClick={() => onNav("app")}
        >
          Overview
        </button>
        <button
          id="nav-sentinel"
          className={view === "sentinel" ? "on" : ""}
          onClick={() => onNav("sentinel")}
        >
          Sentinel
        </button>
      </nav>
      <div className="spacer" />
      <div className="status-chip">
        <span className="live-dot" />
        <span id="hdrStatus">{oftCount ? `SENTINEL ACTIVE · ${oftCount} OFTs` : "SENTINEL ACTIVE"}</span>
      </div>
      <button className="btn btn-primary btn-sm appbar-cta" onClick={() => onNav("sentinel")}>
        Open the Sentinel →
      </button>
    </header>
  );
}
