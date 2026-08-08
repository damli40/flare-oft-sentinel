import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Severity } from "../types.js";

// Registry of findings already disclosed through the confidential partner channel. Findings are
// confidential per the standing arrangement; the registry exists so a digest can never
// re-send something already delivered, and so a retracted finding (a false positive we
// withdrew) can never sneak back into a later digest without a human decision.
//
// Same JSON-persistence pattern as custody.ts: resolved per call, never cached —
// the file lives on the Railway volume (or backend/data locally, gitignored) and
// manual edits must take effect without a restart. Entries are keyed by
// `${chainId}:${oft}:${check}`: one finding identity per deployment per rule.
// Corridors are informational — a known finding surfacing on one more corridor is
// not re-sent; a severity escalation is.
const DISCLOSURE_LOG_BASENAME = "disclosure-log.json";

export type SentStatus = "sent" | "acked" | "superseded" | "withdrawn";

export interface DisclosureEntry {
  oft: string;
  chainId: number;
  ticker: string;
  check: string;
  severity: Severity;
  digestId: string;
  sentAt: string; // ISO date the digest went out
  status: SentStatus;
  corridors?: string[];
  note?: string;
}

/** A finding as it comes out of a scan, considered for the next digest. */
export interface DigestCandidate {
  oft: string;
  chainId: number;
  ticker: string;
  check: string;
  severity: Severity;
  detail?: string;
  corridors?: string[];
}

export type SuppressReason = "already-sent" | "acked" | "superseded" | "withdrawn" | "pass";

export type DigestDecision =
  | { action: "send"; reason: "new" | "escalated"; candidate: DigestCandidate; prior?: DisclosureEntry }
  | { action: "suppress"; reason: SuppressReason; candidate: DigestCandidate; prior?: DisclosureEntry };

// PASS/UNKNOWN never rank; escalation means strictly climbing this ladder.
const SEVERITY_RANK: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export function disclosureLogFile(): string {
  const dataDir = process.env.DATA_DIR
    ? resolve(process.env.DATA_DIR)
    : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
  return join(dataDir, DISCLOSURE_LOG_BASENAME);
}

function entryKey(oft: string, chainId: number, check: string): string {
  return `${chainId}:${oft.toLowerCase()}:${check}`;
}

/** Malformed or missing file reads as an empty log — but an empty log means every
 * finding looks new, so the digest CLI prints the log size up front: a human sees
 * "0 previously sent" and stops before re-sending history. */
export function loadDisclosureLog(): DisclosureEntry[] {
  const file = disclosureLogFile();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { entries?: DisclosureEntry[] };
    return Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

function saveDisclosureLog(entries: DisclosureEntry[]): void {
  const file = disclosureLogFile();
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Pretty-printed: the file doubles as the human-auditable disclosure trail.
  writeFileSync(file, JSON.stringify({ entries }, null, 2));
}

export function priorEntry(oft: string, chainId: number, check: string): DisclosureEntry | null {
  const wanted = entryKey(oft, chainId, check);
  return loadDisclosureLog().find((e) => entryKey(e.oft, e.chainId, e.check) === wanted) ?? null;
}

/**
 * Decide, per candidate, whether the next digest may include it.
 * - never sent → send (new)
 * - sent/acked at a lower severity → send (escalated), prior attached for context
 * - sent/acked at the same or higher severity → suppress
 * - withdrawn or superseded → ALWAYS suppress, whatever the severity: a finding we
 *   retracted re-entering a digest is a human decision (clear the status first),
 *   never an automatic one — that is exactly how a refuted false positive would
 *   get re-sent.
 */
export function decideDigest(candidates: DigestCandidate[]): DigestDecision[] {
  return candidates.map((candidate) => {
    if (!(candidate.severity in SEVERITY_RANK)) {
      return { action: "suppress", reason: "pass", candidate };
    }
    const prior = priorEntry(candidate.oft, candidate.chainId, candidate.check);
    if (!prior) return { action: "send", reason: "new", candidate };

    if (prior.status === "withdrawn" || prior.status === "superseded") {
      return { action: "suppress", reason: prior.status, candidate, prior };
    }
    const escalated =
      (SEVERITY_RANK[candidate.severity] ?? 0) > (SEVERITY_RANK[prior.severity] ?? 0);
    if (escalated) return { action: "send", reason: "escalated", candidate, prior };
    return {
      action: "suppress",
      reason: prior.status === "acked" ? "acked" : "already-sent",
      candidate,
      prior,
    };
  });
}

/** Mark candidates as sent in `digestId`. Upserts by key: re-sending (e.g. an
 * escalation) replaces the old entry so the log holds the latest disclosed state. */
export function recordSent(
  candidates: DigestCandidate[],
  digestId: string,
  sentAt: string = new Date().toISOString().slice(0, 10),
): void {
  const entries = loadDisclosureLog();
  const byKey = new Map(entries.map((e) => [entryKey(e.oft, e.chainId, e.check), e]));
  for (const c of candidates) {
    byKey.set(entryKey(c.oft, c.chainId, c.check), {
      oft: c.oft,
      chainId: c.chainId,
      ticker: c.ticker,
      check: c.check,
      severity: c.severity,
      digestId,
      sentAt,
      status: "sent",
      ...(c.corridors?.length ? { corridors: c.corridors } : {}),
    });
  }
  saveDisclosureLog([...byKey.values()]);
}

/** Flip an entry's lifecycle status (acked / superseded / withdrawn). */
export function setStatus(
  oft: string,
  chainId: number,
  check: string,
  status: SentStatus,
  note?: string,
): boolean {
  const entries = loadDisclosureLog();
  const wanted = entryKey(oft, chainId, check);
  const entry = entries.find((e) => entryKey(e.oft, e.chainId, e.check) === wanted);
  if (!entry) return false;
  entry.status = status;
  if (note !== undefined) entry.note = note;
  saveDisclosureLog(entries);
  return true;
}
