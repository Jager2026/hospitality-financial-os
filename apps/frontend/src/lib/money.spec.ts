import { describe, expect, it } from "vitest";
import { formatBasisPoints, formatMoney } from "./money";

describe("formatMoney — minor units, never parsed into a number", () => {
  it("renders ordinary amounts", () => {
    expect(formatMoney("1250", "EUR")).toBe("€12.50");
    expect(formatMoney("0", "EUR")).toBe("€0.00");
    expect(formatMoney("5", "EUR")).toBe("€0.05");
    expect(formatMoney("100", "EUR")).toBe("€1.00");
  });

  it("groups thousands", () => {
    expect(formatMoney("123456789", "EUR")).toBe("€1,234,567.89");
  });

  // The discriminating one. An implementation that goes through Number() — parseFloat, +value,
  // Number(value) / 100 — loses precision above 2^53 minor units and returns a rounded figure.
  // This amount is chosen to be beyond that, so the naive version cannot pass by coincidence.
  it("is exact past the range a double can represent, which is what forbids parsing it", () => {
    const beyondDouble = "9007199254740993"; // 2^53 + 1, in minor units
    expect(formatMoney(beyondDouble, "EUR")).toBe("€90,071,992,547,409.93");
    expect(Number(beyondDouble).toString()).toBe("9007199254740992"); // the value a parser would see
  });

  it("marks a negative amount with a minus sign rather than a bracket", () => {
    expect(formatMoney("-1250", "EUR")).toBe("−€12.50");
  });
});

describe("formatBasisPoints", () => {
  it("renders a tip rate the way a person says it", () => {
    expect(formatBasisPoints("1250")).toBe("12.5%");
    expect(formatBasisPoints("1000")).toBe("10%");
    expect(formatBasisPoints("0")).toBe("0%");
    expect(formatBasisPoints("5")).toBe("0.05%");
  });
});
