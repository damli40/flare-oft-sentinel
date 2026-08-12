import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  parseEther,
  getAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RiskLevel, SentinelVerdict } from "../types.js";
// Aliased: this module already has a local `sentinelChain` (the viem chain object).
import { sentinelChain as sentinelChainInfo, explorerBase, sentinelRpcUrl } from "./chain-registry.js";

// AlertBus.alert(oft, chainId, recipient, score, risk, agentId, verdictURI) payable
const ALERTBUS_ABI = [
  {
    name: "alert",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "oft", type: "address" },
      { name: "chainId", type: "uint32" },
      { name: "recipient", type: "address" },
      { name: "score", type: "uint8" },
      { name: "risk", type: "uint8" },
      { name: "agentId", type: "uint256" },
      { name: "verdictURI", type: "string" },
    ],
    outputs: [],
  },
] as const;

const RISK_ENUM: Record<RiskLevel, number> = { PASS: 1, AT_RISK: 2, CRITICAL: 4 };

const SENTINEL_CHAIN_ID = Number(process.env.SENTINEL_CHAIN_ID ?? 5003);
const AGENT_ID = BigInt(process.env.SENTINEL_AGENT_ID ?? 1);
// Dust nudge attached to the on-chain alert, denominated in the SENTINEL CHAIN's
// native unit — FLR here, MNT on Mantle. It was named NUDGE_MNT and documented as
// "dust MNT nudge" while the amount was already chain-agnostic, which is the same
// hardcoded-Mantle vocabulary the explorer and nativeCurrency fixes removed from
// the rest of this file. The value never was Mantle-specific; only the name was.
const NUDGE_NATIVE = "0.0001";

// Attestation and AlertBus links point at the chain THIS INSTANCE's contracts
// live on, resolved from the same env the attestor signs against — so the link
// and the transaction can never disagree. This was hardcoded to Mantle Sepolia,
// which meant a real Flare attestation hash rendered a sepolia.mantlescan.xyz
// URL that 404s: a proof link that disproves nothing.
function sentinelExplorer(): string | null {
  return sentinelChainInfo().explorer;
}

/** Address link on the WATCHED chain's explorer — the OFT lives there, which is
 *  not necessarily where our contracts live. Falls back to blockscan's
 *  cross-chain address search when we have no verified explorer for the chain;
 *  that page resolves by address, so it is honest rather than wrong. */
export function oftExplorerUrl(chainId: number, address: string): string {
  const base = explorerBase(chainId) ?? "https://blockscan.com";
  return `${base}/address/${address}`;
}

/** Tx link on the sentinel chain, or null when that chain has no known explorer.
 *  Null means callers render the bare hash — never a link we cannot stand behind. */
export function sentinelTxUrl(txHash: string): string | null {
  const base = sentinelExplorer();
  return base ? `${base}/tx/${txHash}` : null;
}

// LAZY, for the reason spelled out in attestor.ts: sentinelRpcUrl() throws for a
// chain with no configured endpoint, and this module is on the import path of
// every read-only script via services/sentinel.ts. Resolving at load turned a
// write-path safety check into an import-time crash for scripts that never write.
let _rpc: string | null = null;
function sentinelRpc(): string {
  return (_rpc ??= sentinelRpcUrl());
}
/** Identity comes from the chain registry, not literals. This module hardcoded
 *  both the label AND the native currency, so on a Flare instance every log line
 *  said "Mantle Sepolia" and every amount was quoted in MNT. */
function buildChain() {
  return defineChain({
    id: SENTINEL_CHAIN_ID,
    name: sentinelChainInfo().name,
    nativeCurrency: sentinelChainInfo().nativeCurrency,
    rpcUrls: { default: { http: [sentinelRpc()] } },
  });
}
// See attestor.ts: typed from buildChain, not from defineChain, or viem loses the
// literal chain type and every writeContract call demands an explicit `chain`.
let _chain: ReturnType<typeof buildChain> | null = null;
function sentinelChainObj(): ReturnType<typeof buildChain> {
  return (_chain ??= buildChain());
}

function account() {
  const pk = process.env.SENTINEL_PRIVATE_KEY;
  if (!pk) throw new Error("SENTINEL_PRIVATE_KEY not set");
  return privateKeyToAccount(pk as `0x${string}`);
}

function alertBusAddress(): Address {
  const a = process.env.ALERT_BUS_ADDRESS;
  if (!a) throw new Error("ALERT_BUS_ADDRESS not set");
  return getAddress(a) as Address;
}

/** Fire the on-chain AlertBus event + dust nudge to the OFT owner. */
async function fireOnChainAlert(
  oft: string,
  watchedChainId: number,
  recipient: string,
  score: number,
  risk: RiskLevel,
  verdictURI: string
): Promise<string> {
  const acct = account();
  const chain = sentinelChainObj();
  const wallet = createWalletClient({ account: acct, chain, transport: http(sentinelRpc()) });
  const pub = createPublicClient({ chain, transport: http(sentinelRpc()) });

  const txHash = await wallet.writeContract({
    address: alertBusAddress(),
    abi: ALERTBUS_ABI,
    functionName: "alert",
    args: [getAddress(oft), watchedChainId, getAddress(recipient), score, RISK_ENUM[risk], AGENT_ID, verdictURI],
    value: parseEther(NUDGE_NATIVE),
  });
  await pub.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parseChatList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(",").map((x) => x.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((x) => parseChatList(x));
  }
  return [];
}

export function parseTeamTelegramContacts(raw = process.env.TELEGRAM_TEAM_ALERTS_JSON): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key.toLowerCase(), unique(parseChatList(value))])
    );
  } catch {
    console.error("[alert:telegram] TELEGRAM_TEAM_ALERTS_JSON must be JSON like {\"TICKER\":[\"123\",\"@team\"]}");
    return {};
  }
}

export function telegramRecipients(v: SentinelVerdict): { publicChatId: string | null; teamChatIds: string[] } {
  const contacts = parseTeamTelegramContacts();
  const publicChatId = process.env.TELEGRAM_PUBLIC_ALERT_CHAT_ID ?? process.env.TELEGRAM_ALERT_CHAT_ID ?? null;
  const teamChatIds = unique([
    ...(contacts[v.ticker.toLowerCase()] ?? []),
    ...(contacts[v.oft.toLowerCase()] ?? []),
  ]);
  return { publicChatId, teamChatIds };
}

// ── Copy that states what happened, not what usually happens ─────────────────
// Two facts decide the wording, and both are read off the verdict rather than
// inferred from which function is composing the message:
//
//   what was FOUND   → v.verdictPath  ("drift" | "weak-config" | absent)
//   what was DONE    → v.attestTxHash (set only by attest()'s success branches)
//
// attestTxHash is the right key for the second because it is absent on BOTH a
// scope refusal and an attestation failure — so it separates "we signed this"
// from "we did not" without needing to know why, and it cannot claim an
// attestation that no transaction backs.

/** What was found. Absent verdictPath asserts neither drift nor persistence.
 *  Severity is deliberately NOT baked in here — callers render riskLevel
 *  separately, and repeating it made the copy read "CRITICAL … — CRITICAL".
 *  Wording is fault-neutral: it describes the configuration and echoes the
 *  engine's own "pre-existing risk, no drift" vocabulary; it grades nobody. */
export function findingPhrase(v: SentinelVerdict): string {
  if (v.verdictPath === "drift") return "config drift detected";
  if (v.verdictPath === "weak-config") return "pre-existing config risk, no drift";
  return "config finding";
}

/** What was done on-chain. Never hedges: an absent hash is stated as a fact,
 *  not as "unavailable" or "pending", both of which imply a reason we cannot
 *  prove from here. */
export function attestationPhrase(v: SentinelVerdict): string {
  return v.attestTxHash ? "attested on-chain" : "not attested on-chain";
}

/** Escape text for Telegram HTML parse_mode (only <, >, & are special). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** <code> address/hash → tap-to-copy in Telegram clients. */
function code(s: string): string {
  return `<code>${esc(s)}</code>`;
}

/** Hyperlink that hides the long explorer URL behind a short label. */
function link(label: string, url: string): string {
  return `<a href="${esc(url)}">${esc(label)}</a>`;
}

export async function sendTelegram(chatId: string | null, text: string, label: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) {
    console.log(`[alert:telegram:${label}:mock] ${text}`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch((e) => {
    console.error(`[alert:telegram:${label}] failed:`, e.message);
    return null;
  });
  if (res && !res.ok) {
    console.error(`[alert:telegram:${label}] failed ${res.status}:`, await res.text());
  }
}

function postX(text: string): void {
  // X posting is mocked for the demo — logged, not sent.
  console.log(`[alert:x:mock] ${text}`);
}

/**
 * Tiered escalation. AT_RISK → on-chain AlertBus + Telegram (private). CRITICAL →
 * also a public X post. The OFT owner receives a dust nudge in the sentinel chain's
 * native unit so the warning shows up in their wallet activity. Recipient falls back
 * to the Sentinel signer when the owner can't be resolved (the contract requires a
 * non-zero recipient).
 *
 * WHICH LEGS REPEAT, exactly — do not summarise this as "repeats are quiet",
 * because two of the four are not:
 *
 *   AlertBus write + gas   FIRST FIRE ONLY  (guarded, see the isRepeat branch)
 *   owner dust nudge       FIRST FIRE ONLY  (same branch — it rides the AlertBus tx)
 *   X post                 FIRST FIRE ONLY  (guarded at the foot of this function)
 *   Telegram, both chats   EVERY REPEAT     ← by design: reminding IS the feature
 *
 * The two guarded legs cost money or dust a third party's wallet. Telegram costs
 * nothing and is the entire point of a re-ping, so it is deliberately unguarded
 * and a persistent CRITICAL does reach the configured chats on every cadence tick.
 * If that cadence is unwanted for the PUBLIC chat specifically, the lever is
 * TELEGRAM_PUBLIC_ALERT_CHAT_ID or REPING_CRITICAL_MINUTES, not a change here —
 * and it is a product decision, not a bug.
 *
 * ⚠️ An earlier version of this comment claimed "EVERY outward leg is first-fire
 * only". That was false in the way that matters: postX is a console.log mock
 * (see above), so guarding it changed nothing observable, while the leg that
 * actually reaches humans on a 12-hour loop is the Telegram one and it is not
 * guarded. Stating it wrongly made a real, deliberate behaviour look accidental.
 */
export async function dispatchAlert(
  v: SentinelVerdict,
  ownerRecipient: string | null,
  opts: { isRepeat?: boolean } = {},
): Promise<string | undefined> {
  if (v.riskLevel === "PASS") return undefined;

  const recipient = ownerRecipient ?? account().address;
  const verdictURI = v.attestationId !== undefined ? `attestation:${v.attestationId}` : "";

  let alertTxHash: string | undefined;
  // A REPEAT is a reminder that nobody acted, not a new finding, and the
  // on-chain leg is not free: fireOnChainAlert sends a payable AlertBus
  // transaction AND a dust transfer to the OFT owner's wallet. Firing that on a
  // cadence would bill us gas every interval, forever, to tell the chain
  // something it already recorded — and would repeatedly dust a third party's
  // wallet with a warning they have already received. Telegram still goes out;
  // that is the whole point of a re-ping. The chain hears it once.
  if (opts.isRepeat) {
    console.log(`[alert] repeat for ${v.ticker} — Telegram only, AlertBus and owner nudge skipped`);
  } else {
    try {
      alertTxHash = await fireOnChainAlert(v.oft, v.chainId, recipient, v.score, v.riskLevel, verdictURI);
    } catch (e: any) {
      console.error("[alert] on-chain AlertBus failed:", e.shortMessage ?? e.message);
    }
  }

  // Same rule as the attestation line: an absent hash means it was not sent —
  // which covers both "ALERT_BUS_ADDRESS is unset" and "the write failed", and
  // we cannot tell those apart from here. "unavailable" implied only the latter.
  // Short "0x1234abcd…" label, linked when the sentinel chain has a known
  // explorer and rendered bare when it does not. A bare hash is still verifiable
  // by hand; a link to the wrong chain is not.
  const hashRef = (h: string) => {
    const url = sentinelTxUrl(h);
    return url ? link(h.slice(0, 10) + "…", url) : code(h);
  };
  // On a REPEAT both hashes are absent BY DESIGN — the orchestrator skips attest()
  // and this function skips fireOnChainAlert — so the absent-hash branch would say
  // "not sent" / "not written" about a finding whose first fire may well have
  // written both. That is the opposite of the truth, in the one message whose whole
  // job is to point at an existing record.
  //
  // It cannot say "sent on the first alert" either: on this instance
  // ALERT_BUS_ADDRESS is unset, so that leg has never run for any asset, and a
  // reminder claiming an AlertBus write would invent one. The only statement true
  // in every case is that this cycle wrote nothing and is not the cycle to read
  // hashes from.
  const NOT_THIS_CYCLE = "not re-sent (reminder — see the first alert for this finding)";
  const txLine = alertTxHash
    ? `AlertBus: ${hashRef(alertTxHash)}`
    : opts.isRepeat ? `AlertBus: ${NOT_THIS_CYCLE}` : "AlertBus: not sent";
  // "unavailable" implied a transient outage. On a FIRST fire an absent hash means
  // no attestation was written — which is also the correct, expected state when the
  // scope gate refuses an asset — so state that, and do not imply a cause.
  const attestationLine = v.attestTxHash
    ? `Attestation: ${hashRef(v.attestTxHash)}`
    : opts.isRepeat ? `Attestation: ${NOT_THIS_CYCLE}` : "Attestation: not written";
  const reasons = esc(v.reasons.length ? v.reasons.join("; ") : v.verdict);
  const ticker = esc(v.ticker);
  const emoji = v.riskLevel === "CRITICAL" ? "🚨" : "⚠️";
  const remediationBlock = v.tis && v.tis.length > 0
    ? `<blockquote expandable>` +
        v.tis.slice(0, 3).map((t, i) =>
          esc(`${i + 1}. [${t.severity}] ${t.action}${t.corridors?.length ? ` (${t.corridors.join(", ")})` : ""}`)
        ).join("\n") +
        `</blockquote>`
    : null;

  // Public CRITICAL gets a spaced, divider-sectioned layout; other severities stay compact.
  const DIV = "──────────────";
  const criticalPublicMessage = [
    `🚨 <b>OFT SENTINEL — CRITICAL</b>`,
    ``,
    `<b>${ticker}</b>  ·  Score <b>${v.score}/100</b>`,
    ``,
    DIV,
    `📋 <b>Reason</b>`,
    reasons,
    ``,
    DIV,
    `🔗 <b>On-chain</b>`,
    // Same correction as txLine/attestationLine above. The X post is first-fire
    // only now, but THIS message is Telegram and a re-ping is exactly when it goes
    // out, so the repeat wording has to be right here too.
    `${link("OFT ↗", oftExplorerUrl(v.chainId, v.oft))}  ·  ${
      v.attestTxHash
        ? (sentinelTxUrl(v.attestTxHash) ? link("Attestation ↗", sentinelTxUrl(v.attestTxHash)!) : code(v.attestTxHash))
        : opts.isRepeat ? "Attestation not re-written (reminder)" : "Attestation not written"
    }`,
    alertTxHash
      ? (sentinelTxUrl(alertTxHash) ? link("AlertBus ↗", sentinelTxUrl(alertTxHash)!) : code(alertTxHash))
      : opts.isRepeat ? "AlertBus not re-sent (reminder)" : "AlertBus not sent",
    ``,
    DIV,
    `🛠 <b>Remediation</b>`,
    remediationBlock ?? "No automated remediation available.",
  ].join("\n");
  const compactPublicMessage = [
    `${emoji} <b>OFT SENTINEL ALERT</b>`,
    `<b>${v.riskLevel}: ${ticker}</b>`,
    ``,
    `Score: <b>${v.score}/100</b>`,
    `Reason: ${reasons}`,
    ``,
    `OFT: ${link(v.oft, oftExplorerUrl(v.chainId, v.oft))}`,
    attestationLine,
    txLine,
  ].join("\n");
  const publicMessage = v.riskLevel === "CRITICAL" ? criticalPublicMessage : compactPublicMessage;
  const tisLines = remediationBlock ? [``, `<b>Remediation</b>`, remediationBlock] : [];
  const teamMessage = [
    `${emoji} <b>Action needed: ${ticker} — ${esc(findingPhrase(v))}</b>`,
    ``,
    `Risk: <b>${v.riskLevel}</b>`,
    `Score: <b>${v.score}/100</b>`,
    `Reason: ${reasons}`,
    ``,
    `OFT: ${code(v.oft)} (chain ${v.chainId})`,
    `Recipient: ${code(recipient)}`,
    ``,
    attestationLine,
    txLine,
    ...tisLines,
  ].join("\n");

  const recipients = telegramRecipients(v);
  const sends: Promise<void>[] = [];
  if (recipients.publicChatId) {
    sends.push(sendTelegram(recipients.publicChatId, publicMessage, "public"));
  } else {
    console.warn("[alert:telegram:public] TELEGRAM_PUBLIC_ALERT_CHAT_ID is not set");
  }
  for (const chatId of recipients.teamChatIds) {
    sends.push(sendTelegram(chatId, teamMessage, "team"));
  }
  await Promise.all(sends);

  // FIRST FIRE ONLY. A persistent CRITICAL re-pings every REPING_CRITICAL_MINUTES
  // (12h by default) and never stops while it stays unfixed, so an unguarded post
  // here is not "one alert": it is the same sentence about the same unchanged
  // config, twice a day, for as long as the config stays that way. A feed that
  // repeats itself teaches readers to ignore it, which costs the NEXT finding its
  // audience.
  //
  // Nothing becomes private. The escalation is unchanged and a NEW critical still
  // posts; only the reminder is silent, and a reminder was never news.
  //
  // Honest scope: postX is mocked to console.log today, so this guard is a
  // correctness fix for a path that is not yet live rather than a change anyone
  // can observe. It matters when the mock is replaced, and it is cheaper to be
  // right now than to remember later. The leg that DOES reach people on every
  // tick is Telegram, and that one is deliberately unguarded — see the table in
  // this function's docstring.
  if (v.riskLevel === "CRITICAL" && !opts.isRepeat) {
    postX(`🚨 ${v.ticker} OFT ${v.riskLevel}: ${findingPhrase(v)} (score ${v.score}/100). ${v.reasons[0] ?? ""} Flagged by OFT Sentinel, ${attestationPhrase(v)}.`);
  }

  return alertTxHash;
}
