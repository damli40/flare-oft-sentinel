import { describe, it, expect, vi } from "vitest";

// Real resolveDvn would need the live metadata table. These tests are about the SHAPE of
// the rules (which side is scored, subset vs equality, what sendability may cap), not about
// name resolution, so stub the table and let the DVN "names" be the raw addresses — which
// resolveDvn returns verbatim when it has no entry. The address-fragment guard in the
// deliverability rule keys on a trailing "…", which these never have.
vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
    resolveDvn: (addr: string) => addr, // identity: the address IS the canonical name here
  };
});

import { assessSnapshot, capBySendability, effectiveDvns, assessDeliverability } from "../services/drift.js";
import type { OftSnapshot, RouteSnapshot, UlnSnapshot, Finding, Sendability } from "../types.js";

const A = "0x589dEDbD617e0CBcB916A9223F4d1300c294236b"; // stand-ins for three independent
const B = "0x8ddF05F9A5c488b4973897E278B58895bF87Cb24"; // DVN operators
const C = "0xa59BA433ac34D2927232918Ef5B2eaAfcF130BA5";
const D = "0xc9ca319f6Da263910fd9B037eC3d817A814ef3d8";

function uln(over: Partial<UlnSnapshot> = {}): UlnSnapshot {
  return {
    confirmations: 64,
    requiredDVNCount: 1,
    requiredDVNs: [A],
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    optionalDVNs: [],
    ...over,
  };
}

function route(over: Partial<RouteSnapshot> = {}): RouteSnapshot {
  return {
    eid: 30367,
    chainName: "hyperliquid",
    chainKey: "hyperliquid",
    sendLibrary: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2",
    sendLibIsDefault: false,
    receiveLibrary: "0x0000000000000000000000000000000000000001",
    receiveLibIsDefault: false,
    uln: uln(),
    receiveUln: null,
    peer: "0x88A19F30E1254B37b66899893ab1F73aD82BD2C3",
    peerAddress: "0x88A19F30E1254B37b66899893ab1F73aD82BD2C3",
    hasEnforcedOptions: true,
    isActive: true,
    sendability: "SENDABLE",
    // Default: the corridor is delivering everything sent through it. Rules that claim
    // messages do NOT get through must justify that against delivery, not against config.
    delivery: { sent: 5, delivered: 5 },
    peerSymmetric: true,
    ...over,
  };
}

/** Delivery fixtures, named for the state they put the corridor in. */
const STRANDING = { sent: 5, delivered: 3 };   // 2 messages left and never landed
const DELIVERING = { sent: 5, delivered: 5 };  // delivered — under WHICH config is unverified
const TESTED = { sent: 5, delivered: 5, sentUnderCurrentConfig: true };   // last send crossed under the current config
const UNTESTED = { sent: 5, delivered: 5, sentUnderCurrentConfig: false }; // all history predates the current config
const UNUSED = { sent: 0, delivered: 0 };      // nobody has ever sent
const UNMEASURED = null;                       // destination unreadable

function snap(routes: RouteSnapshot[]): OftSnapshot {
  return {
    oft: "0x00000000000000000000000000000000000f1c71", // synthetic — the SHAPE is the subject, not the asset
    chainId: 1,
    capturedAt: Date.now(),
    owner: "0x0000000000000000000000000000000000000002",
    ownerIsContract: true,
    proxyAdmin: null,
    proxyAdminOwner: null,
    proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
    routes,
  };
}

const find = (fs: Finding[], check: string) => fs.filter((f) => f.check === check);

// ── The sendability law ────────────────────────────────────────────────────────
describe("capBySendability", () => {
  const crit: Finding = { severity: "CRITICAL", evidence: "observed", check: "X", detail: "" };

  it("DORMANT caps at MEDIUM — no CRITICAL about money that cannot move", () => {
    expect(capBySendability(crit, "UNSENDABLE").severity).toBe("MEDIUM");
  });

  it("LIVE does not cap", () => {
    expect(capBySendability(crit, "SENDABLE").severity).toBe("CRITICAL");
  });

  // The load-bearing one. UNKNOWN means the probe failed, NOT that the corridor is dead.
  // If an RPC hiccup could cap severity, Sentinel becomes a machine for suppressing
  // findings exactly when infrastructure is under stress.
  it("UNKNOWN NEVER caps — a failed probe must not suppress a real CRITICAL", () => {
    expect(capBySendability(crit, "UNKNOWN").severity).toBe("CRITICAL");
  });

  it("never raises severity", () => {
    const low: Finding = { severity: "LOW", evidence: "observed", check: "X", detail: "" };
    for (const l of ["SENDABLE", "UNSENDABLE", "UNKNOWN"] as Sendability[]) {
      expect(capBySendability(low, l).severity).toBe("LOW");
    }
  });
});

// ── Deliverability is a SUBSET test ─────────────────────────────────────────
describe("assessDeliverability", () => {
  // The exact corridor shape that produced the false HIGH on a real, healthy asset.
  it("the false-positive shape: sender pays 3, receiver requires 1 + 1-of-2 — NOT blocked", () => {
    const d = assessDeliverability([A, B, C], [], [C], [B, A], 1);
    expect(d.blocked).toBe(false);
    expect(d.missingRequired).toEqual([]);
    // Every DVN the sender pays for is one the receiver counts: no mismatch at all.
    expect(d.overpaid).toEqual([]);
  });

  it("blocked when the receiver requires a DVN the sender does not pay", () => {
    const d = assessDeliverability([A, B], [], [D], [], 0);
    expect(d.blocked).toBe(true);
    expect(d.missingRequired).toEqual([D]);
  });

  it("blocked when the sender covers too few of the receiver's optional set", () => {
    const d = assessDeliverability([A], [], [], [B, C], 2); // needs 2 of {B,C}, pays neither
    expect(d.blocked).toBe(true);
    expect(d.optionalShortfall).toBe(2);
  });

  it("non-blocking when the sender overpays: messages flow, fees are wasted", () => {
    const d = assessDeliverability([A, B], [], [A], [], 0);
    expect(d.blocked).toBe(false);
    expect(d.overpaid).toEqual([B]); // paid on every message, counted by nobody
  });

  it("optional DVNs the sender pays count toward the receiver's threshold", () => {
    const d = assessDeliverability([A], [B], [A], [B, C], 1);
    expect(d.blocked).toBe(false);
  });
});

describe("effectiveDvns", () => {
  it("is required + optionalThreshold — the quorum an attacker must defeat", () => {
    expect(effectiveDvns(uln({ requiredDVNCount: 1, optionalDVNCount: 2, optionalDVNThreshold: 1 }))).toBe(2);
    expect(effectiveDvns(uln({ requiredDVNCount: 2, optionalDVNCount: 3, optionalDVNThreshold: 2 }))).toBe(4);
  });
});

// ── Security is scored on the RECEIVE side ──────────────────────────────────
describe("assessSnapshot — the receive side is the enforcement boundary", () => {
  // THE MISSED SINGLE-DVN CASE. Until 4.0.0 the DVN Count rule read the SEND config, so this OFT —
  // paying three DVNs but accepting on one — scored PASS. The attacker only has to defeat
  // the quorum that ACCEPTS the message; what the sender paid for is irrelevant.
  it("fires CRITICAL when the RECEIVE side is 1-of-1, even though the send side pays 3", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
      receiveUln: uln({ requiredDVNCount: 1, requiredDVNs: [A] }),
    })]);
    const { findings, riskLevel } = await assessSnapshot(s, "TKN");
    const dvn = find(findings, "DVN Count");
    expect(dvn).toHaveLength(1);
    expect(dvn[0].severity).toBe("CRITICAL");
    expect(dvn[0].evidence).toBe("observed");
    expect(riskLevel).toBe("CRITICAL");
  });

  // The healthy real-world shape: 1 required + 1-of-2 optional, three independent operators.
  it("scores that config as 2 effective DVNs (MEDIUM), not a block", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
      receiveUln: uln({
        requiredDVNCount: 1, requiredDVNs: [C],
        optionalDVNCount: 2, optionalDVNThreshold: 1, optionalDVNs: [A, B],
      }),
    })]);
    const { findings, riskLevel } = await assessSnapshot(s, "TKN");
    expect(find(findings, "DVN Count")[0].severity).toBe("MEDIUM");
    expect(find(findings, "Undeliverable Route")).toHaveLength(0);
    expect(riskLevel).toBe("AT_RISK");
    expect(findings.some((f) => f.severity === "CRITICAL")).toBe(false);
  });

  it("an undeliverable DVN set with STRANDED messages is HIGH", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 1, requiredDVNs: [A] }),
      receiveUln: uln({ requiredDVNCount: 2, requiredDVNs: [C, D], optionalDVNCount: 0 }),
      delivery: STRANDING,
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    const blocked = find(findings, "Undeliverable Route");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].severity).toBe("HIGH");
    expect(blocked[0].evidence).toBe("observed");
    expect(blocked[0].detail).toContain("stranded");
  });

  it("records a non-blocking mismatch as unscored PASS hygiene, never a severity", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
      receiveUln: uln({ requiredDVNCount: 2, requiredDVNs: [A, B] }), // C is paid, uncounted
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    const nb = find(findings, "Non-Blocking DVN Mismatch");
    expect(nb).toHaveLength(1);
    expect(nb[0].severity).toBe("PASS");
    expect(find(findings, "Undeliverable Route")).toHaveLength(0);
  });
});

// ── A dead RECEIVE side is a blocked route, not a 1-of-1 ────────────────────
// Regression guard for a false CRITICAL that 4.0.0 briefly INTRODUCED. Scoring the
// receive side newly exposed the engine to a dead receive config, which the send-side-only
// Dead Pathway rule never guarded — and a receive set of [LZDeadDVN] reads as "1 effective
// DVN" and fired the single-DVN CRITICAL. A dead DVN cannot attest, so it cannot be compromised
// to forge: the route is blocked, and the risk asserted did not exist. Found only by the
// 3.0.0-vs-4.0.0 fleet A/B against live data; every unit test passed.
// ── The delivery law ────────────────────────────────────────────────────────
// THE hard lesson. Three false findings all shared one shape: the engine measured a CONFIG
// property and asserted a CONSEQUENCE it had never observed. A rule may not claim messages
// fail to get through unless delivery accounting says so.
//
//   STRANDING  (sent > delivered) → HIGH,   observed  — value really is stuck
//   DELIVERING (sent == delivered) → MEDIUM, observed  — latent risk, NOT a block
//   UNUSED     (sent == 0)         → LOW,    observed  — nobody is exposed
//   UNKNOWN    (unmeasured)        → inferred → capped MEDIUM by the evidence law
describe("the delivery law — no block claim without a measurement", () => {
  const DEAD = "0x000000000000000000000000000000000000dEaD";
  const deadRecv = (delivery: any) => snap([route({
    uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
    receiveUln: uln({ requiredDVNCount: 1, requiredDVNs: [DEAD] }),
    delivery,
  })]);

  // A dead DVN cannot attest, so it cannot be compromised to forge. Never a single-DVN CRITICAL.
  it("a dead receive-side DVN set is never scored as a forgeable 1-of-1", async () => {
    const { findings } = await assessSnapshot(deadRecv(STRANDING), "TKN");
    expect(find(findings, "DVN Count")).toHaveLength(0);
    expect(findings.some((f) => f.severity === "CRITICAL")).toBe(false);
  });

  it("STRANDING: messages left and never landed → HIGH, observed, and it counts them", async () => {
    const { findings } = await assessSnapshot(deadRecv(STRANDING), "TKN");
    const f = find(findings, "Dead Receive DVN")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.evidence).toBe("observed");
    expect(f.detail).toMatch(/2 messages sent that the destination never accepted/);
  });

  // THE CORRECTED LAW: delivery evidence is historical; config is current. History may
  // never soften a config-derived claim (the stale-evidence lesson: sent == delivered
  // came from a config long dead, and the first post-change send is BLOCKED).
  it("DELIVERING (undiscriminated): keeps config severity — past delivery does not clear a present misconfiguration", async () => {
    const { findings } = await assessSnapshot(deadRecv(DELIVERING), "TKN");
    const f = find(findings, "Dead Receive DVN")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.evidence).toBe("observed");
    expect(f.detail).toMatch(/whether any message has crossed under the CURRENT config is unverified/);
  });

  it("UNTESTED (verified: history predates the config): keeps config severity and says nothing has crossed under what we score", async () => {
    const { findings } = await assessSnapshot(deadRecv(UNTESTED), "TKN");
    const f = find(findings, "Dead Receive DVN")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.detail).toMatch(/predates the current config/);
    expect(f.detail).toMatch(/the next send is the experiment/);
  });

  it("TESTED contradiction (messages cross under the config we read as blocking): sensor flag, never a downgrade", async () => {
    const { findings } = await assessSnapshot(deadRecv(TESTED), "TKN");
    const f = find(findings, "Dead Receive DVN")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.detail).toMatch(/SENSOR CONTRADICTION/);
    expect(f.detail).toMatch(/investigate the pipeline/);
  });

  it("UNUSED: keeps config severity — no funds exposed yet, and the first send is the one that strands", async () => {
    const { findings } = await assessSnapshot(deadRecv(UNUSED), "TKN");
    const f = find(findings, "Dead Receive DVN")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.detail).toMatch(/no message has ever been sent/);
    expect(f.detail).toMatch(/the first send is the one that strands/);
  });

  it("UNKNOWN: unmeasured delivery keeps config severity — the claim rests on config + docs", async () => {
    const { findings } = await assessSnapshot(deadRecv(UNMEASURED), "TKN");
    const f = find(findings, "Dead Receive DVN")[0];
    expect(f.evidence).toBe("observed"); // the misconfiguration itself IS observed
    expect(f.severity).toBe("HIGH");
    expect(f.detail).toMatch(/delivery accounting unavailable/);
  });

  // A destination read that failed must NEVER be coerced to zero delivered: that would
  // invent `sent` stranded messages out of an RPC hiccup, on every corridor at once.
  it("a failed destination read is UNKNOWN, never 'zero delivered'", async () => {
    const { findings } = await assessSnapshot(deadRecv({ sent: 9, delivered: null }), "TKN");
    const f = find(findings, "Dead Receive DVN")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.detail).toMatch(/delivery accounting unavailable/);
    expect(f.detail).not.toMatch(/9 messages sent that the destination never accepted/);
  });
});

// ── Block Confirmation Mismatch: named for LZ's own docs section ──────────────
// dvn-executor-config#block-confirmation-mismatch: "Messages will be blocked until either
// the sending OApp has increased the outbound block confirmations, or the receiving OApp
// decreases the inbound block confirmation threshold." Send < receive blocks. HIGH from
// the docs; delivery evidence may only escalate or contradict, never soften — a real
// corridor's post-change send sits BLOCKED on LZ Scan as the empirical proof.
describe("block confirmation mismatch — blocked per LZ docs, HIGH", () => {
  const confAsym = (delivery: any) => snap([route({
    uln: uln({ confirmations: 15, requiredDVNCount: 2, requiredDVNs: [A, B] }),
    receiveUln: uln({ confirmations: 20, requiredDVNCount: 2, requiredDVNs: [A, B] }),
    delivery,
  })]);

  it("DELIVERING (undiscriminated): stays HIGH — history does not clear the mismatch", async () => {
    const { findings } = await assessSnapshot(confAsym(DELIVERING), "TKN");
    const f = find(findings, "Block Confirmation Mismatch")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.detail).toMatch(/messages will be blocked/);
    expect(f.detail).toMatch(/whether any message has crossed under the CURRENT config is unverified/);
  });

  it("UNTESTED: stays HIGH and states nothing has crossed under the scored config", async () => {
    const { findings } = await assessSnapshot(confAsym(UNTESTED), "TKN");
    const f = find(findings, "Block Confirmation Mismatch")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.detail).toMatch(/predates the current config/);
  });

  it("STRANDING: stuck messages are counted as observed exposure — still HIGH", async () => {
    const { findings } = await assessSnapshot(confAsym(STRANDING), "TKN");
    const f = find(findings, "Block Confirmation Mismatch")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.evidence).toBe("observed");
    expect(f.detail).toMatch(/observably stranded/);
  });

  it("fires only in the blocking direction (send < receive); send > receive is not this finding", async () => {
    const reversed = snap([route({
      uln: uln({ confirmations: 20, requiredDVNCount: 2, requiredDVNs: [A, B] }),
      receiveUln: uln({ confirmations: 15, requiredDVNCount: 2, requiredDVNs: [A, B] }),
      delivery: DELIVERING,
    })]);
    const { findings } = await assessSnapshot(reversed, "TKN");
    expect(find(findings, "Block Confirmation Mismatch")).toHaveLength(0);
  });
});

// ── Half-wired corridor: setPeer is one-directional ─────────────────────────
// quoteSend reads only the SOURCE's peer mapping, so a corridor with no peer back still
// quotes, still debits — and lzReceive reverts on the destination forever.
describe("half-wired corridor — destination does not peer back", () => {
  const halfWired = (delivery: any) => snap([route({
    uln: uln({ requiredDVNCount: 2, requiredDVNs: [A, B] }),
    receiveUln: uln({ requiredDVNCount: 2, requiredDVNs: [A, B] }),
    peerSymmetric: false,
    reversePeer: null,
    delivery,
  })]);

  it("STRANDING: sends went into a corridor with no peer back → HIGH", async () => {
    const { findings } = await assessSnapshot(halfWired(STRANDING), "TKN");
    const f = find(findings, "Half-Wired Corridor")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.detail).toMatch(/does NOT peer back/);
  });

  it("UNUSED: half-wired with no sends keeps config severity — the first send is the one that strands", async () => {
    const { findings } = await assessSnapshot(halfWired(UNUSED), "TKN");
    const f = find(findings, "Half-Wired Corridor")[0];
    expect(f.severity).toBe("HIGH");
    expect(f.detail).toMatch(/the first send is the one that strands/);
  });

  // Unread is not unset. Never accuse a team of a half-wired corridor we failed to read.
  it("peerSymmetric null (unread) emits nothing at all", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 2, requiredDVNs: [A, B] }),
      receiveUln: uln({ requiredDVNCount: 2, requiredDVNs: [A, B] }),
      peerSymmetric: null,
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    expect(find(findings, "Half-Wired Corridor")).toHaveLength(0);
  });
});

describe("assessSnapshot — receive side unreadable", () => {
  // Single-DVN detection preserved. Only one DVN is PAID, so only one attestation can ever exist, so the
  // receiver cannot possibly require more than that one. Either the corridor is dead or it
  // is a genuine 1-of-1 — and deadness is capBySendability's job, not the evidence law's.
  it("still fires CRITICAL when the sender pays exactly one DVN (no larger quorum can exist)", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 1, requiredDVNs: [A] }),
      receiveUln: null,
      sendability: "UNKNOWN",
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    const dvn = find(findings, "DVN Count");
    expect(dvn[0].severity).toBe("CRITICAL");
    expect(dvn[0].evidence).toBe("observed");
  });

  // Here the send side really is only a proxy: three attestations exist, and the receiver
  // may require any subset of them. Claiming CRITICAL would assert more than we measured.
  it("caps at MEDIUM (inferred) when the sender pays several DVNs and the receiver is unreadable", async () => {
    const s = snap([route({
      uln: uln({ requiredDVNCount: 1, requiredDVNs: [A], optionalDVNCount: 2, optionalDVNThreshold: 0, optionalDVNs: [B, C] }),
      receiveUln: null,
    })]);
    const { findings } = await assessSnapshot(s, "TKN");
    const dvn = find(findings, "DVN Count");
    expect(dvn[0].evidence).toBe("inferred");
    expect(dvn[0].severity).not.toBe("CRITICAL");
  });
});

// ── Sendability gates severity end to end ──────────────────────────────────────
describe("assessSnapshot — sendability gate", () => {
  const singleDvn = (sendability: Sendability) => snap([route({
    uln: uln({ requiredDVNCount: 3, requiredDVNs: [A, B, C] }),
    receiveUln: uln({ requiredDVNCount: 1, requiredDVNs: [A] }),
    sendability,
  })]);

  it("DORMANT corridor: the same 1-of-1 caps at MEDIUM — no paging on money that cannot move", async () => {
    const { findings, riskLevel } = await assessSnapshot(singleDvn("UNSENDABLE"), "TKN");
    expect(find(findings, "DVN Count")[0].severity).toBe("MEDIUM");
    expect(riskLevel).toBe("AT_RISK");
  });

  it("the cap lifts by itself the day the corridor goes LIVE", async () => {
    const { findings, riskLevel } = await assessSnapshot(singleDvn("SENDABLE"), "TKN");
    expect(find(findings, "DVN Count")[0].severity).toBe("CRITICAL");
    expect(riskLevel).toBe("CRITICAL");
  });

  it("UNKNOWN sendability does not suppress the CRITICAL", async () => {
    const { findings } = await assessSnapshot(singleDvn("UNKNOWN"), "TKN");
    expect(find(findings, "DVN Count")[0].severity).toBe("CRITICAL");
  });
});
