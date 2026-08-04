import { Injectable } from "@nestjs/common";
import type { JournalEntry } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertBalanced, assertCompensatingEntityMatchesType } from "./ledger-balance.util";
import type { PostJournalEntryInput } from "./ledger.types";

/**
 * The only module permitted to write a double-entry posting (SYSTEM_ARCHITECTURE.md, Business
 * Layer). No other module writes JournalEntry/LedgerLine rows directly, ever.
 *
 * No real writer calls this yet — Sprint 5 (Payments & Ledger) is the first. Built now, per
 * IMPLEMENTATION_PLAN.md Sprint 1, "so Sprint 5 doesn't have to invent it under pressure."
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async postJournalEntry(input: PostJournalEntryInput): Promise<JournalEntry> {
    // Layer 1 (Sprint 0 audit §2): fail fast, before any database write.
    assertBalanced(input.lines);
    assertCompensatingEntityMatchesType(input);

    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          entryType: input.entryType,
          transactionId: input.transactionId,
          refundId: input.refundId,
          chargebackId: input.chargebackId,
          adjustmentId: input.adjustmentId,
          description: input.description,
          ledgerLines: {
            create: input.lines.map((line) => ({
              account: line.account,
              direction: line.direction,
              amount: line.amount,
              currency: line.currency,
              restaurantId: line.restaurantId,
              membershipId: line.membershipId,
            })),
          },
        },
      });

      // ADR-003: the OutboxEvent is written in the SAME transaction as the Ledger write, so a
      // crash between the two is impossible — either both commit or neither does.
      await tx.outboxEvent.create({
        data: {
          aggregateType: "JournalEntry",
          aggregateId: entry.id,
          eventType: `journal_entry.${input.entryType.toLowerCase()}`,
          payload: { journalEntryId: entry.id, entryType: input.entryType },
        },
      });

      // Forces the deferred ledger_line_balanced trigger (apps/backend/prisma/sql/
      // ledger_integrity.sql) to run now, as a query inside this callback, rather than letting
      // Postgres run it naturally at COMMIT after the callback returns. Confirmed directly
      // (ledger-trigger.integration.spec.ts) that the difference is not cosmetic: when the
      // trigger fails at COMMIT instead, Prisma's $transaction() resolves normally even though
      // the server rolled everything back — the row is correctly never persisted, but the caller
      // never learns the write failed, which is worse than an error: code downstream would treat
      // a silently-discarded JournalEntry as successfully posted.
      await tx.$executeRawUnsafe("SET CONSTRAINTS ledger_line_balanced IMMEDIATE");

      return entry;
    });
  }
}
