import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  // This block used to assert the OPPOSITE — that the override is read at module
  // load and so cannot affect an already-imported module. That was an honest
  // description of the code at the time, and the comment argued it was fine
  // because a Railway variable change restarts the service anyway.
  //
  // The reasoning did not survive contact with the operator routes. Resetting the
  // weak-alert state and changing the cadence are one action, and a module-load
  // capture made them two: reset now, redeploy to re-read. Every other env read in
  // this instance had already moved to call time for that reason. The cadence is
  // now read per call, so these tests assert the new behaviour.
  it("reads the override per call, so a change takes effect without a restart", () => {
    process.env[KEY] = "1";
    const now = 1_760_000_000_000;
    // 5 minutes old against a 1-minute cadence: overdue.
    expect(dueForRepeat("CRITICAL", now - 5 * MIN, now)).toBe(true);
    // And the same call answers differently once the operator widens it again,
    // which is the property a module-load capture could not offer at all.
    process.env[KEY] = String(12 * 60);
    expect(dueForRepeat("CRITICAL", now - 5 * MIN, now)).toBe(false);
  });

  it("refuses an unparseable override out loud and keeps the default", () => {
    // Number("12h") is NaN, NaN * 60_000 is NaN, and the old `!every` guard
    // treated NaN as falsy — so a plausible-looking value silently disabled the
    // re-ping path with no log line anywhere. Silence is the worst answer to a
    // cadence the operator was actively trying to set.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = 1_760_000_000_000;
    for (const bad of ["12h", "abc", "720m"]) {
      process.env[KEY] = bad;
      // Falls back to the 12h default: 13h old is overdue, 5m old is not.
      expect(dueForRepeat("CRITICAL", now - 13 * HOUR, now)).toBe(true);
      expect(dueForRepeat("CRITICAL", now - 5 * MIN, now)).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockClear();
    }
    warn.mockRestore();
  });

  it("is silent for unset and blank, because neither is a decision", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = 1_760_000_000_000;
    for (const quiet of [undefined, "", "   "]) {
      quiet === undefined ? delete process.env[KEY] : (process.env[KEY] = quiet);
      expect(dueForRepeat("CRITICAL", now - 13 * HOUR, now)).toBe(true);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // 0 must keep meaning OFF. Under the pre-fix code 0, negative and NaN all
  // disabled re-pings, so an operator may be relying on 0 as a mute. Folding it
  // into the "unusable → default" branch would silently un-mute them on deploy,
  // which swaps one silent surprise for another.
  it("honours 0 and negatives as an explicit off switch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = 1_760_000_000_000;
    for (const off of ["0", "-1", "-9999"]) {
      process.env[KEY] = off;
      // No age is ever overdue when the cadence is off, not even a year.
      expect(dueForRepeat("CRITICAL", now - 365 * 24 * HOUR, now)).toBe(false);
    }
    expect(warn).toHaveBeenCalled(); // muting is announced, not silent
    warn.mockRestore();
  });

  it("leaves AT_RISK alone when only CRITICAL is muted", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = 1_760_000_000_000;
    process.env[KEY] = "0";
    expect(dueForRepeat("CRITICAL", now - 365 * 24 * HOUR, now)).toBe(false);
    expect(dueForRepeat("AT_RISK", now - 8 * 24 * HOUR, now)).toBe(true);
  });
});
