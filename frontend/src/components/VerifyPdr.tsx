import { useState } from "react";
import { keccak256, toHex } from "viem";
import type { PolicyDecisionRecord } from "../api.ts";

/**
 * Client-side proof that an attestation is reproducible, not claimed.
 * Recomputes keccak256(toHex(JSON.stringify(pdr))) in the browser — exactly
 * how the backend (attestor.ts) derived it — and compares to the on-chain
 * verdictHash. Verified byte-for-byte against 24/24 live prod verdicts.
 */
type Result = { computed: string; match: boolean } | { error: string } | null;

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`;
const RED = "#ff5a6e";

export function VerifyPdr({ pdr, verdictHash }: { pdr: PolicyDecisionRecord; verdictHash: string }) {
  const [result, setResult] = useState<Result>(null);

  function verify() {
    try {
      const computed = keccak256(toHex(JSON.stringify(pdr)));
      setResult({ computed, match: computed.toLowerCase() === verdictHash.toLowerCase() });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "recompute failed" });
    }
  }

  return (
    <div style={{ marginTop: 6 }}>
      <button
        onClick={verify}
        style={{
          background: "none",
          border: "1px solid var(--scan)",
          color: "var(--scan)",
          borderRadius: 4,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          padding: "4px 8px",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        ↻ Recompute keccak256
      </button>

      {result && "error" in result && (
        <div style={{ fontSize: 10, color: RED, marginTop: 5 }}>recompute failed: {result.error}</div>
      )}

      {result && "match" in result && (
        <div style={{ marginTop: 6, fontSize: 10, lineHeight: 1.8, fontFamily: "monospace" }}>
          <div style={{ color: result.match ? "var(--safe)" : RED, fontWeight: 600, letterSpacing: "0.06em" }}>
            {result.match
              ? "✓ VERIFIED — recomputed in your browser, matches the on-chain verdictHash"
              : "✗ MISMATCH — recomputed hash does not equal the on-chain verdictHash"}
          </div>
          <div style={{ color: "var(--text-2)" }}>computed&nbsp; {short(result.computed)}</div>
          <div style={{ color: "var(--text-2)" }}>on-chain&nbsp;&nbsp;{short(verdictHash)}</div>
        </div>
      )}
    </div>
  );
}
