export type RiskLevel = "PASS" | "AT_RISK" | "CRITICAL";
// UNKNOWN = the check could not be evaluated (e.g. corridor read failed after
// retries) — never deducts score, so a transient RPC failure can't masquerade
// as a security finding.
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "PASS" | "UNKNOWN";

/**
 * How directly the chain supports the risk claim this finding makes.
 *
 * Severity is not a property of a configuration — it is a property of a configuration
 * PLUS the evidence that the risk is real. Sentinel repeatedly shipped false CRITICALs
 * (EOA-vs-Fireblocks, EOA-vs-timelock, 1-of-1-vs-dead-DVN) by collapsing "the config has
 * property X" into "the protocol has risk Y", joined by an assumption the chain cannot
 * verify. `evidence` makes that join explicit and bounds it (see capByEvidence).
 *
 *  - observed     — the chain directly shows the risk. No interpretation.
 *                   e.g. requiredDVNs = [oneRealDVN]; owner address has no bytecode.
 *  - inferred     — the chain shows a PROXY for the risk, not the risk itself.
 *  - unverifiable — the fact that determines severity is not on-chain at all.
 *                   e.g. who custodies an EOA key; a timelock's proposer set.
 *
 * ⚠️ Assigned from what the READER measured (snapshot fields), never chosen by a rule
 * author to reach a desired severity. Rules consume it read-only.
 */
export type Evidence = "observed" | "inferred" | "unverifiable";

export interface Finding {
  severity: Severity;
  // Bounds severity via capByEvidence. CRITICAL/HIGH require "observed".
  evidence: Evidence;
  check: string;
  detail: string;
  // Custody declaration consumed by the rule (Owner Type). Embedded so the PDR
  // hash covers every engine input: same config + same declarations → same verdict.
  custodyDeclaration?: CustodyDeclaration;
}

// ── Custody declarations ──────────────────────────────────────────────────
// Self-declared, unverified custody type for an OFT's owner key. On-chain data
// cannot distinguish a Fireblocks MPC-custodied EOA from a raw hot wallet, so
// teams declare (manual intake for now) and the engine consumes the attestation.

export type CustodyType = "eoa_hot" | "fireblocks_mpc" | "safe_multisig" | "unknown";

export interface CustodyDeclaration {
  custodyType: CustodyType;
  declaredBy: string;
  declaredAt: string; // ISO date of the declaration
  verified: boolean;  // always false until a verification path exists
}

export interface DvnRow {
  chain: string;
  required: string[];
  optional: string[];
  confirmations: number;
}

// ── Sentinel ──────────────────────────────────────────────────────────────

/** A LayerZero ULN config for one route, normalized from on-chain reads. */
export interface UlnSnapshot {
  confirmations: number;
  requiredDVNCount: number;
  requiredDVNs: string[];
  optionalDVNCount: number;
  optionalDVNThreshold: number;
  optionalDVNs: string[];
}

/**
 * Will this corridor ACCEPT A SEND right now?
 *
 * ⚠️ SENDABLE IS NOT DELIVERABLE. This is the single most important thing to know about
 * this type, and getting it wrong is not hypothetical — it is why the receive-side dead
 * pathway was first mis-scored as a harmless LOW advisory.
 *
 * `quoteSend()` is priced entirely on the SOURCE chain, against the send library and the
 * send ULN. It knows nothing whatsoever about the destination's receive config. So a
 * successful quote proves only that the endpoint will price and accept a message — never
 * that anything arrives.
 *
 * A corridor can therefore be SENDABLE and still be permanently undeliverable:
 *   - send confirmations < the destination's required confirmations
 *   - the destination requires a DVN the sender does not pay
 *   - the destination's required DVN set is an LZ Dead DVN placeholder
 * In every one of those, tokens leave the source and never arrive. That is STRICTLY WORSE
 * than an unsendable route — an unsendable route at least refuses the money. Deliverability
 * is a separate axis, decided by the receive-side rules, and it must stay that way.
 *
 * What this type IS good for: teams pre-wire destination chains long before opening them,
 * so a corridor can carry a fully-formed config no message has ever crossed. A security
 * claim about money that cannot even be sent is not a security claim (see capBySendability),
 * and sendability is what separates a dormant, harmless misconfiguration from a live trap.
 *
 *  - SENDABLE   — quoteSend() returned a fee. The corridor accepts and prices a message.
 *                 Says NOTHING about whether it will be delivered.
 *  - UNSENDABLE — quoteSend() reverted. Nothing can enter this corridor at all.
 *  - UNKNOWN    — the probe itself failed (RPC error, no peer to quote against). NOT a
 *                 verdict. Never caps severity: an infra hiccup must not be able to
 *                 suppress a real CRITICAL.
 */
export type Sendability = "SENDABLE" | "UNSENDABLE" | "UNKNOWN";

/**
 * How many messages this corridor has actually carried — the ONLY thing that turns a
 * config observation into a claim about value.
 *
 * Three false findings shipped before this existed, all the same error: the engine
 * measured a CONFIG property and asserted a CONSEQUENCE it had never observed. It saw a
 * DVN set difference and said "permanently blocked" (the corridor was delivering). It saw
 * a confirmation asymmetry and said "permanently blocked" (the corridor was delivering).
 * It saw a dead receive-side DVN set and said "funds are stranded" (nobody had ever sent
 * a message through it). Delivery is not inferable from config. It has to be counted.
 *
 *  - sent      — outboundNonce on the SOURCE endpoint: messages this OApp has emitted.
 *  - delivered — inboundNonce on the DESTINATION endpoint: messages the destination
 *                accepted. null = the destination read failed (never treat as zero).
 *
 * `sent - delivered` is stranded value: messages that left and never landed.
 *
 * ⚠️ This REVERSES the old "outboundNonce is worthless" note. It is worthless as a
 * LIVENESS signal — a bricked corridor reads nonce 2 while a working one reads 0 — and
 * that is precisely the point: a bricked corridor reading 2 means TWO MESSAGES WERE SENT
 * INTO A CORRIDOR THAT CANNOT DELIVER. Useless for liveness, decisive for usage.
 */
export interface DeliverySnapshot {
  sent: number;
  delivered: number | null;
  /** UNTESTED discriminator: was the CURRENT config already in force at the block of
   *  the last send? `false` = the config changed after the last send, so nothing has
   *  ever crossed under what we score (delivery history is stale evidence — the
   *  lesson that produced this field). `true` = at least the last send happened
   *  under this exact config.
   *  Absent/null = not measured (the archival read is run only on corridors that
   *  already carry a block-class finding — see scripts/verify-block-claims.ts). */
  sentUnderCurrentConfig?: boolean | null;
}

/** One destination route's config as seen from the watched OFT's source chain. */
export interface RouteSnapshot {
  eid: number;
  chainName: string;
  chainKey: string | null;      // LZ chainKey of the destination (e.g. "ethereum") — for DVN name lookup
  sendLibrary: string | null;
  sendLibIsDefault: boolean | null;
  receiveLibrary: string | null;
  receiveLibIsDefault: boolean | null;
  uln: UlnSnapshot | null;
  // Receive-side ULN from the destination chain (needed for mismatch detection)
  receiveUln: UlnSnapshot | null;
  peer: string | null;
  peerAddress: string | null;   // the peer OFT address on the destination chain
  hasEnforcedOptions: boolean | null; // true if setEnforcedOptions was called for this eid
  isActive: boolean;
  rpcConflict?: boolean; // true if a secondary RPC returned different DVN config for this route
  // Whether this corridor ACCEPTS A SEND (quoteSend probe). Not whether it delivers.
  sendability?: Sendability;
  // Messages actually sent vs actually delivered. Gates every block/strand claim.
  delivery?: DeliverySnapshot | null;
  // The DESTINATION's peer for this source chain. setPeer is one-directional: a source
  // peer with no matching peer back means quoteSend succeeds, tokens leave, and
  // lzReceive reverts on _getPeerOrRevert forever. null = unread, not "unset".
  reversePeer?: string | null;
  // true = destination peers back to this OFT; false = half-wired corridor; null = unread.
  peerSymmetric?: boolean | null;
}

/** Full point-in-time config snapshot for a watched OFT. */
export interface OftSnapshot {
  oft: string;
  chainId: number; // chain the OFT lives on (Mantle = 5000)
  capturedAt: number;
  owner: string | null;
  ownerIsContract: boolean | null;
  proxyAdmin: string | null;           // EIP-1967 admin slot (null if not a proxy or slot is zero)
  proxyAdminOwner: string | null;      // who controls upgrades
  proxyAdminIsMultisig: boolean | null; // true if GnosisSafe detected (getThreshold() returns > 0)
  // Does proxyAdminOwner have bytecode? Distinguishes a true EOA (no code — a single
  // key really can upgrade) from a non-Safe CONTRACT owner (timelock, custom multisig,
  // governance) that merely fails GnosisSafe detection. Without this the engine reports
  // every non-Safe contract as "an EOA" — the same over-assertion class as the
  // Fireblocks/EOA custody false positive. null = bytecode read failed (never scored).
  proxyAdminOwnerIsContract: boolean | null;
  routes: RouteSnapshot[];
}

// ── Chain registry ─────────────────────────────────────────────────────────
// Drives multi-chain scaling: every source chain Sentinel monitors is described
// by a ChainRef loaded from the committed chain-registry.json (public data only).

/** Cadence tier for a watched OFT — controls poll frequency (see scheduler). */
export type Tier = "critical" | "standard" | "longtail";

export interface ChainRpc { url: string; provider: string }

export interface ChainRef {
  chainKey: string;
  eid: number;
  chainId: number;
  eligible: boolean;
  etherscanFree: boolean;
  /** Multicall3 verified deployed at the canonical address on this chain.
   *  Absent/malformed in the registry ⇒ false ⇒ individual calls. */
  multicall3: boolean;
  rpcs: ChainRpc[];
}

export interface WatchedOft {
  ticker: string;
  address: string;
  chainId: number;
  // Cadence tier; optional so existing fixtures/callers default to "standard".
  tier?: Tier;
}

export interface DriftResult {
  drifted: boolean;
  reasons: string[];
}

/** Score/risk prediction if a single TIS remediation were applied. */
export interface PreflightResult {
  scoreBefore: number;
  riskBefore: RiskLevel;
  scoreAfter: number;
  riskAfter: RiskLevel;
}

/** A structured remediation proposal emitted alongside every verdict. */
export interface TransactionIntent {
  intent: string;           // e.g. "restore_dvn_redundancy" | "pin_receive_library"
  action: string;           // human-readable: what to do
  corridors?: string[];     // destination chain names affected (absent for non-route issues)
  dvnAddress?: string;
  dvnName?: string;
  currentState: string;
  targetState: string;
  reason: string;
  severity: Severity;
  preflight?: PreflightResult; // simulated outcome if this one issue were resolved
}

/**
 * Canonical, minimal record that gets hashed and attested on-chain.
 * The on-chain verdictHash = keccak256(JSON.stringify(pdr)).
 * Anyone can recompute: hash(this struct) == verdictHash in AuditRegistry.
 */
export interface PolicyDecisionRecord {
  oft: string;         // checksum address of the watched OFT
  chainId: number;     // Mantle mainnet (5000)
  findings: Finding[]; // full set of checks run — severity "PASS" + non-pass
  score: number;
  riskLevel: RiskLevel;
  evaluatedAt: number; // unix ms; matches what was hashed and submitted on-chain
  agentId: number;     // ERC-8004 token ID (SENTINEL_AGENT_ID env)
  rulesVersion: string; // "1.1.0" since custody declarations; attestations made under "1.0.0" stay valid as recorded
  // Provenance of the DVN metadata table that decided these findings. The rules are
  // deterministic, but they read this table — a DVN deprecated upstream flips a severity
  // without any config changing. Recording the hash makes the verdict reproducible against
  // the exact ground truth it was computed from, rather than against whatever the API
  // happens to serve today. Added in rulesVersion 3.0.0; absent on earlier PDRs.
  dvnMetaHash: string;      // keccak256 of the canonical DVN table
  dvnMetaFetchedAt: number; // unix ms the table was fetched (may predate evaluatedAt when serving a stale cache)
}

/** A stored Sentinel verdict — the off-chain record mirrored by an on-chain attestation. */
/** Which producer created a verdict. Alert, post and feed copy is driven off this
 *  field rather than off where the composing code happens to sit.
 *
 *  Both alert sites used to say "drift" because they were reached from the drift
 *  producer FIRST — positional truth. Once the weak-config producer started
 *  calling the same composer, the copy asserted a drift that never happened, for
 *  live third-party tokens. Position is not evidence; a named field is. Absent
 *  (an older persisted verdict) means "we do not know", and the copy must then
 *  assert neither drift nor persistence rather than guess. */
export type VerdictPath = "drift" | "weak-config";

export interface SentinelVerdict {
  oft: string;
  chainId: number;
  ticker: string;
  score: number;
  riskLevel: RiskLevel;
  verdict: string;
  reasons: string[];
  verdictHash: string;
  /** Optional because verdicts persisted before this field existed have no value
   *  for it; readers must handle undefined rather than defaulting to "drift". */
  verdictPath?: VerdictPath;
  attestationId?: string;
  attestTxHash?: string;
  alertTxHash?: string;
  capturedAt: number;
  tis?: TransactionIntent[];
  pdr?: PolicyDecisionRecord; // stored so anyone can recompute verdictHash = hash(pdr)
}
