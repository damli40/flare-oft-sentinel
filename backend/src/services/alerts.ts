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
import { sentinelChain as sentinelChainInfo, explorerBase } from "./chain-registry.js";

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
const SENTINEL_RPC = process.env.SENTINEL_RPC ?? sentinelChainInfo().defaultRpc;
const AGENT_ID = BigInt(process.env.SENTINEL_AGENT_ID ?? 1);
const NUDGE_MNT = "0.0001"; // dust nudge attached to the on-chain alert

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

// Identity comes from the chain registry, not literals. This module hardcoded
// both the label AND the native currency, so on a Flare instance every log line
// said "Mantle Sepolia" and every amount was quoted in MNT.
const sentinelChain = defineChain({
  id: SENTINEL_CHAIN_ID,
  name: sentinelChainInfo().name,
  nativeCurrency: sentinelChainInfo().nativeCurrency,
  rpcUrls: { default: { http: [SENTINEL_RPC] } },
});

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
  const wallet = createWalletClient({ account: acct, chain: sentinelChain, transport: http(SENTINEL_RPC) });
  const pub = createPublicClient({ chain: sentinelChain, transport: http(SENTINEL_RPC) });

  const txHash = await wallet.writeContract({
    address: alertBusAddress(),
    abi: ALERTBUS_ABI,
    functionName: "alert",
    args: [getAddress(oft), watchedChainId, getAddress(recipient), score, RISK_ENUM[risk], AGENT_ID, verdictURI],
    value: parseEther(NUDGE_MNT),
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
 * also a public X post. The OFT owner receives the dust MNT nudge so the warning
 * shows up in their wallet activity. Recipient falls back to the Sentinel signer
 * when the owner can't be resolved (the contract requires a non-zero recipient).
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
  const txLine = alertTxHash ? `AlertBus: ${hashRef(alertTxHash)}` : "AlertBus: not sent";
  // "unavailable" implied a transient outage. An absent hash means no attestation
  // was written — which is also the correct, expected state when the scope gate
  // refuses an asset — so state that, and do not imply a cause.
  const attestationLine = v.attestTxHash
    ? `Attestation: ${hashRef(v.attestTxHash)}`
    : "Attestation: not written";
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
    `${link("OFT ↗", oftExplorerUrl(v.chainId, v.oft))}  ·  ${
      v.attestTxHash
        ? (sentinelTxUrl(v.attestTxHash) ? link("Attestation ↗", sentinelTxUrl(v.attestTxHash)!) : code(v.attestTxHash))
        : "Attestation not written"
    }`,
    alertTxHash
      ? (sentinelTxUrl(alertTxHash) ? link("AlertBus ↗", sentinelTxUrl(alertTxHash)!) : code(alertTxHash))
      : "AlertBus not sent",
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

  if (v.riskLevel === "CRITICAL") {
    postX(`🚨 ${v.ticker} OFT ${v.riskLevel}: ${findingPhrase(v)} (score ${v.score}/100). ${v.reasons[0] ?? ""} Flagged by OFT Sentinel, ${attestationPhrase(v)}.`);
  }

  return alertTxHash;
}
