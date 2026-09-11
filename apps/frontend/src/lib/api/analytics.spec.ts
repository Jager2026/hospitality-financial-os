import { describe, expect, it } from "vitest";
import { exportCutsFor } from "./analytics";

/**
 * The export buttons the Analytics screen offers.
 *
 * Two rules live in one function because getting either one wrong produces the same visible
 * symptom — a button that answers with an error — and each case below names the implementation it
 * rejects.
 */
describe("exportCutsFor", () => {
  it("offers nothing at all without the permission", () => {
    // Rejects the obvious wrong version: hiding the section but still mapping over the cuts, or
    // checking the permission per area and forgetting one. Every area, one answer.
    for (const area of ["revenue", "tips", "staff", "performance", "reports"]) {
      expect(
        exportCutsFor(area, false),
        `${area} offered an export without the permission`,
      ).toEqual([]);
    }
  });

  it("offers both cuts only for the areas that have both routes", () => {
    // THE DISCRIMINATING PAIR. An implementation returning a fixed ["calendar", "by-shift"] for
    // everything passes the test above and fails here — and in the product it would offer a button
    // that 404s, on the two areas whose by-shift route was never built (ADR-067).
    expect(exportCutsFor("revenue", true)).toEqual(["calendar", "by-shift"]);
    expect(exportCutsFor("tips", true)).toEqual(["calendar", "by-shift"]);
    expect(exportCutsFor("reports", true)).toEqual(["calendar", "by-shift"]);

    expect(exportCutsFor("staff", true), "staff has no by-shift export route").toEqual([
      "calendar",
    ]);
    expect(exportCutsFor("performance", true), "performance has no by-shift export route").toEqual([
      "calendar",
    ]);
  });

  it("offers nothing for an area it has never heard of", () => {
    // A new area added to the screen without a line in the table gets no buttons, rather than a
    // pair of buttons pointing at routes that may not exist. The safe direction is silence.
    expect(exportCutsFor("something-new", true)).toEqual([]);
  });
});
