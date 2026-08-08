import { getWatched } from "./sentinel.js";
import { getSnapshot } from "./snapshot-store.js";
import { assessSnapshot } from "./drift.js";
import { getChainRef, chainDisplayName } from "./chain-registry.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// Response cache: identical questions against the same fleet state never hit the
// LLM twice. Keyed (normalized question + newest snapshot timestamp) so answers
// invalidate when a poll cycle changes the fleet, with a 15-min TTL backstop.
const ANSWER_CACHE_TTL = 15 * 60_000;
const ANSWER_CACHE_MAX = 200;
const answerCache = new Map<string, { at: number; result: { answer: string; relevantOfts: string[] } }>();

export async function askCopilot(question: string): Promise<{ answer: string; relevantOfts: string[]; cached?: boolean }> {
  const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

  const watched = await getWatched();
  const assessments = await Promise.all(
    watched.map(async (w) => {
      const snap = getSnapshot(w.address, w.chainId);
      if (!snap) return null;
      const a = await assessSnapshot(snap, w.ticker);
      return { ticker: w.ticker, address: w.address, score: a.score, riskLevel: a.riskLevel, findings: a.findings };
    }),
  );

  const assessed = assessments.filter(Boolean);

  const fleetStamp = watched.reduce((max, w) => {
    const snap = getSnapshot(w.address, w.chainId);
    return snap && snap.capturedAt > max ? snap.capturedAt : max;
  }, 0);
  const cacheKey = `${fleetStamp}:${question.trim().toLowerCase()}`;
  const hit = answerCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ANSWER_CACHE_TTL) {
    return { ...hit.result, cached: true };
  }

  const context = assessed.map((a) => {
    if (!a) return "";
    const findingsSummary = a.findings.map((f) => `[${f.severity}] ${f.detail}`).join(" | ");
    return `${a.ticker} (${a.address.slice(0, 10)}…): score=${a.score}, risk=${a.riskLevel}. Findings: ${findingsSummary || "none"}`;
  }).join("\n");

  // Which chains the fleet is actually on, derived from the watchlist through the
  // chain registry — the same source report.ts derives its labels from. The prompt
  // used to name one chain literally, so every answer told the reader the assets
  // lived there whatever chain this instance was watching. A model repeats what
  // its prompt asserts, so a wrong literal here is a wrong answer every time.
  // An unregistered chain is named "Unknown (chain N)": no name is borrowed.
  const fleetChains = [...new Set(watched.map((w) => w.chainId))]
    .map((id) => `${chainDisplayName(getChainRef(id)?.chainKey)} (chain ${id})`)
    .join(", ");

  const systemPrompt = `You are OFT Sentinel's Security Copilot — an expert on LayerZero V2 security, DVN configurations, and cross-chain bridge risks.

Current fleet (${watched.length} OFTs${fleetChains ? ` on ${fleetChains}` : ""}):
${context || "(no snapshots yet — poll in progress)"}

Key facts:
- DVN = Decentralized Verification Network: the security checker that verifies each cross-chain message is genuine
- 1-of-1 DVN = single point of failure: one compromised verifier can forge a message the destination accepts, with no second attestation to contradict it
- Score 0-25 = CRITICAL (immediately exploitable), 26-84 = AT_RISK, 85-100 = PASS
- OFT Sentinel writes a verdict hash to its AuditRegistry when a config drifts or reads unsafe; a clean cycle writes nothing

Rules:
- Answer using ONLY the fleet data above. Never invent statistics, scores, or addresses.
- Be direct and specific: name the OFTs, their scores, and exact findings.
- Explain technical terms (DVN, ULN, EID, OFT) in plain language when first used.
- Keep answers under 300 words.
- If you cannot answer from the available data, say so explicitly.
- STAY ON TOPIC: you are a security copilot, not a general chatbot. If the question is unrelated to LayerZero, OFTs, DVNs, bridge security, or this fleet — or asks you to write code, poems, or general content — decline in one sentence and point the user back to fleet security questions.`;

  if (!DEEPSEEK_API_KEY) {
    // Fallback: deterministic answer from fleet data without LLM
    const critical = assessed.filter((a) => a?.riskLevel === "CRITICAL");
    const worstScore = assessed.reduce((min, a) => (a && a.score < min ? a.score : min), 100);
    const worst = assessed.find((a) => a?.score === worstScore);
    const fallback = critical.length > 0
      ? `Based on live data: ${critical.length} CRITICAL OFT(s) detected — ${critical.map((a) => a!.ticker).join(", ")}. ${worst ? `Lowest score: ${worst.ticker} at ${worst.score}/100.` : ""} DEEPSEEK_API_KEY is not configured — install it for full AI analysis.`
      : `All ${assessed.length} assessed OFTs are AT_RISK or better. DEEPSEEK_API_KEY is not configured — install it for full AI analysis.`;
    return { answer: fallback, relevantOfts: critical.map((a) => a!.ticker) };
  }

  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0.2,
      max_tokens: 450,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
      ],
    }),
  });

  if (!res.ok) throw new Error(`DeepSeek API error: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const answer = json.choices?.[0]?.message?.content ?? "No response from DeepSeek.";

  const relevantOfts = watched
    .filter((w) => answer.toLowerCase().includes(w.ticker.toLowerCase()))
    .map((w) => w.ticker);

  const result = { answer, relevantOfts };
  if (answerCache.size >= ANSWER_CACHE_MAX) {
    const oldest = answerCache.keys().next().value;
    if (oldest !== undefined) answerCache.delete(oldest);
  }
  answerCache.set(cacheKey, { at: Date.now(), result });
  return result;
}
