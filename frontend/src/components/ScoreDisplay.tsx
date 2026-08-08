import { useState, useEffect } from "react";

export type RiskLevel = "PASS" | "AT_RISK" | "CRITICAL";

function riskColor(r: RiskLevel): string {
  if (r === "CRITICAL") return "#FF4D5E";
  if (r === "AT_RISK")  return "#FFB23E";
  return "#34D27D";
}

function riskLabel(r: RiskLevel): string {
  if (r === "CRITICAL") return "CRITICAL";
  if (r === "AT_RISK")  return "AT RISK";
  return "SAFE";
}

function spillClass(r: RiskLevel): string {
  if (r === "CRITICAL") return "spill s-crit";
  if (r === "AT_RISK")  return "spill s-warn";
  return "spill s-safe";
}

/** Compact risk badge for fleet tiles, ledger, and verdict spotlight. */
export function RiskBadge({ riskLevel }: { riskLevel: RiskLevel }) {
  return (
    <span className={spillClass(riskLevel)}>
      <span className="d" />
      {riskLabel(riskLevel)}
    </span>
  );
}

interface Props {
  score: number;
  riskLevel: RiskLevel;
  verdict: string;
}

export function ScoreDisplay({ score, riskLevel, verdict }: Props) {
  const r = 58;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - score / 100);
  const color = riskColor(riskLevel);

  const [stroke, setStroke] = useState("#3D7BFF");
  useEffect(() => {
    const t = setTimeout(() => setStroke(color), 50);
    return () => clearTimeout(t);
  }, [color]);

  const pad = (n: number) => String(Math.round(n)).padStart(2, "0");

  return (
    <div className="spotlight">
      <div className="ring-wrap">
        <svg width="132" height="132" viewBox="0 0 132 132">
          <circle cx="66" cy="66" r={r} fill="none" stroke="#1A2029" strokeWidth="9" />
          <circle
            cx="66" cy="66" r={r}
            fill="none"
            stroke={stroke}
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform="rotate(-90 66 66)"
            style={{
              transition: "stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)",
              filter: `drop-shadow(0 0 6px ${stroke}66)`,
            }}
          />
        </svg>
        <div className="scoretxt">
          <div className="v" style={{ color }}>{pad(score)}</div>
          <div className="m">RISK SCORE</div>
        </div>
      </div>
      <div className="verdict">
        <p className="corr" style={{ marginTop: 0, marginBottom: 8 }}>{verdict}</p>
      </div>
    </div>
  );
}
