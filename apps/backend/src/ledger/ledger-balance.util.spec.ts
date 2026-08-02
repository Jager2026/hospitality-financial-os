import { describe, expect, it } from "vitest";
import {
  assertBalanced,
  assertCompensatingEntityMatchesType,
  LedgerCompensatingEntityMismatchError,
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
      { account: "RESTAURANT_REVENUE_PAYABLE", direction: "CREDIT", amount: 10000n, currency: "EUR" },
      { account: "TIP_PAYABLE", direction: "CREDIT", amount: 1500n, currency: "EUR" },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it("rejects an unbalanced posting", () => {
    const lines: LedgerLineInput[] = [
      { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 11500n, currency: "EUR" },
      { account: "RESTAURANT_REVENUE_PAYABLE", direction: "CREDIT", amount: 10000n, currency: "EUR" },
      // Missing the 1500 tip credit line — debits (11500) != credits (10000).
    ];
    expect(() => assertBalanced(lines)).toThrow(LedgerUnbalancedError);
  });

  it("balances each currency independently", () => {
    const lines: LedgerLineInput[] = [
      { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 10000n, currency: "EUR" },
      { account: "RESTAURANT_REVENUE_PAYABLE", direction: "CREDIT", amount: 10000n, currency: "EUR" },
      { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 5000n, currency: "USD" },
      { account: "RESTAURANT_REVENUE_PAYABLE", direction: "CREDIT", amount: 4999n, currency: "USD" },
    ];
    expect(() => assertBalanced(lines)).toThrow(LedgerUnbalancedError);
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
