import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";

// DoD (IMPLEMENTATION_PLAN.md, Sprint 1): "A test posting to LedgerLine that doesn't balance is
// rejected — both by the Ledger Module write-helper [...] and, if that's bypassed directly via
// SQL, by the deferred trigger." ledger-balance.util.spec.ts covers the write-helper
// (assertBalanced) in isolation — this file is the other half. It writes JournalEntry/LedgerLine
// rows directly through Prisma Client, never through LedgerService.postJournalEntry, so
// assertBalanced never runs and never gets a chance to reject anything first: the only thing
// standing between an unbalanced posting and the database is the real Postgres trigger
// (ledger_line_balanced / check_journal_entry_balanced(), apps/backend/prisma/sql/
// ledger_integrity.sql). Needs a real, migrated database — CI applies migrations before this
// runs (.github/workflows/ci.yml, "Apply database migrations").
//
// Real finding from writing this test, not a style choice: without the explicit
// `SET CONSTRAINTS ledger_line_balanced IMMEDIATE` below, Prisma's $transaction() resolves
// *successfully* even when the deferred trigger fails and Postgres rolls the whole commit back —
// the data is correctly never persisted either way, but the caller never sees an error. Confirmed
// directly by running both variants against a real database before writing this comment. Fixed
// the same way in the real write path, LedgerService.postJournalEntry — this isn't just a test
// concern, it's a live gap in the "defense-in-depth" design that nothing had caught before.
describe("ledger_line_balanced trigger (real database, bypassing LedgerService)", () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.currency.upsert({
      where: { code: "EUR" },
      update: {},
      create: { code: "EUR", exponent: 2, name: "Euro" },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects an unbalanced posting written directly, even though assertBalanced never ran", async () => {
    const entryId = randomUUID();

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.journalEntry.create({
          data: {
            id: entryId,
            entryType: "PAYMENT_CAPTURED",
            description: "trigger test — unbalanced",
          },
        });
        await tx.ledgerLine.createMany({
          data: [
            {
              journalEntryId: entryId,
              account: "PROCESSOR_CLEARING",
              direction: "DEBIT",
              amount: 1000n,
              currency: "EUR",
            },
            {
              journalEntryId: entryId,
              account: "RESTAURANT_REVENUE_PAYABLE",
              direction: "CREDIT",
              amount: 900n,
              currency: "EUR",
            },
          ],
        });
        // See the module comment above — without this, the trigger still protects the data
        // (nothing gets persisted either way) but Prisma won't surface the failure as a
        // rejection, and this test would falsely pass with "promise resolved" if it did.
        await tx.$executeRawUnsafe("SET CONSTRAINTS ledger_line_balanced IMMEDIATE");
      }),
    ).rejects.toThrow(/unbalanced/i);

    // The whole transaction must have rolled back — a rejected commit leaves nothing behind,
    // not a half-written entry with only its debit line.
    const persisted = await prisma.journalEntry.findUnique({ where: { id: entryId } });
    expect(persisted).toBeNull();
  });

  it("accepts a genuinely balanced posting (sanity check — the trigger isn't just rejecting everything)", async () => {
    const entryId = randomUUID();

    await prisma.$transaction(async (tx) => {
      await tx.journalEntry.create({
        data: {
          id: entryId,
          entryType: "PAYMENT_CAPTURED",
          description: "trigger test — balanced",
        },
      });
      await tx.ledgerLine.createMany({
        data: [
          {
            journalEntryId: entryId,
            account: "PROCESSOR_CLEARING",
            direction: "DEBIT",
            amount: 1000n,
            currency: "EUR",
          },
          {
            journalEntryId: entryId,
            account: "RESTAURANT_REVENUE_PAYABLE",
            direction: "CREDIT",
            amount: 1000n,
            currency: "EUR",
          },
        ],
      });
      await tx.$executeRawUnsafe("SET CONSTRAINTS ledger_line_balanced IMMEDIATE");
    });

    const persisted = await prisma.journalEntry.findUnique({ where: { id: entryId } });
    expect(persisted).not.toBeNull();
  });
});
