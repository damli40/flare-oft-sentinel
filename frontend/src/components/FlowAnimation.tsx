import { useEffect, useRef } from "react";

const CHAINS = [
  { abbr: "ETH",  col: "#627EEA" },
  { abbr: "ARB",  col: "#28A0F0" },
  { abbr: "BASE", col: "#0052FF" },
  { abbr: "OP",   col: "#FF0420" },
  { abbr: "BNB",  col: "#F3BA2F" },
];
const SCAN = "#5BE7F0", SAFE = "#34D27D", CRIT = "#FF4D5E";

interface Pkt {
  ci: number; bad: boolean; phase: number; t: number;
  spd: number; sy: number; col: string;
}

export function FlowAnimation() {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;

    const canv = document.createElement("canvas");
    canv.style.cssText = "display:block;width:100%;height:100%;";
    el.appendChild(canv);

    let W = 0, H = 0, ctx: CanvasRenderingContext2D | null = null;
    let rafId = 0;
    let pkts: Pkt[] = [], frame = 0;
    let spawnCd = 30, driftCd = 380 + Math.floor(Math.random() * 200);
    let dvnFlash = 0, dvnBad = false;
    let alertA = 0, alertFading = false;
    let alertTimer: ReturnType<typeof setTimeout> | null = null;

    function resize() {
      const r = canv.parentElement!.getBoundingClientRect();
      W = r.width; H = r.height || 280;
      const dpr = window.devicePixelRatio || 1;
      canv.width  = W * dpr;
      canv.height = H * dpr;
      ctx = canv.getContext("2d");
      ctx?.scale(dpr, dpr);
    }

    const LX = () => W * 0.13;
    const DX = () => W * 0.50;
    const MX = () => W * 0.87;
    const CY = () => H * 0.50;
    const SP = () => Math.min(50, H / 5.8);
    const CR = () => Math.max(18, Math.min(24, H * 0.085));
    const DR = () => Math.max(34, Math.min(44, H * 0.155));
    const MR = () => Math.max(26, Math.min(34, H * 0.12));
    const CHY = (i: number) => CY() + (i - 2) * SP();

    function spawn(ci: number, bad: boolean) {
      pkts.push({ ci, bad, phase: 0, t: 0, spd: 0.008 + Math.random() * 0.005, sy: CHY(ci), col: bad ? CRIT : CHAINS[ci].col });
    }

    function quad(t: number, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number) {
      const m = 1 - t;
      return { x: m*m*x0 + 2*m*t*cx + t*t*x1, y: m*m*y0 + 2*m*t*cy + t*t*y1 };
    }

    function ppos(p: Pkt) {
      if (p.phase === 0) {
        const mx = (LX() + DX()) / 2, my = (p.sy + CY()) / 2;
        return quad(p.t, LX() + CR(), p.sy, mx, my, DX() - DR(), CY());
      }
      return { x: DX() + DR() + (MX() - MR() - DX() - DR()) * p.t, y: CY() };
    }

    function tick() {
      frame++;
      if (--spawnCd <= 0) {
        spawn(Math.floor(Math.random() * CHAINS.length), false);
        spawnCd = 40 + Math.floor(Math.random() * 22);
      }
      if (--driftCd <= 0) {
        spawn(Math.floor(Math.random() * CHAINS.length), true);
        driftCd = 430 + Math.floor(Math.random() * 200);
      }
      for (let i = pkts.length - 1; i >= 0; i--) {
        const p = pkts[i];
        p.t += p.spd;
        if (p.phase === 0 && p.t >= 1) {
          if (p.bad) {
            dvnFlash = 50; dvnBad = true;
            alertA = 0; alertFading = false;
            if (alertTimer) clearTimeout(alertTimer);
            alertTimer = setTimeout(() => { alertFading = true; }, 2600);
            pkts.splice(i, 1);
          } else {
            p.phase = 1; p.t = 0; p.col = SAFE;
          }
        } else if (p.phase === 1 && p.t >= 1) {
          pkts.splice(i, 1);
        }
      }
      if (dvnFlash > 0) { dvnFlash--; if (!dvnFlash) dvnBad = false; }
      if (!alertFading && alertA < 1) alertA = Math.min(1, alertA + 0.055);
      if (alertFading  && alertA > 0) alertA = Math.max(0, alertA - 0.022);
      draw();
      rafId = requestAnimationFrame(tick);
    }

    function drawLines() {
      if (!ctx) return;
      ctx.save();
      ctx.setLineDash([3, 8]);
      ctx.lineWidth = 1;
      for (let i = 0; i < CHAINS.length; i++) {
        const sy = CHY(i);
        const mx = (LX() + DX()) / 2, my = (sy + CY()) / 2;
        ctx.beginPath();
        ctx.moveTo(LX() + CR(), sy);
        ctx.quadraticCurveTo(mx, my, DX() - DR(), CY());
        ctx.strokeStyle = CHAINS[i].col + "1a";
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(DX() + DR(), CY());
      ctx.lineTo(MX() - MR(), CY());
      ctx.strokeStyle = SCAN + "1a";
      ctx.stroke();
      ctx.restore();
    }

    function drawChains() {
      if (!ctx) return;
      for (let i = 0; i < CHAINS.length; i++) {
        const x = LX(), y = CHY(i), ch = CHAINS[i], r = CR();
        ctx.save();
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = ch.col + "18"; ctx.fill();
        ctx.strokeStyle = ch.col + "55"; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = ch.col;
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(ch.abbr, x, y);
        ctx.restore();
      }
    }

    function drawDvn() {
      if (!ctx) return;
      const x = DX(), y = CY(), r = DR();
      const col = dvnBad ? CRIT : SCAN;
      const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 2.4);
      g.addColorStop(0, col + (dvnBad ? "28" : "14"));
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = "#07090d"; ctx.fill();
      ctx.strokeStyle = col + (dvnFlash > 0 ? "ff" : "66");
      ctx.lineWidth = dvnFlash > 0 ? 2.5 : 1.5;
      if (dvnFlash > 0) { ctx.shadowColor = col; ctx.shadowBlur = 16; }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(frame * 0.5 * Math.PI / 180);
      for (let k = 0; k < 6; k++) {
        ctx.save();
        ctx.rotate(k * Math.PI / 3);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r * 0.52, -0.45, 0.45);
        ctx.closePath();
        ctx.fillStyle = col + "20"; ctx.fill();
        ctx.strokeStyle = col + "99"; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
      ctx.fillStyle = col;
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText("DVN CHECKER", x, y + r + 7);
    }

    function drawMantle() {
      if (!ctx) return;
      const x = MX(), y = CY(), r = MR();
      const mg = ctx.createRadialGradient(x, y, 0, x, y, r * 1.6);
      mg.addColorStop(0, SCAN + "22"); mg.addColorStop(1, "transparent");
      ctx.fillStyle = mg;
      ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = "#0a1a1c"; ctx.fill();
      ctx.strokeStyle = SCAN + "99"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = SCAN;
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("DST", x, y);
      ctx.fillStyle = SCAN + "77";
      ctx.font = "9px monospace"; ctx.textBaseline = "top";
      ctx.fillText("DESTINATION", x, y + r + 7);
    }

    function drawPackets() {
      if (!ctx) return;
      for (let i = 0; i < pkts.length; i++) {
        const p = pkts[i], pos = ppos(p), sz = p.bad ? 6 : 4;
        ctx.save();
        ctx.beginPath(); ctx.arc(pos.x, pos.y, sz, 0, Math.PI * 2);
        ctx.fillStyle = p.col;
        ctx.shadowColor = p.col; ctx.shadowBlur = sz * 2.5;
        ctx.fill();
        ctx.restore();
      }
    }

    function drawAlert() {
      if (!ctx || alertA <= 0) return;
      const ax = DX(), ay = CY() - 58;
      ctx.save();
      ctx.globalAlpha = alertA;
      ctx.fillStyle = CRIT + "cc";
      ctx.fillRect(ax - 90, ay - 13, 180, 26);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("⚠  DRIFT DETECTED · ALERT FIRED", ax, ay);
      ctx.restore();
    }

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      drawLines();
      drawChains();
      drawDvn();
      drawMantle();
      drawPackets();
      drawAlert();
    }

    resize();
    window.addEventListener("resize", resize);
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      if (alertTimer) clearTimeout(alertTimer);
      if (el.contains(canv)) el.removeChild(canv);
    };
  }, []);

  return (
    <div className="flow-wrap">
      <div className="sec-title" style={{ margin: "64px 0 0" }}>
        <h2>Message flow · live</h2>
        <div className="meta">CROSS-CHAIN → DVN CHECK → DESTINATION</div>
      </div>
      <div className="flow-box" ref={boxRef} />
      <div className="flow-legend">
        <span><span className="flow-dot" style={{ background: "#627EEA" }} />Ethereum</span>
        <span><span className="flow-dot" style={{ background: "#28A0F0" }} />Arbitrum</span>
        <span><span className="flow-dot" style={{ background: "#0052FF" }} />Base</span>
        <span><span className="flow-dot" style={{ background: "#FF0420" }} />Optimism</span>
        <span><span className="flow-dot" style={{ background: "#F3BA2F" }} />BNB Chain</span>
        <span><span className="flow-dot" style={{ background: "#FF4D5E" }} />Drift packet</span>
      </div>
    </div>
  );
}
