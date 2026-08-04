export type OnboardingStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" | "RESTRICTED";

/**
 * Our own coarse status (DATABASE.md's OnboardingStatus enum, unchanged by ADR-009's v1→v2
 * revision) derived from Stripe's real v2 capability statuses + requirements — never stored as
 * something Stripe itself returns. `card_payments`/`stripe_balance.payouts` status can each be
 * "active" / "pending" / "restricted" / "disabled", or null if the capability was never
 * requested (shouldn't happen here — we always request card_payments at creation, ADR-009).
 */
export function deriveOnboardingStatus(
  cardPaymentsStatus: string | null,
  payoutsStatus: string | null,
  requirementsCount: number,
): OnboardingStatus {
  if (cardPaymentsStatus === null && payoutsStatus === null) {
    return "NOT_STARTED";
  }
  if (cardPaymentsStatus === "active" && payoutsStatus === "active") {
    return "COMPLETE";
  }
  if (requirementsCount > 0) {
    return "IN_PROGRESS";
  }
  // restricted/disabled/pending with nothing currently due — blocked for a reason other than
  // "the owner hasn't filled in the form yet" (e.g. a compliance review in progress).
  return "RESTRICTED";
}
