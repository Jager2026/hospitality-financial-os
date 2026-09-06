/**
 * What a venue can actually do with money right now, read from Stripe's own two capabilities.
 *
 * **Why this is a function and not an inline condition.** The Dashboard's banner used to test one
 * field — `payoutsStatus !== "active"` — and `payoutsStatus` is `null` for a restaurant whose
 * Stripe onboarding was never started. `null` is not `"active"`, but the old rule also required
 * the field to be non-null, so the venue that is **worst** prepared was the one the screen said
 * nothing about: it cannot take a card at all, and the Dashboard was silent while the Restaurants
 * list said so plainly. Found in #177 by fixing a fixture that had been describing a state the
 * system cannot produce, which is what made the real gap visible.
 *
 * **The order of the two questions is the meaning.** Cards first: a venue that cannot charge has
 * nothing to be paid out, so telling it about payouts would be answering the second question while
 * the first is still open.
 *
 * **`onboardingStatus` is deliberately not consulted.** It is our own coarse label, derived from
 * these same two capabilities (`deriveOnboardingStatus`), so reading it would be reading a
 * summary of the fields we already have — and a summary that can only be staler, never fresher.
 * The capabilities are what Stripe actually said.
 */
export type StripeBannerState =
  /** Stripe has not finished verifying the venue: no card can be taken here yet. */
  | "CANNOT_TAKE_CARDS"
  /** Cards work; the money is held at Stripe rather than reaching the bank. */
  | "PAYOUTS_HELD"
  /** Both capabilities live — nothing to say. */
  | "LIVE"
  /** The Restaurant call itself did not answer. Not knowing is not the same as being broken. */
  | "UNKNOWN";

export interface StripeCapabilities {
  cardPaymentsStatus: string | null;
  payoutsStatus: string | null;
}

/**
 * `undefined` is a real input, and conflating it with "not active" would be a defect of its own.
 *
 * ADR-063 keeps Stripe status out of the Dashboard response, so the banner's data arrives in a
 * SECOND request that can fail on its own — a slow network, an expired token, a 500. If that call
 * returns nothing, the screen knows nothing about Stripe, and a banner announcing that cards do
 * not work would be a fabrication caused by our own failed request. Silence is the honest output
 * there, and `UNKNOWN` keeps it distinguishable from `LIVE` for anyone reading a test.
 */
export function stripeBannerState(
  restaurant: StripeCapabilities | null | undefined,
): StripeBannerState {
  if (restaurant === null || restaurant === undefined) return "UNKNOWN";
  if (restaurant.cardPaymentsStatus !== "active") return "CANNOT_TAKE_CARDS";
  if (restaurant.payoutsStatus !== "active") return "PAYOUTS_HELD";
  return "LIVE";
}
