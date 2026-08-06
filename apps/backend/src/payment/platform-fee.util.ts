export interface PlatformFeeSplit {
  feeAmount: bigint;
  restaurantRevenue: bigint;
}

/** ADR-014 addendum: the platform fee is a percentage of Restaurant Revenue only — tips are never
 * platform revenue (Sprint 6 introduces Tip; this split has nothing to reduce yet). basisPoints
 * is out of 10,000 (100 = 1.00%), matching Founder decision (DEFAULT_PLATFORM_FEE_BASIS_POINTS).
 *
 * Integer-only BigInt arithmetic, same discipline ADR-001 requires for the largest remainder
 * method: feeAmount is computed first via BigInt floor division (`/` on BigInt always truncates
 * toward zero — never a float, never `Math.round`), and restaurantRevenue is the SUBTRACTION
 * remainder, never computed independently via its own (10_000n - basisPoints) division. Two
 * independent divisions can each round down and leave the two parts summing to one minor unit
 * less than grossAmount; deriving the second part by subtraction makes that impossible — the two
 * numbers always sum to exactly grossAmount by construction, not by coincidence. */
export function splitPlatformFee(grossAmount: bigint, basisPoints: number): PlatformFeeSplit {
  const feeAmount = (grossAmount * BigInt(basisPoints)) / 10_000n;
  const restaurantRevenue = grossAmount - feeAmount;
  return { feeAmount, restaurantRevenue };
}
