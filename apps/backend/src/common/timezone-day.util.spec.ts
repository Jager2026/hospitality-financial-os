import { describe, expect, it } from "vitest";
import { getLocalDayWindow } from "./timezone-day.util";

const VILNIUS = "Europe/Vilnius"; // ADR-012's launch timezone

describe("getLocalDayWindow", () => {
  it("identifies today's local calendar date correctly late in the local evening — the real case this exists for: naive UTC 'today' would already say tomorrow", () => {
    // 2026-08-10 23:30 in Vilnius (UTC+3, summer/EEST) is 2026-08-10 20:30 UTC.
    const referenceUtc = new Date("2026-08-10T20:30:00Z");
    const window = getLocalDayWindow(VILNIUS, 0, referenceUtc);
    expect(window.date).toBe("2026-08-10");
  });

  it("start/end are exactly local midnight to local midnight, 24 hours apart, on a non-DST-transition day", () => {
    const referenceUtc = new Date("2026-08-10T12:00:00Z");
    const window = getLocalDayWindow(VILNIUS, 0, referenceUtc);
    // Local midnight 2026-08-10 00:00 EEST (UTC+3) = 2026-08-09T21:00:00Z.
    expect(window.start.toISOString()).toBe("2026-08-09T21:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-08-10T21:00:00.000Z");
    expect(window.end.getTime() - window.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("a moment just before local midnight falls in the earlier day's window, not the later one", () => {
    // 2026-08-09T20:59:59Z is 2026-08-09T23:59:59 local (EEST) — one second before local midnight.
    const justBeforeMidnight = new Date("2026-08-09T20:59:59Z");
    const window = getLocalDayWindow(VILNIUS, 0, justBeforeMidnight);
    expect(window.date).toBe("2026-08-09");
    expect(justBeforeMidnight.getTime()).toBeLessThan(window.end.getTime());
    expect(justBeforeMidnight.getTime()).toBeGreaterThanOrEqual(window.start.getTime());
  });

  it("daysAgo walks back real calendar days, correctly crossing a month boundary", () => {
    // 2026-09-02 local, 2 days ago is 2026-08-31 — not "2026-09-00" or any other malformed value.
    const referenceUtc = new Date("2026-09-02T10:00:00Z");
    const window = getLocalDayWindow(VILNIUS, 2, referenceUtc);
    expect(window.date).toBe("2026-08-31");
  });

  it("7 consecutive daysAgo values produce 7 distinct, contiguous, oldest-first days with no gap or overlap", () => {
    const referenceUtc = new Date("2026-08-10T12:00:00Z");
    const windows = Array.from({ length: 7 }, (_, i) => getLocalDayWindow(VILNIUS, 6 - i, referenceUtc));
    for (let i = 0; i < windows.length; i++) {
      expect(windows[i].start.getTime()).toBeLessThan(windows[i].end.getTime());
      if (i > 0) {
        expect(windows[i].start.getTime()).toBe(windows[i - 1].end.getTime());
      }
    }
    expect(windows[6].date).toBe("2026-08-10");
  });

  it("UTC timezone is a no-op identity case — start/end are exactly UTC midnight to UTC midnight", () => {
    const referenceUtc = new Date("2026-08-10T12:00:00Z");
    const window = getLocalDayWindow("UTC", 0, referenceUtc);
    expect(window.start.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-08-11T00:00:00.000Z");
  });

  it("handles a negative-offset timezone correctly (America/Los_Angeles, UTC-7 in summer) — not just Vilnius's positive offset", () => {
    // 2026-08-10T05:00:00Z is 2026-08-09T22:00:00 local in Los Angeles (PDT, UTC-7) — still Aug 9.
    const referenceUtc = new Date("2026-08-10T05:00:00Z");
    const window = getLocalDayWindow("America/Los_Angeles", 0, referenceUtc);
    expect(window.date).toBe("2026-08-09");
    expect(window.start.toISOString()).toBe("2026-08-09T07:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-08-10T07:00:00.000Z");
  });
});
