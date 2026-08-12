import { describe, it, expect } from "vitest";
import { mergeWeakFindings, weakCorridorsFingerprint } from "../services/orchestrator.js";
import type { Finding, OftSnapshot, RouteSnapshot } from "../types.js";

// The bug class this file guards against: the weak-config fingerprint is the dedup
// key for the attest+alert pipeline of persistently CRITICAL configs.
//
// Round 1 (fixed 2026-07-15): route reads complete in nondeterministic order under
// concurrency, so set-equal findings arrived reordered each poll — an order-sensitive
// hash re-fired hourly. Fix: hash a sorted copy.
//
// Round 2 (observed live 2026-07-17, rules 4.1.0): per-corridor/per-field RPC reads
// fail intermittently, so the finding SET itself flickers — a corridor's findings
// vanish when its reads fail and reappear next cycle. Measured live on one asset:
// two dozen re-fires and as many on-chain attestations inside 48 hours. Fix: per-corridor state. A corridor that was NOT readable
// this cycle carries forward its last-known findings before hashing, so a failed read
// is never mistaken for a config change. Identity excludes score/risk — both derive
// from the (possibly partial) finding set and would reintroduce the flicker.

const f = (check: string, detail: string, severity: Finding["severity"] = "HIGH"): Finding => ({
  severity,
  evidence: "observed",
  check,
  detail,
});

const route = (chainName: string, opts: { uln?: boolean; isActive?: boolean } = {}): RouteSnapshot => ({
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
    requiredDVNs: ["0x0000000000000000000000000000000000000001"],
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    optionalDVNs: [],
  },
  receiveUln: null,
  peer: null,
  peerAddress: null,
  hasEnforcedOptions: null,
  isActive: opts.isActive ?? true,
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

  it("unions current findings into an unreadable corridor instead of dropping them", () => {
    // uln read failed but the library read succeeded this cycle — keep both the
    // carried-forward finding and the fresh one.
    const last = { gnosis: [GNO_CONF] };
    const merged = mergeWeakFindings([GNO_SEND], snapshot([route("gnosis", { uln: false })]), last);
    expect(merged.gnosis).toEqual(expect.arrayContaining([GNO_CONF, GNO_SEND]));
    expect(merged.gnosis).toHaveLength(2);
  });

  it("replaces findings for a readable corridor — a genuinely cleaned corridor goes quiet", () => {
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

// Round 3 (observed live 2026-08-11, rules 5.0.0). Round 2 handles a corridor whose
// reads VANISH. This is a corridor that still answers, but answers from the wrong
// side.
//
// When a destination's receive config will not read, drift.ts does not go quiet. It
// falls back to the send side, marks the finding `inferred`, and says so in the
// text: the quorum note becomes "receive config unreadable — send side used as a
// proxy" and the DVN names resolve on the SOURCE chain, so the names differ too.
//
// The corridor still counts as readable, because that tests the SEND-side uln and
// the send side read fine. So the degraded reading replaced the good one, the hash
// moved, and the asset re-signed. DINERO took seven records in two days that way,
// all identical 10/CRITICAL, two of them three minutes apart; total() reached 18.
//
// Fixed by refusing the downgrade, NOT by weakening the hash. The hash still covers
// full detail, because detectDrift compares only the send-side uln, the library
// booleans and rpcConflict — it never reads receiveUln and never compares peers, so
// a receive-side DVN swap at an unchanged count has no other signature anywhere.
describe("a degraded reading never overwrites a good one", () => {
  // The SAME corridor and check, read well and read poorly. Note the send-side uln
  // is present in both cases: this is a far-side failure, not a corridor outage.
  const OBSERVED: Finding = {
    severity: "MEDIUM",
    evidence: "observed",
    check: "DVN Count",
    detail: "plume: 2 effective DVNs (LayerZero Labs, Nethermind; 2 required, on the receive side): minimal redundancy.",
  };
  const INFERRED: Finding = {
    severity: "MEDIUM",
    evidence: "inferred",
    check: "DVN Count",
    detail: "plume: 2 effective DVNs (Nethermind, LayerZero Labs; receive config unreadable — send side used as a proxy): minimal redundancy.",
  };
  const readableCorridor = snapshot([route("plume")]);

  it("keeps the observed reading when the far side degrades", () => {
    const good = mergeWeakFindings([OBSERVED], readableCorridor, null);
    const degraded = mergeWeakFindings([INFERRED], readableCorridor, good);
    expect(degraded.plume).toHaveLength(1);
    expect(degraded.plume[0].evidence).toBe("observed");
    expect(weakCorridorsFingerprint(degraded)).toBe(weakCorridorsFingerprint(good));
  });

  it("survives a full flap cycle without ever looking changed", () => {
    const a = mergeWeakFindings([OBSERVED], readableCorridor, null);
    const b = mergeWeakFindings([INFERRED], readableCorridor, a);
    const c = mergeWeakFindings([OBSERVED], readableCorridor, b);
    const d = mergeWeakFindings([INFERRED], readableCorridor, c);
    const fp = weakCorridorsFingerprint(a);
    for (const state of [b, c, d]) expect(weakCorridorsFingerprint(state)).toBe(fp);
  });

  it("does not accumulate both wordings", () => {
    let state = mergeWeakFindings([OBSERVED], readableCorridor, null);
    for (let i = 0; i < 10; i++) {
      state = mergeWeakFindings([i % 2 ? OBSERVED : INFERRED], readableCorridor, state);
    }
    expect(state.plume).toHaveLength(1);
  });

  it("accepts an inferred reading when there is no better one to keep", () => {
    const first = mergeWeakFindings([INFERRED], readableCorridor, null);
    expect(first.plume).toEqual([INFERRED]);
  });

  it("upgrades back to observed the moment the far side answers again", () => {
    const a = mergeWeakFindings([INFERRED], readableCorridor, null);
    const b = mergeWeakFindings([OBSERVED], readableCorridor, a);
    expect(b.plume[0].evidence).toBe("observed");
    // and that upgrade IS a change: we now know something we did not know before.
    expect(weakCorridorsFingerprint(b)).not.toBe(weakCorridorsFingerprint(a));
  });

  // ── The guards. Refusing the downgrade must not blind the hash. ──

  it("STILL catches a receive-side DVN swap at an unchanged count", () => {
    // The attack detectDrift cannot see: same count, same severity, one verifier
    // replaced by the attacker's. Its only signature is the name in the detail.
    const swapped: Finding = {
      ...OBSERVED,
      detail: "plume: 2 effective DVNs (LayerZero Labs, EvilDVN; 2 required, on the receive side): minimal redundancy.",
    };
    const before = mergeWeakFindings([OBSERVED], readableCorridor, null);
    const after = mergeWeakFindings([swapped], readableCorridor, before);
    expect(after.plume[0]).toEqual(swapped);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  it("STILL catches a delivery state turning from unused to stranding", () => {
    // blockClaim returns the same severity on both branches; only the note moves.
    const unused = f("Half-Wired Corridor", "plume: peer set one way only. No funds exposed yet.", "HIGH");
    const stranding = f("Half-Wired Corridor", "plume: peer set one way only. Value is observably stranded.", "HIGH");
    const before = mergeWeakFindings([unused], readableCorridor, null);
    const after = mergeWeakFindings([stranding], readableCorridor, before);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  it("STILL lets a finding clear when the corridor is readable", () => {
    // The downgrade refusal must not become a ratchet. A check that stops firing
    // on a corridor we CAN read has genuinely stopped.
    const before = mergeWeakFindings([OBSERVED], readableCorridor, null);
    const after = mergeWeakFindings([], readableCorridor, before);
    expect(after.plume ?? []).toHaveLength(0);
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });

  it("STILL catches a severity change even when evidence degrades with it", () => {
    const escalated: Finding = { ...INFERRED, severity: "CRITICAL" };
    const before = mergeWeakFindings([OBSERVED], readableCorridor, null);
    const after = mergeWeakFindings([escalated], readableCorridor, before);
    // Same check, so the evidence rule would prefer the observed MEDIUM. That
    // would hide an escalation, so severity must win over evidence.
    expect(weakCorridorsFingerprint(after)).not.toBe(weakCorridorsFingerprint(before));
  });
});
