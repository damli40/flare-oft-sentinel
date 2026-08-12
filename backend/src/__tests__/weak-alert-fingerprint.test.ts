import { describe, it, expect } from "vitest";
import { mergeWeakFindings, weakCorridorsFingerprint } from "../services/orchestrator.js";
import type { Finding, OftSnapshot, RouteSnapshot } from "../types.js";

// The bug class this file guards against: the weak-config fingerprint is the dedup
// key for the attest+alert pipeline of persistently CRITICAL configs. Every time it
// moves, the asset buys a PAID mainnet write.
//
// Round 1 (fixed 2026-07-15): route reads complete in nondeterministic order under
// concurrency, so set-equal findings arrived reordered each poll — an order-sensitive
// hash re-fired hourly. Fix: hash a sorted copy.
//
// Round 2 (observed live 2026-07-17, rules 4.1.0): per-corridor/per-field RPC reads
// fail intermittently, so the finding SET itself flickers — a corridor's findings
// vanish when its reads fail and reappear next cycle. Measured live on one asset:
// two dozen re-fires and as many on-chain attestations inside 48 hours. Fix: per-corridor
// state. A corridor that was NOT readable this cycle carries forward its last-known
// findings before hashing, so a failed read is never mistaken for a config change.
// Identity excludes score/risk — both derive from the (possibly partial) finding set
// and would reintroduce the flicker.
//
// Round 3 (observed live 2026-08-11, rules 5.0.0; rule rewritten 2026-08-12). Round 2
// asked the wrong question. It tested only the NEAR side ("did the send-side ULN read")
// and called the corridor readable, but half of what the engine says about a corridor
// comes from the DESTINATION chain. When the far side will not read, drift.ts does not
// go quiet: it re-words the finding from the send side, and five checks disappear
// altogether because they need a far-side read to fire at all. Both look like a config
// change to a hash over full detail, and both bought a mainnet write.
//
// The rule now takes read quality from the SNAPSHOT, which states it structurally,
// instead of from the finding's `evidence` label, which does not:
//
//     nearOk(route) = route.isActive && route.uln !== null
//     farOk(route)  = route.receiveUln !== null                    (always)
//                  && route.delivery.delivered !== null            (if a block-claim
//                                                                   check is in play)
//                  && route.peerSymmetric !== null                 (if Half-Wired
//                                                                   Corridor is in play)
//
// BOTH sides read → replace with the current findings. Otherwise → carry the last-known
// findings forward, unioned with any fresh finding whose `check` is not already carried.
// The global corridor (owner / custody / proxy) has no far side and keeps its own test.
// UNKNOWN-severity findings — the read-failure sentinels — are dropped before any of it.
//
// The last two legs of farOk and the UNKNOWN filter are Round 4, below; Round 3 shipped
// with only `receiveUln !== null` and the sentinels unfiltered.
//
// Why not the `evidence` label: drift.ts:711-716 deliberately keeps the send-side
// fallback `observed` when the sender pays ≤1 DVN ("a proof, not a proxy" — no larger
// quorum can exist). So on the exact 1-of-1 shape this product headlines,
// both readings are `observed` and the label cannot tell a good read from a degraded one.

const f = (check: string, detail: string, severity: Finding["severity"] = "HIGH"): Finding => ({
  severity,
  evidence: "observed",
  check,
  detail,
});

const SEND_DVN = "0x0000000000000000000000000000000000000001";
const RECV_DVN = "0x0000000000000000000000000000000000000002";

/**
 * A corridor. FOUR independent read outcomes, because the rule under test turns on
 * exactly these distinctions:
 *
 *   uln           — the SEND side, read on the source chain.
 *   receiveUln    — the far side's receive ULN, read on the destination chain
 *                   (lz-config.ts:1402, inside the destination batch).
 *   peerSymmetric — the far side's reverse peer, a SEPARATE sub-call of that same
 *                   batch (lz-config.ts:1388) that can fail on its own: multicall3
 *                   runs with allowFailure:true (multicall.ts:137) and the per-call
 *                   fallback catches to null (lz-config.ts:1007-1009).
 *   delivered     — the far side's inboundNonce, NOT in that batch at all: a bare
 *                   un-retried rawCall (lz-config.ts:1277-1286) whose own gating
 *                   outboundNonce leg is read on the SOURCE client (lz-config.ts:1270).
 *
 * Defaults describe a destination that answered EVERY one of them, which is what
 * "both sides read" has to mean for the corridor to be replaced wholesale. Each can
 * be nulled independently, because in production they fail independently.
 *
 * `receiveUln: false`   → the destination would not answer at all (the outage).
 * `receiveUln: "empty"` → the destination answered, with a set carrying no effective
 *                         DVNs. drift.ts:672 then falls back to the send side and marks
 *                         the finding `inferred` — but we CAN see the far side, so this
 *                         corridor is trustworthy.
 */
const route = (
  chainName: string,
  opts: {
    uln?: boolean;
    receiveUln?: boolean | "empty";
    isActive?: boolean;
    /** null = the reverse-peer sub-call did not answer. false = it answered "no peer back". */
    peerSymmetric?: boolean | null;
    /** null = the destination inboundNonce read did not answer. */
    delivered?: number | null;
    sent?: number;
  } = {},
): RouteSnapshot => ({
  eid: 0,
  chainName,
  chainKey: chainName,
  sendLibrary: null,
  sendLibIsDefault: null,
  receiveLibrary: null,
  receiveLibIsDefault: null,
  uln: opts.uln === false ? null : {
    confirmations: 10,
    requiredDVNCount: 1,
    requiredDVNs: [SEND_DVN],
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    optionalDVNs: [],
  },
  receiveUln:
    opts.receiveUln === false
      ? null
      : opts.receiveUln === "empty"
        ? {
            confirmations: 10,
            requiredDVNCount: 0,
            requiredDVNs: [],
            optionalDVNCount: 0,
            optionalDVNThreshold: 0,
            optionalDVNs: [],
          }
        : {
            confirmations: 10,
            requiredDVNCount: 1,
            requiredDVNs: [RECV_DVN],
            optionalDVNCount: 0,
            optionalDVNThreshold: 0,
            optionalDVNs: [],
          },
  peer: null,
  peerAddress: null,
  hasEnforcedOptions: null,
  isActive: opts.isActive ?? true,
  peerSymmetric: opts.peerSymmetric === undefined ? true : opts.peerSymmetric,
  delivery: { sent: opts.sent ?? 5, delivered: opts.delivered === undefined ? 5 : opts.delivered },
});

const snapshot = (routes: RouteSnapshot[], owner: string | null = "0x000000000000000000000000000000000000dEaD"): OftSnapshot => ({
  oft: "0x1111111111111111111111111111111111111111",
  chainId: 8453,
  capturedAt: 1,
  owner,
  ownerIsContract: owner === null ? null : true,
  proxyAdmin: null,
  proxyAdminOwner: null,
  proxyAdminIsMultisig: null,
  proxyAdminOwnerIsContract: null,
  routes,
});

const GNO_CONF = f("Block Confirmations", "gnosis: 10 block confirmations (< 15, reorg risk).");
const GNO_SEND = f("Send Library Pinning", "gnosis: send library is the upgradeable default.", "CRITICAL");
const ARB_CONF = f("Block Confirmations", "arbitrum: 10 block confirmations (< 15, reorg risk).");
const OWNER_EOA = f("Owner Type", "OFT owner is an EOA: config can be changed by a single private key.", "CRITICAL");

describe("mergeWeakFindings — corridor carry-forward", () => {
  it("groups current findings by corridor when there is no prior state", () => {
    const merged = mergeWeakFindings(
      [GNO_CONF, GNO_SEND, ARB_CONF, OWNER_EOA],
      snapshot([route("gnosis"), route("arbitrum")]),
      null,
    );
    expect(merged.gnosis).toEqual([GNO_CONF, GNO_SEND]);
    expect(merged.arbitrum).toEqual([ARB_CONF]);
    expect(merged.global).toEqual([OWNER_EOA]);
  });

  it("carries forward last-known findings for a corridor absent from this cycle's snapshot", () => {
    const last = { gnosis: [GNO_CONF, GNO_SEND], arbitrum: [ARB_CONF], global: [] as Finding[] };
    // gnosis route missing entirely this cycle (peer sweep flaked)
    const merged = mergeWeakFindings([ARB_CONF], snapshot([route("arbitrum")]), last);
    expect(merged.gnosis).toEqual([GNO_CONF, GNO_SEND]);
    expect(merged.arbitrum).toEqual([ARB_CONF]);
  });

  it("carries forward when a corridor's route is present but its ULN read failed", () => {
    const last = { gnosis: [GNO_CONF, GNO_SEND] };
    const merged = mergeWeakFindings([], snapshot([route("gnosis", { uln: false })]), last);
    expect(merged.gnosis).toEqual([GNO_CONF, GNO_SEND]);
  });

  it("carries forward when the NEAR side read but the FAR side did not", () => {
    // The half Round 2 was missing. The send-side ULN is present, so the old rule
    // called this corridor readable and let a degraded reading overwrite a good one.
    const last = { gnosis: [GNO_CONF, GNO_SEND] };
    const merged = mergeWeakFindings([], snapshot([route("gnosis", { receiveUln: false })]), last);
    expect(merged.gnosis).toEqual([GNO_CONF, GNO_SEND]);
  });

  it("unions current findings into an unreadable corridor instead of dropping them", () => {
    // uln read failed but the library read succeeded this cycle — keep both the
    // carried-forward finding and the fresh one.
    const last = { gnosis: [GNO_CONF] };
    const merged = mergeWeakFindings([GNO_SEND], snapshot([route("gnosis", { uln: false })]), last);
    expect(merged.gnosis).toEqual(expect.arrayContaining([GNO_CONF, GNO_SEND]));
    expect(merged.gnosis).toHaveLength(2);
  });

  it("replaces findings for a corridor that read on BOTH sides — a genuinely cleaned corridor goes quiet", () => {
    const last = { gnosis: [GNO_CONF, GNO_SEND], arbitrum: [ARB_CONF] };
    const merged = mergeWeakFindings([ARB_CONF], snapshot([route("gnosis"), route("arbitrum")]), last);
    expect(merged.gnosis).toEqual([]);
    expect(merged.arbitrum).toEqual([ARB_CONF]);
  });

  it("carries forward global findings when the owner read failed, replaces them when it succeeded", () => {
    const last = { global: [OWNER_EOA] };
    const failedOwnerRead = mergeWeakFindings([], snapshot([route("arbitrum")], null), last);
    expect(failedOwnerRead.global).toEqual([OWNER_EOA]);

    const cleanOwnerRead = mergeWeakFindings([], snapshot([route("arbitrum")]), last);
    expect(cleanOwnerRead.global).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const findings = [GNO_SEND, GNO_CONF];
    const last = { gnosis: [GNO_CONF] };
    mergeWeakFindings(findings, snapshot([route("gnosis")]), last);
    expect(findings).toEqual([GNO_SEND, GNO_CONF]);
    expect(last).toEqual({ gnosis: [GNO_CONF] });
  });
});

describe("weakCorridorsFingerprint — stable identity across partial reads", () => {
  it("is identical for the same corridor state regardless of finding order", () => {
    const a = weakCorridorsFingerprint({ gnosis: [GNO_CONF, GNO_SEND], arbitrum: [ARB_CONF] });
    const b = weakCorridorsFingerprint({ arbitrum: [ARB_CONF], gnosis: [GNO_SEND, GNO_CONF] });
    expect(a).toBe(b);
  });

  it("does not change when a flaky cycle drops a corridor that merge carried forward", () => {
    const full = mergeWeakFindings(
      [GNO_CONF, GNO_SEND, ARB_CONF],
      snapshot([route("gnosis"), route("arbitrum")]),
      null,
    );
    const fired = weakCorridorsFingerprint(full);
    // next cycle: gnosis unreadable, findings arrive without it
    const partial = mergeWeakFindings([ARB_CONF], snapshot([route("arbitrum")]), full);
    expect(weakCorridorsFingerprint(partial)).toBe(fired);
  });

  it("changes when a corridor's findings materially change", () => {
    const before = weakCorridorsFingerprint({ gnosis: [GNO_CONF] });
    const after = weakCorridorsFingerprint({ gnosis: [GNO_CONF, GNO_SEND] });
    expect(before).not.toBe(after);
  });
});

// ── Round 3 ────────────────────────────────────────────────────────────────────
//
// The named fixtures below are rendered from drift.ts's own template strings (line
// numbers cited on each) rather than paraphrased, because the whole failure is a
// WORDING change and a paraphrased fixture would not reproduce it.
//
// One exception, marked at its own site: the unused→stranding guard further down
// builds two short invented Half-Wired details, because all that test needs is two
// strings that differ in the delivery note while agreeing on check and severity.
// Nothing else in this file invents detail text.
//
// `blockClaim(UNUSED)` (drift.ts:266-270) supplies the trailing note on the four
// delivery-gated checks; UNUSED is the state of a pre-wired corridor, which is the
// common case for the checks that need a far-side read.

const UNUSED_NOTE =
  "no message has ever been sent through this corridor — no funds exposed yet, and the first send is the one that strands";

// DVN Count, 1-of-1, FAR SIDE READ. drift.ts:680-688 (quorum note) + 721-727 (finding).
const SOLO_FAR_READ: Finding = {
  severity: "CRITICAL",
  evidence: "observed",
  check: "DVN Count",
  detail:
    "plume: 1 effective DVN (LayerZero Labs; 1 required, on the receive side): a single compromised verifier can forge a message the destination will accept.",
};

// The SAME corridor and the SAME config, read while the far side will not answer.
// drift.ts:711-716: the sender pays ≤1 DVN, so no larger quorum can exist and the
// fallback stays `observed` on purpose. Only the quorum note (and, on a real asset,
// the chain the DVN names resolve on) moves.
const SOLO_FAR_DOWN: Finding = {
  severity: "CRITICAL",
  evidence: "observed",
  check: "DVN Count",
  detail:
    "plume: 1 effective DVN (LayerZero Labs; receive config unreadable, but the sender pays only this one DVN — no larger quorum can exist): a single compromised verifier can forge a message the destination will accept.",
};

// The five checks that cannot fire at all without a far-side read, so they do not
// degrade — they VANISH from the current reading.
const BLOCK_CONF_MISMATCH: Finding = {
  severity: "HIGH",
  evidence: "observed",
  check: "Block Confirmation Mismatch", // drift.ts:981-988 — guarded on route.receiveUln
  detail: `plume: send confirmations (10) < receive required (20). LZ integrator docs ("Block Confirmation Mismatch", dvn-executor-config): messages will be blocked until the outbound confirmations are raised or the inbound threshold is lowered. ${UNUSED_NOTE}.`,
};
const DEAD_RECEIVE_DVN: Finding = {
  severity: "HIGH",
  evidence: "observed",
  check: "Dead Receive DVN", // drift.ts:646-653 — guarded on recvUln
  detail: `plume: the DESTINATION's required DVN set is entirely an LZ Dead DVN placeholder, so the receive side can verify nothing — and the corridor still accepts sends (quoteSend prices one). ${UNUSED_NOTE}. Not a forgeable 1-of-1: a dead DVN cannot attest at all, so it cannot be compromised to forge.`,
};
const UNDELIVERABLE_ROUTE: Finding = {
  severity: "HIGH",
  evidence: "observed",
  check: "Undeliverable Route", // drift.ts:835-863 — guarded on recvUln?.requiredDVNs?.length
  detail: `plume: sender pays [LayerZero Labs] but the destination accepts on [LayerZero Labs, Nethermind] — destination requires [Nethermind], which the sender does not pay. ${UNUSED_NOTE}.`,
};
const NON_BLOCKING_MISMATCH: Finding = {
  severity: "PASS",
  evidence: "observed",
  check: "Non-Blocking DVN Mismatch", // drift.ts:835 + 880-884 — same guard
  detail:
    "plume: sender pays [LayerZero Labs, Nethermind] but the destination only accepts on [LayerZero Labs] — extra DVNs [Nethermind] are paid for and ignored. Messages deliver normally; security is set by the receive side. Fees are higher than necessary.",
};
// Gated on peerSymmetric, which is the destination's peer mapping — a far-side read
// that fails in the same outage as receiveUln. See the caveat in orchestrator.ts.
const HALF_WIRED: Finding = {
  severity: "HIGH",
  evidence: "observed",
  check: "Half-Wired Corridor", // drift.ts:601-607
  detail: `plume: this OFT peers to the destination, but the destination does NOT peer back (no peer set). The corridor still accepts sends — quoteSend only reads the source's own peer mapping — but lzReceive reverts on the destination and can never succeed. ${UNUSED_NOTE}.`,
};

const VANISHING_CHECKS: Array<{ name: string; finding: Finding }> = [
  { name: "Block Confirmation Mismatch", finding: BLOCK_CONF_MISMATCH },
  { name: "Dead Receive DVN", finding: DEAD_RECEIVE_DVN },
  { name: "Undeliverable Route", finding: UNDELIVERABLE_ROUTE },
  { name: "Non-Blocking DVN Mismatch", finding: NON_BLOCKING_MISMATCH },
  { name: "Half-Wired Corridor", finding: HALF_WIRED },
];

// 2-of-2 on the receive side, read from the destination. drift.ts:747-753.
const DVN2_FAR_READ: Finding = {
  severity: "MEDIUM",
  evidence: "observed",
  check: "DVN Count",
  detail: "plume: 2 effective DVNs (LayerZero Labs, Nethermind; 2 required, on the receive side): minimal redundancy.",
};
// Same count, one verifier replaced by the attacker's. detectDrift never reads
// receiveUln, so the name inside this string is the ONLY signature this attack has.
const DVN2_RECV_SWAPPED: Finding = {
  ...DVN2_FAR_READ,
  detail: "plume: 2 effective DVNs (LayerZero Labs, EvilDVN; 2 required, on the receive side): minimal redundancy.",
};
// The send-side proxy reading. drift.ts:711-716 with sendPaidCount > 1 → `inferred`.
const DVN2_SEND_PROXY: Finding = {
  severity: "MEDIUM",
  evidence: "inferred",
  check: "DVN Count",
  detail:
    "plume: 2 effective DVNs (LayerZero Labs, Nethermind; receive config unreadable — send side used as a proxy): minimal redundancy.",
};
const DVN2_SEND_PROXY_SWAPPED: Finding = {
  ...DVN2_SEND_PROXY,
  detail:
    "plume: 2 effective DVNs (LayerZero Labs, EvilDVN; receive config unreadable — send side used as a proxy): minimal redundancy.",
};

// Owner Type, drift.ts:1035-1043. The declared branch proposes HIGH/unverifiable and
// capByEvidence (drift.ts:124-139) caps unverifiable at LOW, so LOW is what ships.
const OWNER_EOA_OBSERVED: Finding = {
  severity: "HIGH",
  evidence: "observed",
  check: "Owner Type",
  detail: "OFT owner is an EOA: config can be changed by a single private key.",
};
const OWNER_FIREBLOCKS_DECLARED: Finding = {
  severity: "LOW",
  evidence: "unverifiable",
  check: "Owner Type",
  detail: "owner is EOA on-chain; declared Fireblocks MPC custody (declared, unverified).",
  custodyDeclaration: {
    custodyType: "fireblocks_mpc",
    declaredBy: "team@example.com",
    declaredAt: "2026-08-11",
    verified: false,
  },
};

// Proxy Upgrade Control, drift.ts:1070-1097. EOA → timelock is a real remediation:
// observed HIGH becomes unverifiable (capped LOW), which is a DOWNGRADE in both axes.
const PROXY_EOA: Finding = {
  severity: "HIGH",
  evidence: "observed",
  check: "Proxy Upgrade Control",
  detail: "Proxy admin owner is an EOA (0x1234567890...): a single key can upgrade the implementation.",
};
const PROXY_TIMELOCK: Finding = {
  severity: "LOW",
  evidence: "unverifiable",
  check: "Proxy Upgrade Control",
  detail:
    "Proxy admin owner (0xabcdef1234...) is a contract but not a recognized Gnosis Safe (e.g. a timelock or custom multisig). Upgrade governance is not verifiable on-chain (unverified).",
};

// drift.ts:942-947. Unpinned receive library — common, and CRITICAL, which is what
// makes a corridor-level "is anything worse than before" test blind.
const RECEIVE_LIB_DEFAULT: Finding = {
  severity: "CRITICAL",
  evidence: "observed",
  check: "Receive Library",
  detail:
    "plume: receive library is the upgradeable default. LZ Labs can change inbound message acceptance rules unilaterally, bypassing DVN config.",
};

// A genuine escalation that reaches the orchestrator TODAY: Deprecated DVN is read
// entirely on the SEND side (drift.ts:767-774), so it can appear during a far-side
// outage, and it is `observed` CRITICAL.
const DEPRECATED_DVN: Finding = {
  severity: "CRITICAL",
  evidence: "observed",
  check: "Deprecated DVN",
  detail: 'plume: required DVN "Nethermind" is deprecated: messages may halt.',
};

const bothSidesRead = snapshot([route("plume")]);
// A whole-destination outage: the receive ULN, the reverse peer and the inbound
// nonce all go dark together, because they are all read against the same
// destination RPC. The narrower single-read failures each get their own snapshot
// in the P2/P6 sections below — those are the ones that were shipping writes.
const farSideDown = snapshot([route("plume", { receiveUln: false, peerSymmetric: null, delivered: null })]);
const farSideAnsweredEmpty = snapshot([route("plume", { receiveUln: "empty" })]);

describe("Round 3 — a far-side READ FAILURE never re-words or clears a corridor", () => {
  // ── (1) the flagship shape: the 1-of-1 single-verifier asset ──────────────────
  it("holds the hash when a 1-of-1's far side stops reading, though BOTH readings are `observed`", () => {
    // The label cannot discriminate here, by design. This assertion is the point of
    // the whole rewrite: any rule keyed on `evidence` is blind on exactly this asset.
    expect(SOLO_FAR_READ.evidence).toBe(SOLO_FAR_DOWN.evidence);
    expect(SOLO_FAR_READ.detail).not.toBe(SOLO_FAR_DOWN.detail);

    const good = mergeWeakFindings([SOLO_FAR_READ], bothSidesRead, null);
    const degraded = mergeWeakFindings([SOLO_FAR_DOWN], farSideDown, good);
    expect(degraded.plume).toEqual([SOLO_FAR_READ]);
    expect(weakCorridorsFingerprint(degraded)).toBe(weakCorridorsFingerprint(good));
  });

  it("does not accumulate both wordings over ten flaps", () => {
    let state = mergeWeakFindings([SOLO_FAR_READ], bothSidesRead, null);
    for (let i = 0; i < 10; i++) {
      state = i % 2
        ? mergeWeakFindings([SOLO_FAR_READ], bothSidesRead, state)
        : mergeWeakFindings([SOLO_FAR_DOWN], farSideDown, state);
    }
    expect(state.plume).toHaveLength(1);
  });

  // ── (2) the five checks that vanish rather than degrade ────────────────────
  it.each(VANISHING_CHECKS)(
    "holds the hash when $name disappears with the far-side read, and again on recovery",
    ({ finding }) => {
      const good = mergeWeakFindings([finding], bothSidesRead, null);
      // The far side goes down. This check cannot fire at all, so it is simply absent.
      const outage = mergeWeakFindings([], farSideDown, good);
      expect(outage.plume).toEqual([finding]);
      expect(weakCorridorsFingerprint(outage)).toBe(weakCorridorsFingerprint(good));
      // Recovery must not be a second write either.
      const recovered = mergeWeakFindings([finding], bothSidesRead, outage);
      expect(weakCorridorsFingerprint(recovered)).toBe(weakCorridorsFingerprint(good));
    },
  );

  it("holds the hash through a full flap: read → degraded → read → degraded", () => {
    // Both failure modes at once, which is what a real outage looks like: the DVN
    // Count finding re-words AND the confirmation-mismatch finding disappears.
    const a = mergeWeakFindings([SOLO_FAR_READ, BLOCK_CONF_MISMATCH], bothSidesRead, null);
    const b = mergeWeakFindings([SOLO_FAR_DOWN], farSideDown, a);
    const c = mergeWeakFindings([SOLO_FAR_READ, BLOCK_CONF_MISMATCH], bothSidesRead, b);
    const d = mergeWeakFindings([SOLO_FAR_DOWN], farSideDown, c);
    const fp = weakCorridorsFingerprint(a);
    for (const state of [b, c, d]) expect(weakCorridorsFingerprint(state)).toBe(fp);
  });

  it("takes the far-side reading the moment the far side answers again", () => {
    const a = mergeWeakFindings([SOLO_FAR_DOWN], farSideDown, null);
    const b = mergeWeakFindings([SOLO_FAR_READ], bothSidesRead, a);
    expect(b.plume).toEqual([SOLO_FAR_READ]);
    // And that IS a change: we now know something we did not know before.
    expect(weakCorridorsFingerprint(b)).not.toBe(weakCorridorsFingerprint(a));
  });

  it("accepts a reading on a corridor with no prior state, far side up or down", () => {
    expect(mergeWeakFindings([SOLO_FAR_DOWN], farSideDown, null).plume).toEqual([SOLO_FAR_DOWN]);
    expect(mergeWeakFindings([SOLO_FAR_READ], bothSidesRead, null).plume).toEqual([SOLO_FAR_READ]);
  });

  // ── (3) the downgrade regression: a legitimate improvement must be recorded ─
  it("records a custody declaration immediately: unverifiable LOW REPLACES the stored observed HIGH", () => {
    const before = mergeWeakFindings([OWNER_EOA_OBSERVED], bothSidesRead, null);
    const after = mergeWeakFindings([OWNER_FIREBLOCKS_DECLARED], bothSidesRead, before);
    expect(after.global).toEqual([OWNER_FIREBLOCKS_DECLARED]);
    expect(after.global[0].severity).toBe("LOW");
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  it("keeps the global corridor readable during a route outage — it has no far side", () => {
    // A destination-chain outage must not freeze the owner/custody/proxy record.
    const before = mergeWeakFindings([OWNER_EOA_OBSERVED], bothSidesRead, null);
    const after = mergeWeakFindings([OWNER_FIREBLOCKS_DECLARED], farSideDown, before);
    expect(after.global).toEqual([OWNER_FIREBLOCKS_DECLARED]);
  });

  it("records a real EOA → timelock proxy-admin transfer instead of refusing it forever", () => {
    const before = mergeWeakFindings([PROXY_EOA], bothSidesRead, null);
    const after = mergeWeakFindings([PROXY_TIMELOCK], bothSidesRead, before);
    expect(after.global).toEqual([PROXY_TIMELOCK]);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  // ── (4) an `inferred` reading is not refused when we can SEE the far side ──
  it("accepts an inferred reading when the far side answered, so a swap under it stays visible", () => {
    // The far side answers with a set carrying no effective DVNs (drift.ts:672), so the
    // engine falls back to the send side and marks it `inferred` — but nothing is
    // unreadable here, so refusing the reading would be refusing a real observation.
    const a = mergeWeakFindings([DVN2_FAR_READ], bothSidesRead, null);
    const b = mergeWeakFindings([DVN2_SEND_PROXY], farSideAnsweredEmpty, a);
    expect(b.plume).toEqual([DVN2_SEND_PROXY]);
    expect(weakCorridorsFingerprint(b)).not.toBe(weakCorridorsFingerprint(a));

    const c = mergeWeakFindings([DVN2_SEND_PROXY_SWAPPED], farSideAnsweredEmpty, b);
    expect(c.plume).toEqual([DVN2_SEND_PROXY_SWAPPED]);
    expect(weakCorridorsFingerprint(c)).not.toBe(weakCorridorsFingerprint(b));
  });

  // ── The guards. Holding the hash steady must not blind it. ─────────────────

  it("STILL catches a receive-side DVN swap between two fully-readable cycles", () => {
    // The attack detectDrift cannot see: same count, same severity, one verifier
    // replaced by the attacker's. Its only signature is the name in the detail.
    const before = mergeWeakFindings([DVN2_FAR_READ], bothSidesRead, null);
    const after = mergeWeakFindings([DVN2_RECV_SWAPPED], bothSidesRead, before);
    expect(after.plume).toEqual([DVN2_RECV_SWAPPED]);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  it("STILL catches a delivery state turning from unused to stranding", () => {
    // blockClaim returns the same severity on both branches; only the note moves.
    // ⚠️ The two details here are INVENTED, not drift.ts template renders — the only
    // property under test is "same check, same severity, different note", and a short
    // string carries that as well as the real 300-character one. This is the single
    // exception to the verbatim rule stated at the top of Round 3.
    const unused = f("Half-Wired Corridor", `plume: peer set one way only. ${UNUSED_NOTE}.`, "HIGH");
    const stranding = f(
      "Half-Wired Corridor",
      "plume: peer set one way only. 3 messages sent that the destination never accepted (5 sent, 2 delivered): value is observably stranded.",
      "HIGH",
    );
    const before = mergeWeakFindings([unused], bothSidesRead, null);
    const after = mergeWeakFindings([stranding], bothSidesRead, before);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  it("STILL lets a finding clear on a corridor that reads on BOTH sides", () => {
    const before = mergeWeakFindings([DVN2_FAR_READ], bothSidesRead, null);
    const after = mergeWeakFindings([], bothSidesRead, before);
    expect(after.plume ?? []).toHaveLength(0);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  // ── The escalation escape hatch ────────────────────────────────────────────

  it("ESCALATION: admits a new, more-severe check found during an outage", () => {
    // Live path: Deprecated DVN is read on the SEND side (drift.ts:767-774), so it can
    // appear while the far side is down, and it ships `observed` CRITICAL.
    const before = mergeWeakFindings([DVN2_FAR_READ], bothSidesRead, null);
    const after = mergeWeakFindings([DVN2_SEND_PROXY, DEPRECATED_DVN], farSideDown, before);
    // The escalation lands. The re-worded DVN Count reading does NOT: it is the same
    // check at the same severity, i.e. the flap, so the good reading is kept.
    expect(after.plume).toEqual([DVN2_FAR_READ, DEPRECATED_DVN]);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  it("ESCALATION: fires PER CHECK, not per corridor", () => {
    // The hole a corridor-level hatch leaves. An unpinned receive library already puts
    // this corridor at CRITICAL, so a corridor-max test sees no escalation when DVN
    // Count goes MEDIUM → CRITICAL — and MEDIUM → the 1-of-1 single-verifier shape is the
    // most important escalation this product exists to catch.
    const before = mergeWeakFindings([RECEIVE_LIB_DEFAULT, DVN2_FAR_READ], bothSidesRead, null);
    const after = mergeWeakFindings([SOLO_FAR_DOWN], farSideDown, before);
    // The escalated check replaces its own carried reading; the untouched CRITICAL
    // finding this cycle could not see is still carried, not dropped.
    expect(after.plume).toEqual([RECEIVE_LIB_DEFAULT, SOLO_FAR_DOWN]);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  it("ESCALATION: fires on severity alone, regardless of the evidence label", () => {
    // Guard, not a live path: capByEvidence caps `inferred` at MEDIUM, so an inferred
    // CRITICAL cannot reach the orchestrator today. It is here so a future rules change
    // that lifts that cap cannot silently re-open the hole.
    const escalated: Finding = { ...DVN2_SEND_PROXY, severity: "CRITICAL" };
    const before = mergeWeakFindings([DVN2_FAR_READ], bothSidesRead, null);
    const after = mergeWeakFindings([escalated], farSideDown, before);
    expect(after.plume).toEqual([escalated]);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  it("ESCALATION: an EQUAL-severity degraded reading is NOT an escalation", () => {
    // The flagship shape is CRITICAL against a carried CRITICAL. If the hatch fired on
    // ≥ rather than >, it would swallow the entire fix.
    const good = mergeWeakFindings([SOLO_FAR_READ], bothSidesRead, null);
    const degraded = mergeWeakFindings([SOLO_FAR_DOWN], farSideDown, good);
    expect(weakCorridorsFingerprint(degraded)).toBe(weakCorridorsFingerprint(good));
  });

  // ── Costs we accept, asserted so nobody discovers them by surprise ─────────

  it("ACCEPTED COST: a corridor whose far side never reads cannot clear a finding", () => {
    // Honest for an attestation system: we cannot confirm what we cannot see. The
    // alternative is paying for a mainnet write on every flake.
    const a = mergeWeakFindings([SOLO_FAR_DOWN], farSideDown, null);
    const b = mergeWeakFindings([], farSideDown, a);
    expect(b.plume).toEqual([SOLO_FAR_DOWN]);
    expect(weakCorridorsFingerprint(b)).toBe(weakCorridorsFingerprint(a));
  });

  it("ACCEPTED COST: a SEND-side DVN swap stays suppressed while the far side is down", () => {
    // Same check, no severity change, so neither the union nor the escape hatch admits
    // it. The proper home for this is detectDrift's send-side comparison (drift.ts:395-415),
    // which today catches a count drop, a confirmation drop and a newly-added DEPRECATED
    // DVN — but not a same-count swap to an unrecognised address. That gap is in drift.ts.
    const a = mergeWeakFindings([DVN2_SEND_PROXY], farSideDown, null);
    const b = mergeWeakFindings([DVN2_SEND_PROXY_SWAPPED], farSideDown, a);
    expect(b.plume).toEqual([DVN2_SEND_PROXY]);
    expect(weakCorridorsFingerprint(b)).toBe(weakCorridorsFingerprint(a));
  });

  it("ACCEPTED COST: the union dedupes by CHECK, so a second finding of the same check waits", () => {
    // Two deprecated DVNs on one corridor produce two "Deprecated DVN" findings. During
    // an outage the second cannot join the carried first. It lands on the next cycle
    // that reads both sides.
    const second: Finding = { ...DEPRECATED_DVN, detail: 'plume: required DVN "Polyhedra" is deprecated: messages may halt.' };
    const a = mergeWeakFindings([DEPRECATED_DVN], farSideDown, null);
    const b = mergeWeakFindings([DEPRECATED_DVN, second], farSideDown, a);
    expect(b.plume).toEqual([DEPRECATED_DVN]);
    const c = mergeWeakFindings([DEPRECATED_DVN, second], bothSidesRead, b);
    expect(c.plume).toEqual([DEPRECATED_DVN, second]);
  });
});

// ── Round 4 ────────────────────────────────────────────────────────────────────
//
// Three holes an adversarial review proved by executed probe against Round 3 AND
// against the implementation that preceded it. They are not new breakage; they are
// pre-existing holes the "both sides answered" rule did not close, because it took
// `receiveUln` as the whole far side when the far side is actually FOUR independent
// reads (see the `route` helper above).
//
//  P5  a read-failure SENTINEL — a finding whose severity is UNKNOWN, meaning "we
//      could not evaluate this" — was allowed into the paid identity. UNKNOWN is
//      precisely the thing that must never be attested as a change.
//  P2  the delivered nonce (destination inboundNonce) is read outside the
//      destination batch, un-retried, so it can go dark while receiveUln reads —
//      and blockClaim then re-words four checks at an unchanged severity.
//  P6  the reverse peer is a per-sub-call-failable read, so it can go dark while
//      receiveUln reads — and drift.ts then stops emitting Half-Wired Corridor
//      AND stops suppressing the rest of the corridor's checks (drift.ts:618).

// drift.ts:547-552. The near-side ULN flake sentinel. UNKNOWN + unverifiable, and it
// deducts no score (drift.ts:544-546) precisely because it is not a security finding.
const ULN_UNREADABLE: Finding = {
  severity: "UNKNOWN",
  evidence: "unverifiable",
  check: "ULN Unreadable",
  detail:
    "plume: ULN config could not be read. DVN and confirmation settings unverifiable on this corridor (not scored).",
};
// drift.ts:1100-1105. The OTHER UNKNOWN drift.ts can emit — global, not per corridor.
// Its presence is why the fix filters the SEVERITY CLASS and not the string
// "ULN Unreadable": a second sentinel already exists today.
const PROXY_BYTECODE_UNREADABLE: Finding = {
  severity: "UNKNOWN",
  evidence: "unverifiable",
  check: "Proxy Upgrade Control",
  detail:
    "Proxy admin owner (0xabcdef12...) bytecode could not be read: upgrade control unverifiable on this snapshot (not scored).",
};

// blockClaim's STRANDING note, drift.ts:237-241, with sent=5 delivered=2.
const STRANDING_NOTE =
  "3 messages sent that the destination never accepted (5 sent, 2 delivered): value is observably stranded";
// blockClaim's UNKNOWN note, drift.ts:271-275. deliveryState returns UNKNOWN the
// moment `delivered` is null (drift.ts:206) — no other input changes.
const DELIVERY_DARK_NOTE =
  "delivery accounting unavailable for this corridor; the claim rests on the observed config and LZ's documented behaviour alone";

// The SAME check at the SAME severity on the SAME config, separated only by which
// blockClaim branch ran. This is the DINERO shape: identical 10/CRITICAL records,
// one paid write each way. drift.ts:983-988.
const BCM_STRANDING: Finding = {
  severity: "HIGH",
  evidence: "observed",
  check: "Block Confirmation Mismatch",
  detail: `plume: send confirmations (10) < receive required (20). LZ integrator docs ("Block Confirmation Mismatch", dvn-executor-config): messages will be blocked until the outbound confirmations are raised or the inbound threshold is lowered. ${STRANDING_NOTE}.`,
};
const BCM_DELIVERY_DARK: Finding = {
  ...BCM_STRANDING,
  detail: `plume: send confirmations (10) < receive required (20). LZ integrator docs ("Block Confirmation Mismatch", dvn-executor-config): messages will be blocked until the outbound confirmations are raised or the inbound threshold is lowered. ${DELIVERY_DARK_NOTE}.`,
};

// A half-wired corridor as the chain actually presents it: the destination answered
// "I do not peer back" (peerSymmetric === false), nothing has ever been sent.
const halfWiredRead = snapshot([route("plume", { peerSymmetric: false, sent: 0, delivered: 0 })]);
// Same corridor, next cycle: the reverse-peer sub-call alone failed. receiveUln still
// reads, the nonces still read. drift.ts:601 now emits nothing, and drift.ts:618's
// `continue` no longer suppresses the rest — so DVN Count surfaces for the first time.
const peerReadDark = snapshot([route("plume", { peerSymmetric: null, sent: 0, delivered: 0 })]);

// receiveUln reads; only the inbound-nonce rawCall failed.
const stranding = snapshot([route("plume", { sent: 5, delivered: 2 })]);
const deliveryDark = snapshot([route("plume", { sent: 5, delivered: null })]);

describe("Round 4 — the far-side reads the witness was missing", () => {
  // ── P5: UNKNOWN-severity sentinels must not enter the paid identity ─────────

  it("P5: a near-side ULN flake does not put an UNKNOWN sentinel into a clean corridor", () => {
    // The whole episode: clean corridor → one flaky cycle → recovery. Under the old
    // rule that is [] → ["ULN Unreadable"] → [], i.e. TWO paid mainnet writes bought
    // by an RPC hiccup that told us nothing about the config.
    const clean = mergeWeakFindings([], bothSidesRead, null);
    const flake = mergeWeakFindings([ULN_UNREADABLE], snapshot([route("plume", { uln: false })]), clean);
    expect(flake.plume).toEqual([]);
    expect(weakCorridorsFingerprint(flake)).toBe(weakCorridorsFingerprint(clean));

    const recovered = mergeWeakFindings([], bothSidesRead, flake);
    expect(weakCorridorsFingerprint(recovered)).toBe(weakCorridorsFingerprint(clean));
  });

  it("P5: filters the UNKNOWN CLASS, not one check name — the proxy sentinel is excluded too", () => {
    // drift.ts can emit an UNKNOWN from two places. Keying the filter on the string
    // "ULN Unreadable" would leave this one live, and the global corridor is trusted
    // whenever the OWNER read succeeds, so this sentinel lands directly in the hash.
    const clean = mergeWeakFindings([], bothSidesRead, null);
    const flake = mergeWeakFindings([PROXY_BYTECODE_UNREADABLE], bothSidesRead, clean);
    expect(flake.global).toEqual([]);
    expect(weakCorridorsFingerprint(flake)).toBe(weakCorridorsFingerprint(clean));
  });

  it("P5: an UNKNOWN sentinel is not admitted alongside a carried finding either", () => {
    // The union's not-carried branch is what admits it: "ULN Unreadable" is a check
    // nothing is carried under, so it walks straight in next to a live CRITICAL.
    const before = mergeWeakFindings([SOLO_FAR_READ], bothSidesRead, null);
    const after = mergeWeakFindings([ULN_UNREADABLE], snapshot([route("plume", { uln: false })]), before);
    expect(after.plume).toEqual([SOLO_FAR_READ]);
    expect(weakCorridorsFingerprint(after)).toBe(weakCorridorsFingerprint(before));
  });

  it("P5 GUARD: filters UNKNOWN only — PASS, LOW and every scored severity still enter", () => {
    // UNKNOWN means "not evaluated". PASS means "evaluated, and it is fine" — a real
    // reading that belongs in the record. Filtering by "does not deduct score" instead
    // of by severity would have swallowed both.
    const merged = mergeWeakFindings(
      [NON_BLOCKING_MISMATCH, OWNER_FIREBLOCKS_DECLARED, ULN_UNREADABLE],
      bothSidesRead,
      null,
    );
    expect(merged.plume).toEqual([NON_BLOCKING_MISMATCH]); // PASS survives
    expect(merged.global).toEqual([OWNER_FIREBLOCKS_DECLARED]); // LOW survives
  });

  // ── P2: the delivered nonce is part of the far side for block-claim checks ──

  it("P2: an inbound-nonce flake does not re-word a block claim while receiveUln reads", () => {
    // receiveUln answers on both cycles, so the old witness called this corridor
    // trustworthy and let the re-worded reading replace the good one. Identical
    // severity, identical check, one sentence different — and a paid write.
    expect(BCM_STRANDING.severity).toBe(BCM_DELIVERY_DARK.severity);
    expect(BCM_STRANDING.check).toBe(BCM_DELIVERY_DARK.check);
    expect(BCM_STRANDING.detail).not.toBe(BCM_DELIVERY_DARK.detail);

    const good = mergeWeakFindings([BCM_STRANDING], stranding, null);
    const dark = mergeWeakFindings([BCM_DELIVERY_DARK], deliveryDark, good);
    expect(dark.plume).toEqual([BCM_STRANDING]);
    expect(weakCorridorsFingerprint(dark)).toBe(weakCorridorsFingerprint(good));

    // And the reverse leg: recovery must not be a second write.
    const recovered = mergeWeakFindings([BCM_STRANDING], stranding, dark);
    expect(weakCorridorsFingerprint(recovered)).toBe(weakCorridorsFingerprint(good));
  });

  it("P2: covers every check blockClaim writes a note into, not just the one that fired", () => {
    // blockClaim is called from exactly four sites: drift.ts:602 (Half-Wired
    // Corridor), :648 (Dead Receive DVN), :858 (Undeliverable Route), :982 (Block
    // Confirmation Mismatch). Each ends its detail with the delivery note, so each
    // re-words on a nonce flake.
    for (const finding of [HALF_WIRED, DEAD_RECEIVE_DVN, UNDELIVERABLE_ROUTE, BCM_STRANDING]) {
      const good = mergeWeakFindings([finding], stranding, null);
      const reworded: Finding = { ...finding, detail: `${finding.detail} [re-worded]` };
      const dark = mergeWeakFindings([reworded], deliveryDark, good);
      expect(dark.plume, `check ${finding.check} must not re-word on a nonce flake`).toEqual([finding]);
      expect(weakCorridorsFingerprint(dark)).toBe(weakCorridorsFingerprint(good));
    }
  });

  it("P2 SCOPE: a dark nonce does NOT freeze a corridor carrying no block-claim check", () => {
    // The reason `delivered !== null` is not a blanket far-side requirement. Most
    // corridors have no block-claim finding at all, and `delivery` is simply absent
    // whenever the destination has no configured RPC or the outbound leg failed
    // (lz-config.ts:1261, 1293). Requiring it everywhere would make most corridors
    // permanently untrustworthy and would block real fixes from ever being recorded.
    const before = mergeWeakFindings([DVN2_FAR_READ], stranding, null);
    const after = mergeWeakFindings([], deliveryDark, before);
    expect(after.plume).toEqual([]);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  // ── P6: the reverse peer is part of the far side for Half-Wired Corridor ────

  it("P6: a reverse-peer flake does not CLEAR a carried Half-Wired Corridor", () => {
    // The dangerous half of this one. peerSymmetric nulls, drift.ts:601 stops
    // emitting, and the corridor's HIGH — the trap where tokens leave and lzReceive
    // reverts forever — silently vanishes from a PAID attestation.
    const good = mergeWeakFindings([HALF_WIRED], halfWiredRead, null);
    expect(good.plume).toEqual([HALF_WIRED]);

    // drift.ts:618's `continue` is gone too, so DVN Count surfaces this cycle.
    const dark = mergeWeakFindings([SOLO_FAR_READ], peerReadDark, good);
    expect(dark.plume).toContainEqual(HALF_WIRED);
  });

  it("P6 RESIDUE: the peer flake still moves the hash, because the unsuppressed check is admitted", () => {
    // Asserted so nobody discovers it by surprise. The fix keeps the Half-Wired HIGH
    // in the record; it does NOT make the episode free. drift.ts:618 stops suppressing
    // the corridor's other checks, and DVN Count is a check nothing is carried under,
    // so the union's not-carried branch admits it — correctly: it is a live finding we
    // can see, and dropping live findings is the older bug this rule already fixed.
    // Cost: still up to two writes per peers-flake episode on a half-wired corridor.
    // Closing it means suppressing a visible finding, which is a drift.ts question.
    const good = mergeWeakFindings([HALF_WIRED], halfWiredRead, null);
    const dark = mergeWeakFindings([SOLO_FAR_READ], peerReadDark, good);
    expect(dark.plume).toEqual([HALF_WIRED, SOLO_FAR_READ]);
    expect(weakCorridorsFingerprint(dark)).not.toBe(weakCorridorsFingerprint(good));
    // What the fix buys: the HIGH is still there on the way back, so recovery lands
    // on the ORIGINAL identity rather than on a third one.
    const recovered = mergeWeakFindings([HALF_WIRED], halfWiredRead, dark);
    expect(weakCorridorsFingerprint(recovered)).toBe(weakCorridorsFingerprint(good));
  });

  it("P6 SCOPE: a dark reverse peer does NOT freeze a corridor with no Half-Wired finding", () => {
    // Same narrow-scoping principle as P2. peerSymmetric gates exactly one check
    // (drift.ts:601); everywhere else its absence says nothing, and freezing on it
    // would block real fixes from being recorded.
    const before = mergeWeakFindings([DVN2_FAR_READ], bothSidesRead, null);
    const after = mergeWeakFindings([], peerReadDark, before);
    expect(after.plume).toEqual([]);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  it("P2+P6 GUARD: a corridor whose far side answers fully still replaces, findings and all", () => {
    // The whole point of narrow scoping. With receiveUln, the reverse peer and the
    // nonces all answered, a corridor carrying the most heavily-gated check there is
    // still clears it the moment it is genuinely fixed.
    const before = mergeWeakFindings([HALF_WIRED], halfWiredRead, null);
    const after = mergeWeakFindings([], snapshot([route("plume", { sent: 0, delivered: 0 })]), before);
    expect(after.plume).toEqual([]);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });
});
