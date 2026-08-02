import { describe, expect, it } from "vitest";
import {
  assertBalanced,
  assertCompensatingEntityMatchesType,
  LedgerCompensatingEntityMismatchError,
  LedgerEmptyPostingError,
  LedgerUnbalancedError,
} from "./ledger-balance.util";
import type { LedgerLineInput, PostJournalEntryInput } from "./ledger.types";

// Sprint 1 DoD (IMPLEMENTATION_PLAN.md): "A test posting to LedgerLine that doesn't balance is
// rejected." This is that test — synchronous, no database required, since assertBalanced runs
// before the Ledger Module ever opens a transaction (Sprint 0 audit §2, Layer 1).
describe("assertBalanced", () => {
  it("accepts a balanced posting", () => {
    const lines: LedgerLineInput[] = [
      { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 11500n, currency: "EUR" },
      {
        account: "RESTAURANT_REVENUE_PAYABLE",
        direction: "CREDIT",
        amount: 10000n,
        currency: "EUR",
      },
      { account: "TIP_PAYABLE", direction: "CREDIT", amount: 1500n, currency: "EUR" },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("rejects an unbalanced posting", () => {
    const lines: LedgerLineInput[] = [
      { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 11500n, currency: "EUR" },
      {
        account: "RESTAURANT_REVENUE_PAYABLE",
        direction: "CREDIT",
        amount: 10000n,
        currency: "EUR",
      },
      // Missing the 1500 tip credit line — debits (11500) != credits (10000).
    ];
    expect(() => assertBalanced(lines)).toThrow(LedgerUnbalancedError);
  });

  it("rejects a posting where one currency is unbalanced, even if another in the same batch is fine", () => {
    const lines: LedgerLineInput[] = [
      { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 10000n, currency: "EUR" },
      {
        account: "RESTAURANT_REVENUE_PAYABLE",
        direction: "CREDIT",
        amount: 10000n,
        currency: "EUR",
      },
      { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 5000n, currency: "USD" },
      {
        account: "RESTAURANT_REVENUE_PAYABLE",
        direction: "CREDIT",
        amount: 4999n,
        currency: "USD",
      },
    ];
    expect(() => assertBalanced(lines)).toThrow(LedgerUnbalancedError);
  });

  // The test above doesn't actually prove per-currency grouping works — a naive implementation
  // that just sums every line together regardless of currency (debit 15000 vs credit 14999)
  // would fail this exact test too, for the wrong reason. This one is the real proof: EUR alone
  // is unbalanced (debit 10000 / credit 5000) and USD alone is unbalanced the opposite way
  // (debit 5000 / credit 10000), but a naive flat sum across both currencies is 15000 = 15000 —
  // falsely "balanced." Only a correct per-currency grouping catches this.
  it("rejects when currencies are individually unbalanced but a flat sum across them would look balanced", () => {
    const lines: LedgerLineInput[] = [
      { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 10000n, currency: "EUR" },
      {
        account: "RESTAURANT_REVENUE_PAYABLE",
        direction: "CREDIT",
        amount: 5000n,
        currency: "EUR",
      },
      { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 5000n, currency: "USD" },
      {
        account: "RESTAURANT_REVENUE_PAYABLE",
        direction: "CREDIT",
        amount: 10000n,
        currency: "USD",
      },
    ];
    expect(() => assertBalanced(lines)).toThrow(LedgerUnbalancedError);
  });

  it("rejects an empty posting", () => {
    expect(() => assertBalanced([])).toThrow(LedgerEmptyPostingError);
  });
});

describe("assertCompensatingEntityMatchesType", () => {
  it("accepts payment_captured with no compensating id set", () => {
    const input: PostJournalEntryInput = { entryType: "PAYMENT_CAPTURED", lines: [] };
    expect(() => assertCompensatingEntityMatchesType(input)).not.toThrow();
  });

  it("accepts refund_issued with only refundId set", () => {
    const input: PostJournalEntryInput = {
      entryType: "REFUND_ISSUED",
      refundId: "11111111-1111-1111-1111-111111111111",
      lines: [],
    };
    expect(() => assertCompensatingEntityMatchesType(input)).not.toThrow();
  });

  it("rejects refund_issued with no refundId set", () => {
    const input: PostJournalEntryInput = { entryType: "REFUND_ISSUED", lines: [] };
    expect(() => assertCompensatingEntityMatchesType(input)).toThrow(
      LedgerCompensatingEntityMismatchError,
    );
  });

  it("rejects payment_captured with a chargebackId set", () => {
    const input: PostJournalEntryInput = {
      entryType: "PAYMENT_CAPTURED",
      chargebackId: "11111111-1111-1111-1111-111111111111",
      lines: [],
    };
    expect(() => assertCompensatingEntityMatchesType(input)).toThrow(
      LedgerCompensatingEntityMismatchError,
    );
  });

  it("rejects two compensating ids set at once", () => {
    const input: PostJournalEntryInput = {
      entryType: "REFUND_ISSUED",
      refundId: "11111111-1111-1111-1111-111111111111",
      chargebackId: "22222222-2222-2222-2222-222222222222",
      lines: [],
    };
    expect(() => assertCompensatingEntityMatchesType(input)).toThrow(
      LedgerCompensatingEntityMismatchError,
    );
  });
});
