import { describe, expect, it } from "vitest";
import { splitPlatformFee } from "./platform-fee.util";

describe("splitPlatformFee", () => {
  it("the two parts always sum to exactly grossAmount — the real discriminating case, not just a case where they happen to agree", () => {
    // grossAmount=3, basisPoints=100 (1%): a naive implementation computing restaurantRevenue
    // independently as grossAmount * (10_000 - basisPoints) / 10_000 would get
    // 3 * 9900 / 10000 = 29700 / 10000 = 2n (BigInt division truncates) — while feeAmount computed
    // the same way is 3 * 100 / 10000 = 0n. 0n + 2n = 2n, ONE MINOR UNIT SHORT of grossAmount (3n).
    // This implementation derives restaurantRevenue by subtraction, so it cannot drift.
    const { feeAmount, restaurantRevenue } = splitPlatformFee(3n, 100);
    expect(feeAmount).toBe(0n);
    expect(restaurantRevenue).toBe(3n);
    expect(feeAmount + restaurantRevenue).toBe(3n);
  });

  it("computes the expected 1% split for a realistic amount (Founder decision: 100 basis points)", () => {
    const { feeAmount, restaurantRevenue } = splitPlatformFee(4200n, 100);
    expect(feeAmount).toBe(42n);
    expect(restaurantRevenue).toBe(4158n);
    expect(feeAmount + restaurantRevenue).toBe(4200n);
  });

  it("never uses float rounding — BigInt division truncates toward zero, not Math.round", () => {
    // 155 * 100 / 10000 = 1.55 — a naive Number/Math.round path would produce 2n; integer BigInt
    // division truncates to 1n.
    const { feeAmount } = splitPlatformFee(155n, 100);
    expect(feeAmount).toBe(1n);
  });

  it("zero basis points takes no fee at all", () => {
    const { feeAmount, restaurantRevenue } = splitPlatformFee(9999n, 0);
    expect(feeAmount).toBe(0n);
    expect(restaurantRevenue).toBe(9999n);
  });

  it("10,000 basis points (100%) takes the entire amount as fee", () => {
    const { feeAmount, restaurantRevenue } = splitPlatformFee(500n, 10_000);
    expect(feeAmount).toBe(500n);
    expect(restaurantRevenue).toBe(0n);
  });

  it("sums to grossAmount exactly across a wide sweep of amounts — no drift for any of them", () => {
    for (let amount = 1n; amount <= 200n; amount++) {
      const { feeAmount, restaurantRevenue } = splitPlatformFee(amount, 100);
      expect(feeAmount + restaurantRevenue).toBe(amount);
    }
  });
});
