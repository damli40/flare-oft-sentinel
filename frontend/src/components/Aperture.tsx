import type React from "react";

interface ApertureProps {
  size?: number;
  ring?: string;
  hex?: string;
  core?: string;
  arc?: string;
  spin?: boolean;
  glow?: boolean;
}

export function Aperture({
  size = 80,
  ring = "#1F2630",
  hex = "#2A323D",
  core = "#5BE7F0",
  arc = "#5BE7F0",
  spin = false,
  glow = true,
}: ApertureProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-label="OFT Sentinel aperture"
      style={{ flexShrink: 0 }}
    >
      {/* outer ring */}
      <circle cx="50" cy="50" r="46" fill="none" stroke={ring} strokeWidth="2.2" />
      {/* scan arc — <g> wrapper pins the CSS rotation origin to (50,50) in SVG-user space */}
      <g style={spin ? {
        animation: "scan-rot 5.5s linear infinite",
        // view-box makes 50% 50% resolve to the SVG viewBox center (50,50), not CSS pixels
        transformBox: "view-box" as React.CSSProperties["transformBox"],
        transformOrigin: "50% 50%",
      } : undefined}>
        <circle
          cx="50" cy="50" r="46"
          fill="none" stroke={arc} strokeWidth="2.6" strokeLinecap="round"
          strokeDasharray="60 229"
          transform="rotate(-96 50 50)"
        />
      </g>
      {/* outer hex */}
      <polygon
        points="50,21 75.1,35.5 75.1,64.5 50,79 24.9,64.5 24.9,35.5"
        fill="none" stroke={hex} strokeWidth="2.4" strokeLinejoin="round"
      />
      {/* inner hex */}
      <polygon
        points="50,30 67.3,40 67.3,60 50,70 32.7,60 32.7,40"
        fill="none" stroke={arc} strokeWidth="1.4" strokeLinejoin="round" opacity="0.4"
      />
      {/* core glow ring */}
      {glow && (
        <circle cx="50" cy="50" r="13" fill="none" stroke={core} strokeWidth="1.1" opacity="0.4" />
      )}
      {/* core dot */}
      <circle cx="50" cy="50" r="6.8" fill={core} />
    </svg>
  );
}
