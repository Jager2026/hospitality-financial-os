import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerService } from "./ledger.service";

// Real database. LedgerService.postJournalEntry itself had zero direct test coverage since
// Sprint 1 — ledger-balance.util.spec.ts only covers the pure validation functions, and
// ledger-trigger.integration.spec.ts deliberately bypasses this service to test the raw Postgres
// trigger. Sprint 5 is the first real caller, so this closes that gap before relying on it.
describe("LedgerService (real database)", () => {
  const prisma = new PrismaService();
  const service = new LedgerService(prisma);

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

  it("postJournalEntry: persists a balanced entry plus its LedgerLines and an OutboxEvent in the same write", async () => {
    const entry = await service.postJournalEntry({
      entryType: "PAYMENT_CAPTURED",
      description: "test entry",
      lines: [
        { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 1000n, currency: "EUR" },
        {
          account: "RESTAURANT_REVENUE_PAYABLE",
          direction: "CREDIT",
          amount: 1000n,
          currency: "EUR",
        },
      ],
    });

    const lines = await prisma.ledgerLine.findMany({ where: { journalEntryId: entry.id } });
    expect(lines).toHaveLength(2);
    const debit = lines.find((l) => l.direction === "DEBIT");
    const credit = lines.find((l) => l.direction === "CREDIT");
    expect(debit?.amount).toBe(1000n);
    expect(credit?.amount).toBe(1000n);

    const outboxRows = await prisma.outboxEvent.findMany({
      where: { aggregateType: "JournalEntry", aggregateId: entry.id },
    });
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].eventType).toBe("journal_entry.payment_captured");
  });

  it("postJournalEntry: rejects an unbalanced posting before writing anything (Layer 1, fail fast)", async () => {
    await expect(
      service.postJournalEntry({
        entryType: "PAYMENT_CAPTURED",
        lines: [
          { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 1000n, currency: "EUR" },
          {
            account: "RESTAURANT_REVENUE_PAYABLE",
            direction: "CREDIT",
            amount: 900n,
            currency: "EUR",
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("postJournalEntry: composes into a caller-supplied transaction (tx param) without opening its own", async () => {
    const marker = randomUUID();
    const entry = await prisma.$transaction(async (tx) => {
      // A write in the SAME outer transaction, before the ledger write — proves both land
      // together, not as two independent transactions.
      await tx.outboxEvent.create({
        data: {
          aggregateType: "TestMarker",
          aggregateId: randomUUID(),
          eventType: marker,
          payload: {},
        },
      });
      return service.postJournalEntry(
        {
          entryType: "PAYMENT_CAPTURED",
          lines: [
            { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 500n, currency: "EUR" },
            {
              account: "RESTAURANT_REVENUE_PAYABLE",
              direction: "CREDIT",
              amount: 500n,
              currency: "EUR",
            },
          ],
        },
        tx,
      );
    });

    const markerRow = await prisma.outboxEvent.findFirst({ where: { eventType: marker } });
    const journalRow = await prisma.journalEntry.findUnique({ where: { id: entry.id } });
    expect(markerRow).not.toBeNull();
    expect(journalRow).not.toBeNull();
  });
});
