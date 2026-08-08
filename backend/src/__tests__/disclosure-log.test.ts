import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadDisclosureLog,
  priorEntry,
  decideDigest,
  recordSent,
  setStatus,
  disclosureLogFile,
  type DigestCandidate,
} from "../services/disclosure-log.js";

// Dummy assets only — real tickers/addresses/findings are channel-confidential
// and never appear in committable code.
const OFT_A = "0xAaAa111111111111111111111111111111111111";
const OFT_B = "0xBbBb222222222222222222222222222222222222";

function candidate(over: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    oft: OFT_A,
    chainId: 1,
    ticker: "TESTA",
    check: "Deprecated DVN",
    severity: "CRITICAL",
    detail: "synthetic finding",
    ...over,
  };
}

const dirs: string[] = [];

function withTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "disclosure-log-test-"));
  dirs.push(dir);
  vi.stubEnv("DATA_DIR", dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadDisclosureLog", () => {
  it("returns an empty log when the file does not exist", () => {
    withTempDataDir();
    expect(loadDisclosureLog()).toEqual([]);
  });

  it("returns an empty log on malformed JSON instead of throwing", () => {
    const dir = withTempDataDir();
    writeFileSync(join(dir, "disclosure-log.json"), "{ not json");
    expect(loadDisclosureLog()).toEqual([]);
  });
});

describe("recordSent + priorEntry", () => {
  it("records candidates as sent and finds them case-insensitively on address", () => {
    withTempDataDir();
    recordSent([candidate()], "digest-test-1", "2026-07-15");

    const prior = priorEntry(OFT_A.toLowerCase(), 1, "Deprecated DVN");
    expect(prior).not.toBeNull();
    expect(prior!.status).toBe("sent");
    expect(prior!.digestId).toBe("digest-test-1");
    expect(prior!.sentAt).toBe("2026-07-15");
    expect(prior!.severity).toBe("CRITICAL");
  });

  it("keys by chainId:address:check — different chain or check misses", () => {
    withTempDataDir();
    recordSent([candidate()], "digest-test-1");

    expect(priorEntry(OFT_A, 8453, "Deprecated DVN")).toBeNull();
    expect(priorEntry(OFT_A, 1, "Owner EOA")).toBeNull();
    expect(priorEntry(OFT_B, 1, "Deprecated DVN")).toBeNull();
  });

  it("upserts on re-record: one entry per key, latest digest wins", () => {
    withTempDataDir();
    recordSent([candidate({ severity: "HIGH" })], "digest-test-1", "2026-07-10");
    recordSent([candidate({ severity: "CRITICAL" })], "digest-test-2", "2026-07-15");

    const log = loadDisclosureLog();
    expect(log).toHaveLength(1);
    expect(log[0].digestId).toBe("digest-test-2");
    expect(log[0].severity).toBe("CRITICAL");
  });

  it("persists to DATA_DIR as pretty JSON a human can hand-edit", () => {
    const dir = withTempDataDir();
    recordSent([candidate()], "digest-test-1");
    const raw = readFileSync(disclosureLogFile(), "utf8");
    expect(raw).toContain("\n");
    expect(JSON.parse(raw).entries).toHaveLength(1);
    expect(disclosureLogFile()).toBe(join(dir, "disclosure-log.json"));
  });
});

describe("decideDigest", () => {
  it("marks a never-sent finding as send/new", () => {
    withTempDataDir();
    const [d] = decideDigest([candidate()]);
    expect(d.action).toBe("send");
    expect(d.reason).toBe("new");
  });

  it("suppresses a finding already sent at the same severity", () => {
    withTempDataDir();
    recordSent([candidate()], "digest-test-1");
    const [d] = decideDigest([candidate()]);
    expect(d.action).toBe("suppress");
    expect(d.reason).toBe("already-sent");
  });

  it("suppresses a finding already sent at a HIGHER severity", () => {
    withTempDataDir();
    recordSent([candidate({ severity: "CRITICAL" })], "digest-test-1");
    const [d] = decideDigest([candidate({ severity: "MEDIUM" })]);
    expect(d.action).toBe("suppress");
    expect(d.reason).toBe("already-sent");
  });

  it("re-sends when severity escalated above what was sent", () => {
    withTempDataDir();
    recordSent([candidate({ severity: "MEDIUM" })], "digest-test-1");
    const [d] = decideDigest([candidate({ severity: "CRITICAL" })]);
    expect(d.action).toBe("send");
    expect(d.reason).toBe("escalated");
    expect(d.prior?.severity).toBe("MEDIUM");
  });

  it("suppresses acked findings with reason acked", () => {
    withTempDataDir();
    recordSent([candidate()], "digest-test-1");
    setStatus(OFT_A, 1, "Deprecated DVN", "acked");
    const [d] = decideDigest([candidate()]);
    expect(d.action).toBe("suppress");
    expect(d.reason).toBe("acked");
  });

  it("suppresses withdrawn findings even when severity escalated — needs manual review, never auto-resend", () => {
    withTempDataDir();
    recordSent([candidate({ severity: "LOW" })], "digest-test-1");
    setStatus(OFT_A, 1, "Deprecated DVN", "withdrawn", "refuted on-chain");
    const [d] = decideDigest([candidate({ severity: "CRITICAL" })]);
    expect(d.action).toBe("suppress");
    expect(d.reason).toBe("withdrawn");
  });

  it("suppresses PASS candidates outright", () => {
    withTempDataDir();
    const [d] = decideDigest([candidate({ severity: "PASS" })]);
    expect(d.action).toBe("suppress");
    expect(d.reason).toBe("pass");
  });

  it("handles a mixed batch and keeps candidate association", () => {
    withTempDataDir();
    recordSent([candidate()], "digest-test-1");
    const fresh = candidate({ oft: OFT_B, ticker: "TESTB", check: "Owner EOA", severity: "HIGH" });
    const decisions = decideDigest([candidate(), fresh]);
    expect(decisions[0].action).toBe("suppress");
    expect(decisions[1].action).toBe("send");
    expect(decisions[1].candidate.ticker).toBe("TESTB");
  });
});

describe("setStatus", () => {
  it("updates status and note on an existing entry", () => {
    withTempDataDir();
    recordSent([candidate()], "digest-test-1");
    expect(setStatus(OFT_A, 1, "Deprecated DVN", "superseded", "amended in digest-2")).toBe(true);
    const prior = priorEntry(OFT_A, 1, "Deprecated DVN");
    expect(prior!.status).toBe("superseded");
    expect(prior!.note).toBe("amended in digest-2");
  });

  it("returns false when the entry does not exist", () => {
    withTempDataDir();
    expect(setStatus(OFT_A, 1, "No Such Check", "acked")).toBe(false);
  });
});
