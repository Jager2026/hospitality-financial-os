/** One credit line a TipAllocationStrategy produces — always summing back to the tip's gross
 * amount across every line it returns (enforced by the caller, WebhooksService, via the same
 * assertBalanced() every other JournalEntry goes through). */
export interface TipAllocationLine {
  membershipId: string;
  amount: bigint;
}

/** ADR-007 / ADR-022, and IMPLEMENTATION_PLAN.md's own Sprint 6 task list: "TipAllocationStrategy
 * interface in code (Pool / Shift / Percentage / Role-based designed, not implemented)." Real
 * interface, not decorative — WebhooksService builds the TIP_ALLOCATED entry's credit lines from
 * whatever a strategy returns, so a future Pool/Shift/Percentage/Role-based implementation
 * returning more than one line needs no change to the Ledger-posting code that calls it, only a
 * different strategy selected (Sprint 6's own Definition of Done: "Adding a second allocation
 * strategy later requires no schema change"). */
export interface TipAllocationStrategy {
  allocate(tipAmount: bigint, payingMembershipId: string): TipAllocationLine[];
}

/** DI token — interfaces don't exist at runtime, so callers inject this, bound to
 * IndividualTipAllocationStrategy in TipModule (the only strategy selection point). */
export const TIP_ALLOCATION_STRATEGY = Symbol("TIP_ALLOCATION_STRATEGY");
