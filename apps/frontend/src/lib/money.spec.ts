import { describe, expect, it } from "vitest";
import { formatBasisPoints, formatMoney, venueMoneyLocale } from "./money";

/**
 * Lithuanian money separates with a NON-BREAKING space, both between thousands and before the
 * symbol. Written as an escape rather than pasted, because a literal U+00A0 in a source file is
 * invisible in review and indistinguishable from the ordinary space somebody would type instead —
 * which is exactly how the first version of these expectations failed against correct output.
 */
const NBSP = "\u00a0";

describe("formatMoney — the locale owns the arrangement, the string owns the digits", () => {
  // THE REGRESSION THIS FILE EXISTS FOR. The screen showed €338.50 to a Lithuanian venue because
  // the formatter had `en-IE` baked into a default parameter. DESIGN_SYSTEM.md: "1 240,00 € in
  // lt-LT". The symbol moves, the separators swap, and no assertion in the old spec could see it,
  // because every one of them asserted the string the code already produced.
  it("writes Lithuanian money the Lithuanian way", () => {
    expect(formatMoney("33850", "EUR", "lt-LT")).toBe(`338,50${NBSP}€`);
    expect(formatMoney("124000", "EUR", "lt-LT")).toBe(`1${NBSP}240,00${NBSP}€`);
    expect(formatMoney("0", "EUR", "lt-LT")).toBe(`0,00${NBSP}€`);
  });

  it("and English money the English way, from the same input", () => {
    expect(formatMoney("33850", "EUR", "en-IE")).toBe("€338.50");
    expect(formatMoney("124000", "EUR", "en-IE")).toBe("€1,240.00");
  });

  // The discriminating one. An implementation that goes through Number() — parseFloat, +value,
  // Number(value) / 100 — loses precision above 2^53 minor units and returns a rounded figure.
  it("is exact past the range a double can represent, which is what forbids parsing it", () => {
    const beyondDouble = "9007199254740993"; // 2^53 + 1, in minor units
    expect(formatMoney(beyondDouble, "EUR", "en-IE")).toBe("€90,071,992,547,409.93");
    expect(Number(beyondDouble).toString()).toBe("9007199254740992"); // what a parser would see
  });

  it("marks a negative amount with a minus sign", () => {
    expect(formatMoney("-1250", "EUR", "en-IE")).toBe("−€12.50");
    expect(formatMoney("-1250", "EUR", "lt-LT")).toBe(`−12,50${NBSP}€`);
  });
});

describe("formatBasisPoints", () => {
  it("follows the locale's decimal separator", () => {
    expect(formatBasisPoints("1250", "en-IE")).toBe("12.5%");
    expect(formatBasisPoints("1250", "lt-LT")).toBe("12,5%");
    expect(formatBasisPoints("1000", "en-IE")).toBe("10%");
    expect(formatBasisPoints("0", "en-IE")).toBe("0%");
  });
});

describe("venueMoneyLocale", () => {
  it("builds the venue's own locale from its own two fields", () => {
    expect(venueMoneyLocale("lt", "LT")).toBe("lt-LT");
    expect(venueMoneyLocale("en", "IE")).toBe("en-IE");
  });

  it("degrades to something valid rather than throwing on a venue that lacks one", () => {
    expect(venueMoneyLocale(null, "LT")).toBe("en-LT");
    expect(venueMoneyLocale("lt", null)).toBe("lt");
    expect(venueMoneyLocale(null, null)).toBe("en");
  });
});
