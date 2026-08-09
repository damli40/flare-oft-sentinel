import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dueForRepeat } from "../services/orchestrator.js";

// The re-ping cadence. An unchanged CRITICAL finding is said again twice a day,
// an unchanged AT_RISK once a week, and a PASS never — there is nothing to be
// reminded of.
//
// The cadence governs ALERTS ONLY. Attestation stays tied to the fingerprint,
// so a repeat never writes a second identical verdict to the registry. That
// separation is the point of the feature and is asserted in orchestrator's own
// tests, not here; this file owns the timing predicate.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("dueForRepeat", () => {
  const now = 1_760_000_000_000;

  it("stays quiet for a CRITICAL finding inside the 12-hour window", () => {
    expect(dueForRepeat("CRITICAL", now - 11 * HOUR, now)).toBe(false);
  });

  it("re-pings a CRITICAL finding at exactly 12 hours", () => {
    // Boundary is inclusive: a cycle landing precisely on the interval must fire
    // rather than wait a whole extra period for the next one.
    expect(dueForRepeat("CRITICAL", now - 12 * HOUR, now)).toBe(true);
  });

  it("re-pings a CRITICAL finding well past the window", () => {
    expect(dueForRepeat("CRITICAL", now - 3 * DAY, now)).toBe(true);
  });

  it("holds an AT_RISK finding for a week, not a day", () => {
    expect(dueForRepeat("AT_RISK", now - 3 * DAY, now)).toBe(false);
    expect(dueForRepeat("AT_RISK", now - 7 * DAY, now)).toBe(true);
  });

  it("never re-pings a PASS", () => {
    // Absent from the cadence map entirely. A year of silence is correct.
    expect(dueForRepeat("PASS", now - 365 * DAY, now)).toBe(false);
  });

  it("never re-pings an unrecognised risk level", () => {
    // Fails closed the same way the attest gate does: a level we cannot
    // interpret must not be granted a cadence by accident.
    expect(dueForRepeat("SOMETHING_NEW", now - 365 * DAY, now)).toBe(false);
  });

  it("does not re-ping something that has never fired", () => {
    // firedAt null means no alert has gone out, so this is a first-sight case
    // and belongs to the normal path — which alerts AND attests. Returning true
    // here would suppress the attestation on the one cycle that needs it.
    expect(dueForRepeat("CRITICAL", null, now)).toBe(false);
  });

  it("does not re-ping on a clock that ran backwards", () => {
    // NTP correction, container migration, restored volume. A negative age must
    // read as "recent", never as "overdue".
    expect(dueForRepeat("CRITICAL", now + 2 * HOUR, now)).toBe(false);
  });
});

describe("cadence is tunable without a deploy", () => {
  const KEY = "REPING_CRITICAL_MINUTES";
  let saved: string | undefined;

  beforeEach(() => { saved = process.env[KEY]; });
  afterEach(() => { saved === undefined ? delete process.env[KEY] : (process.env[KEY] = saved); });

  it("documents that the override is read at module load, not per call", async () => {
    // Honest test: REPEAT_AFTER_MS is built once when the module is imported, so
    // setting the variable now does NOT change an already-imported module. An
    // operator changing the cadence has to restart the service, which on Railway
    // is what setting the variable does anyway. Asserting the real behaviour
    // stops someone "fixing" a bug that is not there.
    process.env[KEY] = "1";
    const now = 1_760_000_000_000;
    expect(dueForRepeat("CRITICAL", now - 5 * MIN, now)).toBe(false);
  });
});
