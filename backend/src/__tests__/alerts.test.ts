import { afterEach, describe, expect, it, vi } from "vitest";
import { oftExplorerUrl, parseTeamTelegramContacts, telegramRecipients } from "../services/alerts.js";
import type { SentinelVerdict } from "../types.js";

const verdict: SentinelVerdict = {
  oft: "0x1111111111111111111111111111111111111111",
  chainId: 5000,
  ticker: "TKNA",
  score: 25,
  riskLevel: "CRITICAL",
  verdict: "Config drifted into CRITICAL.",
  reasons: ["ethereum: required DVN count dropped 2 to 1"],
  verdictHash: "0xabc",
  capturedAt: 1,
};

describe("OFT explorer links resolve per watched chain", () => {
  const addr = "0x2222222222222222222222222222222222222222";

  it("links Ethereum OFTs to etherscan", () => {
    expect(oftExplorerUrl(1, addr)).toBe(`https://etherscan.io/address/${addr}`);
  });

  it("links Base OFTs to basescan", () => {
    expect(oftExplorerUrl(8453, addr)).toBe(`https://basescan.org/address/${addr}`);
  });

  it("links Mantle OFTs to mantlescan", () => {
    expect(oftExplorerUrl(5000, addr)).toBe(`https://mantlescan.xyz/address/${addr}`);
  });

  it("falls back to blockscan for a chain with no mapped explorer", () => {
    expect(oftExplorerUrl(999999, addr)).toBe(`https://blockscan.com/address/${addr}`);
  });
});

describe("Telegram alert routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses ticker/address contact maps with comma-separated or array chat ids", () => {
    const contacts = parseTeamTelegramContacts(JSON.stringify({
      TKNA: ["123", "@team_a"],
      "0x1111111111111111111111111111111111111111": "456, @ops",
    }));

    expect(contacts.tkna).toEqual(["123", "@team_a"]);
    expect(contacts["0x1111111111111111111111111111111111111111"]).toEqual(["456", "@ops"]);
  });

  it("returns an empty map for missing or invalid JSON", () => {
    expect(parseTeamTelegramContacts()).toEqual({});
    expect(parseTeamTelegramContacts("{not-json")).toEqual({});
  });

  it("resolves public channel plus OFT team contacts by ticker and address", () => {
    vi.stubEnv("TELEGRAM_PUBLIC_ALERT_CHAT_ID", "@oft_public");
    vi.stubEnv("TELEGRAM_TEAM_ALERTS_JSON", JSON.stringify({
      tkna: ["123", "123"],
      "0x1111111111111111111111111111111111111111": ["456"],
    }));

    expect(telegramRecipients(verdict)).toEqual({
      publicChatId: "@oft_public",
      teamChatIds: ["123", "456"],
    });
  });

  it("keeps the legacy TELEGRAM_ALERT_CHAT_ID as public-channel fallback", () => {
    vi.stubEnv("TELEGRAM_ALERT_CHAT_ID", "@legacy_public");

    expect(telegramRecipients(verdict)).toEqual({
      publicChatId: "@legacy_public",
      teamChatIds: [],
    });
  });
});

// ── Alert copy must state what happened, not what usually happens ────────────
//
// Both alert sites used to hardcode "drift" and "attested on-chain" because of
// where they sat in the code, not because either was true. During the first live
// Flare cycle they fired for FLR and DINERO — third-party tokens with persistent
// CRITICAL configs and NO drift, whose attestations the scope gate had just
// refused — asserting a config change that never happened and an on-chain write
// that never happened. This suite pins the copy to the two facts.
//
// These assert the message text dispatchAlert actually composes, not the helper
// return values, because the defect was in composition. With TELEGRAM_BOT_TOKEN
// unset, sendTelegram logs "[alert:telegram:<label>:mock] <text>" instead of
// sending, and postX logs "[alert:x:mock] <text>" — so console.log is the seam.

import { dispatchAlert, findingPhrase, attestationPhrase } from "../services/alerts.js";

const OWNER = "0x3333333333333333333333333333333333333333";

function baseVerdict(over: Partial<SentinelVerdict>): SentinelVerdict {
  return {
    oft: "0x1111111111111111111111111111111111111111",
    chainId: 5000,
    ticker: "TKNA",
    score: 25,
    riskLevel: "CRITICAL",
    verdict: "…",
    reasons: ["ethereum: receive library is the upgradeable default"],
    verdictHash: "0xabc",
    capturedAt: 1,
    ...over,
  };
}

/** Run dispatchAlert with alerts muted-but-composed, returning every logged line. */
async function captureCopy(v: SentinelVerdict): Promise<string> {
  for (const n of ["TELEGRAM_BOT_TOKEN", "ALERT_BUS_ADDRESS"]) vi.stubEnv(n, undefined);
  vi.stubEnv("TELEGRAM_PUBLIC_ALERT_CHAT_ID", "@oft_public");
  vi.stubEnv("TELEGRAM_TEAM_ALERTS_JSON", JSON.stringify({ tkna: ["123"] }));
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await dispatchAlert(v, OWNER); // owner passed so account() is never needed
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

describe("alert copy asserts only what the verdict can prove", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // Added 2026-08-09, and load-bearing from that date. Clean assets now reach
  // the weak-config producer so that they get one signed record each, and the
  // ONLY thing keeping that from also pushing "TKNA — PASS" into the public
  // Telegram channel on every fleet change is dispatchAlert's early return on
  // PASS. Nothing asserted it. Composing no copy at all is the observable:
  // with the guard removed this function builds and logs a full message.
  it("says nothing at all about an asset that passed", async () => {
    const copy = await captureCopy(baseVerdict({
      riskLevel: "PASS",
      score: 100,
      reasons: [],
      verdict: "Config read clean, no drift (score 100/100)",
      verdictPath: "weak-config",
      attestTxHash: "0xfeed",
    }));

    expect(copy).toBe("");
    expect(copy).not.toContain("TKNA");
  });

  it("case 1: a weak-config verdict REFUSED BY SCOPE asserts neither attestation nor drift", async () => {
    const copy = await captureCopy(baseVerdict({ verdictPath: "weak-config" })); // no attestTxHash

    expect(copy).toContain("pre-existing config risk, no drift");
    expect(copy).toContain("not attested on-chain");
    expect(copy).toContain("Attestation: not written");

    // The two false claims that actually shipped, by their exact old wording.
    expect(copy).not.toContain("drift detected");
    expect(copy).not.toContain("drifted into");
    expect(copy).not.toContain("Flagged and attested on-chain");
    expect(copy).not.toContain("Attestation: unavailable");
  });

  it("case 2: a genuine DRIFT verdict that WAS attested asserts both", async () => {
    const copy = await captureCopy(baseVerdict({
      verdictPath: "drift",
      attestTxHash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      attestationId: "7",
    }));

    expect(copy).toContain("config drift detected");
    expect(copy).toContain("attested on-chain");
    expect(copy).not.toContain("not attested on-chain");
    expect(copy).toContain("0xdeadbeef"); // the hash backing the claim is shown
    expect(copy).not.toContain("not written");
  });

  it("case 3: a verdict whose attest() FAILED still reports the drift but claims no attestation", async () => {
    // The distinction that would otherwise rot: "we tried and it failed" is not
    // "we never tried", and neither is "we attested". Drift is still true here.
    const copy = await captureCopy(baseVerdict({ verdictPath: "drift" })); // attest threw → no hash

    expect(copy).toContain("config drift detected"); // this DID happen
    expect(copy).toContain("not attested on-chain"); // this did NOT
    expect(copy).toContain("Attestation: not written");
    expect(copy).not.toContain("Flagged and attested on-chain");
  });

  it("asserts neither when verdictPath is absent (an older persisted verdict)", async () => {
    const copy = await captureCopy(baseVerdict({}));

    expect(copy).toContain("config finding");
    expect(copy).toContain("not attested on-chain");
    expect(copy).not.toContain("drift");
    expect(copy).not.toContain("pre-existing config risk");
  });
});

describe("copy phrase helpers", () => {
  it("findingPhrase names the producer, and never guesses when it is absent", () => {
    expect(findingPhrase(baseVerdict({ verdictPath: "drift" }))).toBe("config drift detected");
    expect(findingPhrase(baseVerdict({ verdictPath: "weak-config" }))).toBe("pre-existing config risk, no drift");
    expect(findingPhrase(baseVerdict({}))).toBe("config finding");
  });

  it("attestationPhrase keys off attestTxHash only", () => {
    expect(attestationPhrase(baseVerdict({ attestTxHash: "0xabc" }))).toBe("attested on-chain");
    expect(attestationPhrase(baseVerdict({}))).toBe("not attested on-chain");
    // attestationId alone is not a transaction and must not imply one.
    expect(attestationPhrase(baseVerdict({ attestationId: "7" }))).toBe("not attested on-chain");
  });
});
