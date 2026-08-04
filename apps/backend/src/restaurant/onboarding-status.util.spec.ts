import { describe, expect, it } from "vitest";
import { deriveOnboardingStatus } from "./onboarding-status.util";

describe("deriveOnboardingStatus", () => {
  it("is NOT_STARTED when neither capability has ever been requested", () => {
    expect(deriveOnboardingStatus(null, null, 0)).toBe("NOT_STARTED");
  });

  it("is COMPLETE when both card payments and payouts are active", () => {
    expect(deriveOnboardingStatus("active", "active", 0)).toBe("COMPLETE");
  });

  it("is IN_PROGRESS when requirements are still outstanding, even if one capability is already active", () => {
    // Confirmed shape from a real Stripe response: card_payments can be "restricted" while
    // requirements are still pending — this must not be confused with a genuinely blocked
    // account (RESTRICTED), which has no outstanding requirements left to explain the block.
    expect(deriveOnboardingStatus("restricted", null, 3)).toBe("IN_PROGRESS");
  });

  it("is IN_PROGRESS, not COMPLETE, when card payments is active but payouts still needs requirements", () => {
    expect(deriveOnboardingStatus("active", "restricted", 1)).toBe("IN_PROGRESS");
  });

  it("is RESTRICTED when a capability is blocked with zero outstanding requirements", () => {
    // The discriminating case: same "restricted" status as the IN_PROGRESS case above, but no
    // requirements left — a naive implementation that only looks at status, not requirement
    // count, would call this IN_PROGRESS too and hide a real compliance block from the Owner.
    expect(deriveOnboardingStatus("restricted", "restricted", 0)).toBe("RESTRICTED");
  });

  it("is not COMPLETE when only one of the two capabilities is active", () => {
    expect(deriveOnboardingStatus("active", "pending", 0)).not.toBe("COMPLETE");
    expect(deriveOnboardingStatus("pending", "active", 0)).not.toBe("COMPLETE");
  });
});
