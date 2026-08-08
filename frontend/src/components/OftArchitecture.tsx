import { useEffect, useRef } from "react";

/* ============================================================
   OFT SENTINEL — "Anatomy of a transfer"
   Interactive journey + live config sandbox.
   Ported from the Claude Design prototype (assets/oft-arch.js).
   The assess() scoring mirrors backend score.ts / drift.ts exactly:
   deductions CRIT -40 / HIGH -20 / MED -10 / LOW -5, clamp CRIT->25,
   AT_RISK->84, and the same per-config findings.
   ============================================================ */

interface Stop {
  id: string;
  n: number;
  label: string;
  cap?: string;
  layer: string;
  glyph: string;
  watched: boolean;
  ctl?: string;
  plain: string;
  detail: string;
  sev?: "crit" | "warn";
  watch?: string;
}

const STOPS: Stop[] = [
  { id: "src", n: 1, label: "Source OFT", cap: "SOURCE CHAIN", layer: "Application", glyph: "⊖", watched: false,
    plain: "The chain burns or locks your tokens here, taking them out of circulation.",
    detail: "The token contract you’re sending <b>from</b>. On send it <b>debits</b> your balance: a standard OFT <b>burns</b> the tokens, an OFT Adapter <b>locks</b> them (for wrapping a token that already exists). Either way they leave circulation here, so global supply stays constant." },

  { id: "sep", n: 2, label: "Source Endpoint", layer: "Protocol", glyph: "◉", watched: false,
    plain: "The universal mailbox: the same immutable contract on every chain.",
    detail: "The OFT calls <b>endpoint.send()</b>. This immutable, permissionless contract routes the message to the app’s configured <b>Send Library</b>, handles fees, and assigns a <b>nonce</b> so the message is delivered exactly once." },

  { id: "send", n: 3, label: "Send Library", layer: "Message Library", glyph: "✉", watched: true, ctl: "sendlib",
    plain: "Packages the message and stamps it with this token’s security rules.",
    detail: "<b>SendULN302.</b> Encodes the standardized <b>Packet</b>, computes fees, and enforces the send-side security config: which DVNs must verify, how many, the Executor, and how many block confirmations to wait. It’s immutable and append-only.",
    sev: "warn", watch: "A pinned library reverting to the <b>default</b> placeholder is a drift event. Sentinel flags an unpinned send library as <b>HIGH</b>, because the LZ Labs default can redirect messages." },

  { id: "dvn", n: 4, label: "DVN Security Stack", layer: "Workers", glyph: "◈", watched: true, ctl: "dvn",
    plain: "The verifiers. At 1-of-1, one compromised verifier can forge any transfer.",
    detail: "<b>Decentralized Verifier Networks</b> each confirm the message’s payloadHash is genuine, configured as <b>X-of-Y-of-N</b>. This is where cross-chain security lives. A <b>1-of-1</b> configuration means one verifier with no backup: anyone able to compromise that single verifier can forge a message the destination will accept, with nothing left to contradict it.<br><br><b>Block confirmations</b> live here too: DVNs wait for the source chain to finalize before attesting. Fewer confirmations means weaker finality.",
    sev: "crit", watch: "Sentinel’s first check. It reads the <b>required-DVN count</b> and threshold on every sweep. A count falling toward 1 rates <b>CRITICAL</b>. It also flags a drop in block confirmations." },

  { id: "exec", n: 5, label: "Executor", layer: "Workers", glyph: "▸", watched: false,
    plain: "Delivers the verified message and pays the gas for you. You don’t have to trust it.",
    detail: "It offers <b>Execution-as-a-Service</b>: once a message is verified, it calls <b>lzReceive()</b> on the destination and pays the destination gas (you pay in the source token). Execution is <b>permissionless</b>, so anyone can call <b>lzReceive()</b>. If the default Executor stalls, anyone else can execute the same message. It <b>can’t forge</b> messages, since verification is independent, and it <b>can’t block</b> them, since execution is open to everyone. So it isn’t a liveness chokepoint." },

  { id: "recv", n: 6, label: "Receive Library", layer: "Protocol · Msg Library", glyph: "◉", watched: true, ctl: "recvlib",
    plain: "The destination’s gatekeeper. Confirms enough verifiers signed off before accepting.",
    detail: "<b>ReceiveULN302</b> + destination Endpoint. Checks the DVN threshold is met (every required DVN verified), commits the nonce, and enforces that only the configured workers could have verified. <b>Critical rule:</b> the Send config on the source must mirror the Receive config here.",
    sev: "crit", watch: "A receive library reverting to <b>default bypasses DVN verification</b>. Sentinel rates that <b>CRITICAL</b>, because anything can then pass as verified." },

  { id: "dst", n: 7, label: "Destination OFT", cap: "DEST CHAIN", layer: "Application", glyph: "⊕", watched: false,
    plain: "Your tokens reappear for the recipient, minted or unlocked.",
    detail: "The token contract you’re sending <b>to</b>. It <b>credits</b> the recipient: a standard OFT <b>mints</b> the same amount that was burned on the source, an Adapter <b>unlocks</b> it. Optional <b>lzCompose</b> can trigger follow-up logic. Same amount out, same amount in, one global supply." },
];

interface Cfg { dvn: number; owner: "eoa" | "multisig"; sendlib: "pinned" | "default"; recvlib: "pinned" | "default"; confs: number; }
const SEED: Cfg = { dvn: 2, owner: "multisig", sendlib: "pinned", recvlib: "pinned", confs: 32 };

type Sev = "crit" | "high" | "med" | "low";
const DEDUCT: Record<Sev, number> = { crit: 40, high: 20, med: 10, low: 5 };
const SEVLABEL: Record<string, string> = { crit: "CRITICAL", high: "HIGH", med: "MEDIUM", low: "LOW", pass: "PASS" };

interface Finding { sev: Sev; text: string; }
interface Assessment { score: number; lvl: "crit" | "warn" | "safe"; findings: Finding[]; }

function assess(c: Cfg): Assessment {
  const f: Finding[] = [];
  if (c.dvn <= 1) f.push({ sev: "crit", text: "<b>Single DVN (1-of-1).</b> One compromised verifier can forge any transfer, with no second attestation to contradict it." });
  else if (c.dvn === 2) f.push({ sev: "med", text: "<b>2 required DVNs.</b> Minimal redundancy, one step above the 1-of-1 danger line." });
  if (c.sendlib === "default") f.push({ sev: "high", text: "<b>Send library unpinned.</b> Reverted to the LZ Labs default placeholder, which can redirect messages." });
  if (c.recvlib === "default") f.push({ sev: "crit", text: "<b>Receive library unpinned.</b> The default bypasses DVN verification, so anything can pass as verified." });
  if (c.owner === "eoa") f.push({ sev: "high", text: "<b>Owner is a single EOA key.</b> One compromised key can rewrite the whole security stack." });
  if (c.confs < 15) f.push({ sev: "med", text: "<b>Block confirmations below 15.</b> Verifiers attest before the chain finalizes, weakening finality." });

  let score = 100;
  f.forEach((x) => { score -= DEDUCT[x.sev] || 0; });
  score = Math.max(0, score);

  const hasCrit = f.some((x) => x.sev === "crit");
  const hasMid = f.some((x) => x.sev === "high" || x.sev === "med");
  let lvl: Assessment["lvl"];
  if (hasCrit) { lvl = "crit"; score = Math.min(score, 25); }
  else if (hasMid) { lvl = "warn"; score = Math.min(score, 84); }
  else { lvl = "safe"; }

  f.sort((a, b) => (DEDUCT[b.sev] || 0) - (DEDUCT[a.sev] || 0));
  return { score, lvl, findings: f };
}

function riskColor(lvl: string): string {
  return lvl === "crit" ? "#FF4D5E" : lvl === "warn" ? "#FFB23E" : "#34D27D";
}

function ringSvg(score: number, color: string): string {
  const r = 58, c = 2 * Math.PI * r, off = c * (1 - score / 100);
  return '<svg width="132" height="132" viewBox="0 0 132 132">' +
    '<circle cx="66" cy="66" r="' + r + '" fill="none" stroke="#1A2029" stroke-width="9"/>' +
    '<circle cx="66" cy="66" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="9" stroke-linecap="round" ' +
    'stroke-dasharray="' + c + '" stroke-dashoffset="' + off + '" transform="rotate(-90 66 66)" ' +
    'style="transition:stroke-dashoffset 1s cubic-bezier(.4,0,.2,1);filter:drop-shadow(0 0 6px ' + color + '66)"/></svg>';
}

export function OftArchitecture() {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const $ = (id: string) => root.querySelector<HTMLElement>("#" + id);

    // Track listeners on persistent (JSX-rendered) elements so cleanup can
    // remove them — StrictMode double-invokes the effect, and these elements
    // survive between invocations, so re-adding would double-fire.
    const offs: Array<() => void> = [];
    const on = (el: EventTarget, type: string, fn: EventListenerOrEventListenerObject) => {
      el.addEventListener(type, fn);
      offs.push(() => el.removeEventListener(type, fn));
    };

    let cfg: Cfg = { ...SEED };

    const track = $("archTrack")!;
    const panel = $("archPanel")!;
    const ringEl = $("asRing")!;
    const findEl = $("asFindings")!;
    const badgeEl = $("asBadge")!;
    const vsubEl = $("asVsub")!;

    let token: HTMLElement;
    let nodes: HTMLButtonElement[] = [];
    let active = -1;
    let playing = false;
    let playTimer: ReturnType<typeof setTimeout> | null = null;
    let io: IntersectionObserver | null = null;

    const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* ---------- build journey nodes ---------- */
    function buildNodes() {
      track.innerHTML = '<div class="arch-line"></div><div class="arch-token" id="archToken"></div>';
      token = track.querySelector<HTMLElement>("#archToken")!;
      nodes = STOPS.map((s, i) => {
        const b = document.createElement("button");
        b.className = "arch-node" + (s.watched ? " watched" : "") + (s.id === "dvn" ? " crit" : "");
        b.setAttribute("aria-label", "Step " + s.n + ": " + s.label + (s.watched ? ", watched by Sentinel" : ""));
        b.innerHTML =
          '<span class="arch-circ">' + s.glyph +
            (s.watched ? '<span class="arch-eye" title="Watched by Sentinel">👁</span>' : "") +
          "</span>" +
          '<span class="arch-ntext">' +
            '<span class="arch-nlabel">' + s.label + "</span>" +
            '<span class="arch-nlayer">' + s.layer + "</span>" +
            (s.cap ? '<span class="arch-cap">' + s.cap + "</span>" : "") +
          "</span>";
        b.addEventListener("click", () => { pause(); setActive(i); });
        track.appendChild(b);
        return b;
      });
    }

    /* ---------- token positioning ---------- */
    function positionToken(i: number) {
      if (i < 0 || !nodes[i]) return;
      const circ = nodes[i].querySelector<HTMLElement>(".arch-circ")!;
      const tr = track.getBoundingClientRect();
      const cr = circ.getBoundingClientRect();
      const x = cr.left - tr.left + cr.width / 2 - token.offsetWidth / 2;
      const y = cr.top - tr.top + cr.height / 2 - token.offsetHeight / 2;
      token.classList.add("live");
      token.style.left = x + "px";
      token.style.top = y + "px";
    }

    /* ---------- active node + panel ---------- */
    function setActive(i: number) {
      active = i;
      nodes.forEach((n, k) => { n.classList.toggle("active", k === i); });
      positionToken(i);
      renderPanel(i);
      updateProgress();
    }

    function renderPanel(i: number) {
      const s = STOPS[i];
      const watchClass = s.watched ? (s.sev === "crit" ? "crit" : "warn") : "";
      let html =
        '<div class="ap-head">' +
          '<span class="ap-num">' + String(s.n).padStart(2, "0") + "</span>" +
          '<span class="ap-layer">' + s.layer + "</span>" +
          (s.watched ? '<span class="ap-watch">👁 Watched by Sentinel</span>' : "") +
        "</div>" +
        '<h3 class="ap-title">' + s.label + "</h3>" +
        '<p class="ap-plain">' + s.plain + "</p>" +
        '<p class="ap-detail">' + s.detail + "</p>";
      if (s.watched) {
        html +=
          '<div class="ap-sentinel ' + watchClass + '">' +
            '<div class="sh">◉ What Sentinel checks here</div>' +
            "<p>" + s.watch + "</p>" +
            (s.ctl ? '<span class="tweak-hint" data-ctl="' + s.ctl + '">▸ Mutate this in the live config →</span>' : "") +
          "</div>";
      }
      panel.className = "arch-panel card";
      panel.innerHTML = html;
      const hint = panel.querySelector<HTMLElement>(".tweak-hint");
      if (hint) hint.addEventListener("click", () => flashControl(hint.getAttribute("data-ctl")!));
    }

    function showEmptyPanel() {
      panel.className = "arch-panel card empty";
      panel.innerHTML = '<div class="ph">Click any step, or press <span class="em">▶ Play transfer</span> to watch a token travel the full path from source to destination.</div>';
    }

    /* ---------- progress segments ---------- */
    function updateProgress() {
      root!.querySelectorAll<HTMLElement>("#archProgress .seg").forEach((seg, k) => {
        seg.classList.toggle("on", k <= active);
      });
    }

    /* ---------- playback ---------- */
    function play() {
      if (reduced()) { setActive(active < 0 ? 0 : Math.min(active + 1, STOPS.length - 1)); return; }
      playing = true;
      const p = $("archPlay")!;
      p.innerHTML = "⏸ Pause";
      p.classList.remove("play");
      if (active < 0 || active >= STOPS.length - 1) setActive(0); else setActive(active);
      scheduleNext();
    }
    function scheduleNext() {
      if (playTimer) clearTimeout(playTimer);
      playTimer = setTimeout(() => {
        if (!playing) return;
        if (active >= STOPS.length - 1) { pause(); return; }
        setActive(active + 1);
        scheduleNext();
      }, 1900);
    }
    function pause() {
      playing = false;
      if (playTimer) clearTimeout(playTimer);
      const p = $("archPlay");
      if (p) { p.innerHTML = "▶ Play transfer"; p.classList.add("play"); }
    }
    function step(dir: number) {
      pause();
      let i = active < 0 ? 0 : active + dir;
      i = Math.max(0, Math.min(STOPS.length - 1, i));
      setActive(i);
    }

    /* ---------- sandbox rendering ---------- */
    function renderScore() {
      const r = assess(cfg);
      const color = riskColor(r.lvl);

      ringEl.innerHTML = ringSvg(r.score, color) +
        '<div class="scoretxt"><div class="v" style="color:' + color + '">' + String(r.score).padStart(2, "0") + '</div><div class="m">RISK SCORE</div></div>';
      ringEl.classList.toggle("crit-breathe", r.lvl === "crit");

      const bClass = r.lvl === "crit" ? "s-crit" : r.lvl === "warn" ? "s-warn" : "s-safe";
      badgeEl.className = "as-badge " + bClass;
      badgeEl.innerHTML = '<span class="d"></span>' + (r.lvl === "crit" ? "CRITICAL" : r.lvl === "warn" ? "AT RISK" : "SAFE");
      vsubEl.textContent = r.lvl === "crit"
        ? "This config is exploitable. Sentinel would attest CRITICAL and fire an on-chain alert."
        : r.lvl === "warn"
        ? "Functional, but drifting from the 2-of-2 baseline. Sentinel rechecks it on every sweep."
        : "Meets the security baseline. No findings on the monitored config.";

      if (r.findings.length === 0) {
        findEl.innerHTML = '<div class="as-finding pass"><span class="fsev">PASS</span><span class="fdot"></span><span><b>All monitored config healthy.</b> Multi-DVN threshold, both libraries pinned, multisig owner.</span></div>';
      } else {
        findEl.innerHTML = r.findings.map((x) => {
          const cls = x.sev === "crit" ? "crit" : (x.sev === "high" || x.sev === "med") ? "high" : "low";
          return '<div class="as-finding ' + cls + '"><span class="fsev">' + SEVLABEL[x.sev] + '</span><span class="fdot"></span><span>' + x.text + "</span></div>";
        }).join("");
      }

      syncControlUI();
    }

    /* ---------- controls ---------- */
    function syncControlUI() {
      $("asDvnNum")!.textContent = String(cfg.dvn);
      $("asDvnVal")!.textContent = cfg.dvn + "-of-" + cfg.dvn + " required DVNs";
      ($("asDvnMinus") as HTMLButtonElement).disabled = cfg.dvn <= 1;
      ($("asDvnPlus") as HTMLButtonElement).disabled = cfg.dvn >= 5;
      setToggle("sendlib", cfg.sendlib);
      setToggle("recvlib", cfg.recvlib);
      const chip = $("archOwner")!;
      chip.className = "arch-owner " + cfg.owner;
      chip.querySelector<HTMLElement>(".ow-val")!.textContent = cfg.owner === "eoa" ? "EOA" : "Multisig";
      const cv = $("asConfVal")!;
      cv.textContent = cfg.confs + " blk";
      cv.classList.toggle("warn", cfg.confs < 15);
      ($("asConfSlider") as HTMLInputElement).value = String(cfg.confs);
    }
    function setToggle(name: string, val: string) {
      root!.querySelectorAll<HTMLButtonElement>('[data-toggle="' + name + '"] button').forEach((b) => {
        b.classList.toggle("on", b.getAttribute("data-val") === val);
      });
    }

    function flashControl(ctl: string) {
      const map: Record<string, string> = { dvn: "asCtlDvn", sendlib: "asCtlSend", recvlib: "asCtlRecv", confs: "asCtlConf" };
      const el = ctl === "owner" ? $("archOwner") : $(map[ctl]);
      if (!el) return;
      const cls = ctl === "owner" ? "watch-flash" : "flash";
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), 1100);
    }

    function setCfg(patch: Partial<Cfg>) {
      Object.assign(cfg, patch);
      renderScore();
    }

    function wireControls() {
      on($("asDvnMinus")!, "click", () => { if (cfg.dvn > 1) setCfg({ dvn: cfg.dvn - 1 }); });
      on($("asDvnPlus")!, "click", () => { if (cfg.dvn < 5) setCfg({ dvn: cfg.dvn + 1 }); });

      root!.querySelectorAll<HTMLButtonElement>("[data-toggle] button").forEach((b) => {
        on(b, "click", () => {
          const name = b.parentElement!.getAttribute("data-toggle")!;
          setCfg({ [name]: b.getAttribute("data-val") } as Partial<Cfg>);
        });
      });

      on($("archOwner")!, "click", () => {
        setCfg({ owner: cfg.owner === "eoa" ? "multisig" : "eoa" });
      });

      on($("asConfSlider")!, "input", (e) => {
        setCfg({ confs: parseInt((e.target as HTMLInputElement).value, 10) });
      });

      on($("asPresetHealthy")!, "click", () => {
        cfg = { dvn: 3, owner: "multisig", sendlib: "pinned", recvlib: "pinned", confs: 32 };
        renderScore();
      });
    }

    /* ---------- visibility ---------- */
    function observe() {
      if (!("IntersectionObserver" in window)) return;
      io = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (!e.isIntersecting && playing) pause(); });
      }, { threshold: 0.12 });
      io.observe(root!);
    }

    /* ---------- init ---------- */
    const onResize = () => { if (active >= 0) positionToken(active); };

    buildNodes();
    showEmptyPanel();
    wireControls();
    renderScore();
    syncControlUI();

    on($("archPlay")!, "click", () => { playing ? pause() : play(); });
    on($("archPrev")!, "click", () => step(-1));
    on($("archNext")!, "click", () => step(1));
    on(window, "resize", onResize);
    observe();

    /* ---------- cleanup (StrictMode-safe) ---------- */
    return () => {
      if (playTimer) clearTimeout(playTimer);
      if (io) io.disconnect();
      offs.forEach((off) => off());
      track.innerHTML = "";
    };
  }, []);

  return (
    <section className="arch" id="archSec" ref={rootRef}>
      <div className="sec-title" style={{ marginTop: 64 }}>
        <h2>What happens when an OFT moves</h2>
        <div className="meta">ANATOMY OF A TRANSFER</div>
      </div>
      <p className="arch-lead">
        An <b>Omnichain Fungible Token</b> holds one global supply that <b>moves</b> between chains instead of pooling in a bridge
        contract: the source chain burns or locks your tokens, the destination mints or unlocks them. Each transfer&rsquo;s safety
        depends on <b>configuration the token team picks</b>, and that configuration drifts after launch. Sentinel watches it.
      </p>
      <div className="arch-oneliners">
        <span className="ol"><span className="dot"></span><b>One token</b>, one global supply, many chains</span>
        <span className="ol"><span className="dot"></span>Supply <b>moves</b> between chains, never copied</span>
        <span className="ol"><span className="dot"></span>Safety = <b>config</b>, and config drifts</span>
      </div>

      <div className="arch-stage card">
        <div className="arch-toolbar">
          <button className="arch-tbtn play" id="archPlay">&#x25B6; Play transfer</button>
          <button className="arch-tbtn icon" id="archPrev" aria-label="Previous step">&#x25C0;</button>
          <button className="arch-tbtn icon" id="archNext" aria-label="Next step">&#x25B6;</button>
          <div className="arch-progress" id="archProgress">
            <span className="seg"></span><span className="seg"></span><span className="seg"></span><span className="seg"></span><span className="seg"></span><span className="seg"></span><span className="seg"></span>
          </div>
          <div className="arch-spacer"></div>
          <button className="arch-owner multisig" id="archOwner" aria-label="Toggle owner between EOA and multisig">
            <span className="ow-key">&#x1F511; Who can change this?</span><span className="ow-val">Multisig</span>
          </button>
        </div>
        <div className="arch-track-wrap">
          <div className="arch-track" id="archTrack"></div>
        </div>
      </div>

      <div className="arch-grid">
        <div className="arch-panel card empty" id="archPanel" aria-live="polite"></div>

        <div className="arch-sandbox card">
          <div className="as-head">
            <h3>Live security config</h3>
            <span className="tag">same engine as the dashboard</span>
          </div>
          <div className="as-score">
            <div className="as-ring" id="asRing"></div>
            <div className="as-verdict">
              <span className="as-badge s-warn" id="asBadge"><span className="d"></span>AT RISK</span>
              <div className="vsub" id="asVsub"></div>
            </div>
          </div>
          <div className="as-findings" id="asFindings"></div>
          <div className="as-ctls-lbl">Change the config and the score recomputes live</div>

          <div className="as-ctl" id="asCtlDvn">
            <div className="cinfo"><div className="cname">DVN verifiers <span className="eye">&#x1F441;</span></div><div className="cval" id="asDvnVal">2-of-2 required DVNs</div></div>
            <div className="as-step"><button id="asDvnMinus" aria-label="Remove DVN">&minus;</button><span className="num" id="asDvnNum">2</span><button id="asDvnPlus" aria-label="Add DVN">+</button></div>
          </div>

          <div className="as-ctl" id="asCtlSend">
            <div className="cinfo"><div className="cname">Send library <span className="eye">&#x1F441;</span></div><div className="cval">pin a custom library, or revert to default</div></div>
            <div className="as-toggle" data-toggle="sendlib"><button data-val="pinned" className="on">Pinned</button><button data-val="default">Default</button></div>
          </div>

          <div className="as-ctl" id="asCtlRecv">
            <div className="cinfo"><div className="cname">Receive library <span className="eye">&#x1F441;</span></div><div className="cval">default bypasses verification</div></div>
            <div className="as-toggle danger" data-toggle="recvlib"><button data-val="pinned" className="on">Pinned</button><button data-val="default">Default</button></div>
          </div>

          <div className="as-ctl slider" id="asCtlConf">
            <div className="crow">
              <div className="cinfo"><div className="cname">Block confirmations <span className="eye">&#x1F441;</span></div><div className="cval">verifiers wait for source-chain finality</div></div>
              <span className="as-confval" id="asConfVal">32 blk</span>
            </div>
            <input type="range" className="as-slider" id="asConfSlider" min={1} max={64} defaultValue={32} aria-label="Block confirmations" />
          </div>

          <div className="as-presets">
            <button className="as-preset healthy" id="asPresetHealthy">&#x2714; Reset to a healthy config</button>
          </div>
        </div>
      </div>
    </section>
  );
}
