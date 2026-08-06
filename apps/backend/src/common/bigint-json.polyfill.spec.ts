import { describe, expect, it } from "vitest";
import "./bigint-json.polyfill";

describe("bigint-json.polyfill", () => {
  it("serializes a bigint as a string, not throwing and not silently rounding through a float", () => {
    // A value beyond Number.MAX_SAFE_INTEGER — a naive `Number(value)` conversion would lose
    // precision; this proves the actual bigint digits survive round-trip through JSON.
    const amount = 900719925474099112n;
    expect(JSON.stringify({ amount })).toBe('{"amount":"900719925474099112"}');
  });

  it("round-trips inside a realistic Payment-shaped object without throwing", () => {
    const payload = { id: "abc", amount: 1550n, currency: "EUR" };
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      id: "abc",
      amount: "1550",
      currency: "EUR",
    });
  });
});
