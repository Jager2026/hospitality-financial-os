import { authedGet } from "../auth/authed-fetch";
import type { ApiResult } from "./client";

/**
 * The shift endpoints (API_Contract.md, SHIFTS).
 *
 * Shapes declared here rather than imported from the backend — the Portal is a separate build with
 * its own `rootDir`, the same client/server boundary duplication `staff.ts` explains.
 */

/** ADR-094's three states, carried on every amount that depends on Stripe. */
export type AmountState = "available" | "pending" | "unavailable";

export interface StatedAmount {
  /** Minor units. **`null` when the amount is not known — never `"0"`.** */
  amount: string | null;
  state: AmountState;
}

export interface DeductionRow {
  kind: "stripe_processing" | "platform_fee";
  amount: string | null;
  state: AmountState;
}

export interface AvailabilityRow {
  availableOn: string;
  amount: string;
  transactions: number;
}

export interface ShiftCloseSummary {
  shiftId: string;
  restaurantId: string;
  businessDate: string;
  openedAt: string;
  closedAt: string | null;
  currency: string;
  transactions: number;
  grossRevenue: StatedAmount;
  tips: StatedAmount;
  deductions: DeductionRow[];
  netToVenue: StatedAmount;
  availability: {
    /** **A list, even when it holds one row** — a shift can straddle two availability dates. */
    rows: AvailabilityRow[];
    unresolved: number;
    state: AmountState;
  };
}

/** `null` when the venue has never closed a shift — a real answer, not an error. */
export async function fetchLatestClosedShiftSummary(
  restaurantId: string,
): Promise<ApiResult<ShiftCloseSummary | null>> {
  return await authedGet<ShiftCloseSummary | null>(
    `/restaurants/${restaurantId}/shifts/latest-closed/summary`,
  );
}
