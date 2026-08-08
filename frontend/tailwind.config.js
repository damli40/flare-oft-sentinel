/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        lz: {
          // surfaces
          dark:          "#07090D",
          "dark-2":      "#0A0D12",
          card:          "#0E1218",
          surface:       "#141922",
          "surface-3":   "#1A2029",
          border:        "#1F2630",
          "border-soft": "#161B23",
          // accents — ice scan
          scan:          "#5BE7F0",
          "scan-bright": "#A6F4F9",
          mint:          "#5BE7F0",
          // semantic risk
          danger:        "#FF4D5E",
          warn:          "#FFB23E",
          ok:            "#34D27D",
          // text
          text:          "#EAEEF5",
          muted:         "#8A93A3",
          faint:         "#565F6D",
          ghost:         "#39414D",
        },
      },
      fontFamily: {
        sans:    ["'Space Grotesk'", "system-ui", "sans-serif"],
        display: ["'Space Grotesk'", "system-ui", "sans-serif"],
        mono:    ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.04em" }],
      },
      boxShadow: {
        card:      "inset 0 1px 0 0 rgba(255,255,255,0.05), 0 0 0 1px #1F2630, 0 14px 44px -16px rgba(0,0,0,0.85)",
        "card-sm": "inset 0 1px 0 0 rgba(255,255,255,0.05), 0 0 0 1px #1F2630, 0 4px 18px -10px rgba(0,0,0,0.8)",
        glow:      "0 0 0 1px rgba(91,231,240,0.25), 0 0 24px -6px rgba(91,231,240,0.35)",
      },
      letterSpacing: {
        eyebrow: "0.22em",
      },
    },
  },
  plugins: [],
};
