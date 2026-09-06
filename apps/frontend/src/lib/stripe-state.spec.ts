import { describe, expect, it } from "vitest";
import { stripeBannerState } from "./stripe-state";

/**
 * The rule the Dashboard banner asks, tested where every combination is cheap to state.
 *
 * **The case this file exists for is the first one.** A venue whose Stripe onboarding was never
 * started holds `null` in both capabilities, and the old condition —
 * `payoutsStatus != null && payoutsStatus !== "active"` — answered "no banner" for it. The venue
 * least able to take money was the one the screen said nothing about. Any implementation that
 * reads `payoutsStatus` alone fails the first test below and passes the rest, which is what makes
 * it a discriminating test rather than a description.
 */
describe("stripeBannerState — the whole state, not one field", () => {
  it("says cards cannot be taken when Stripe was never started (both capabilities null)", () => {
    expect(
      stripeBannerState({ cardPaymentsStatus: null, payoutsStatus: null }),
      "a venue that cannot take a card at all was told nothing",
    ).toBe("CANNOT_TAKE_CARDS");
  });

  it("says payouts are held when cards work and payouts do not", () => {
    expect(stripeBannerState({ cardPaymentsStatus: "active", payoutsStatus: "restricted" })).toBe(
      "PAYOUTS_HELD",
    );
  });

  it("says nothing when both capabilities are live", () => {
    expect(stripeBannerState({ cardPaymentsStatus: "active", payoutsStatus: "active" })).toBe(
      "LIVE",
    );
  });

  // Cards first, and this is the case that proves the order rather than assuming it: a venue that
  // cannot charge has nothing to be paid out, so answering the payout question here would answer
  // the second question while the first is still open.
  it("asks about cards before payouts when neither works", () => {
    expect(stripeBannerState({ cardPaymentsStatus: "pending", payoutsStatus: "restricted" })).toBe(
      "CANNOT_TAKE_CARDS",
    );
  });

  // Every non-"active" value means the same thing to a reader — the capability is not usable —
  // and Stripe's vocabulary can grow without a migration on our side (schema.prisma's own note),
  // so the rule must not be a list of the values we happen to have seen.
  it.each(["pending", "restricted", "disabled", "unrequested", null])(
    "treats card capability %s as not usable",
    (status) => {
      expect(stripeBannerState({ cardPaymentsStatus: status, payoutsStatus: "active" })).toBe(
        "CANNOT_TAKE_CARDS",
      );
    },
  );

  // ADR-063 makes this a second request, which can fail on its own. A banner announcing that cards
  // do not work, because OUR call failed, would be a fabrication — and one the reader could not
  // tell from the real thing.
  it("stays silent rather than guessing when the restaurant call returned nothing", () => {
    expect(stripeBannerState(undefined)).toBe("UNKNOWN");
    expect(stripeBannerState(null)).toBe("UNKNOWN");
  });
});
