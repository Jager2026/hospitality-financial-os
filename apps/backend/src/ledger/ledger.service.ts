import { Injectable } from "@nestjs/common";
import { ShiftService } from "../shift/shift.service";
import type { JournalEntry, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertBalanced, assertCompensatingEntityMatchesType } from "./ledger-balance.util";
import type { PostJournalEntryInput } from "./ledger.types";

type LedgerTransactionClient = Prisma.TransactionClient;

/**
 * The only module permitted to write a double-entry posting (SYSTEM_ARCHITECTURE.md, Business
 * Layer). No other module writes JournalEntry/LedgerLine rows directly, ever.
 *
 * Real writer since Sprint 5 (Payments & Ledger, shipped): WebhooksService calls this on
 * payment_intent.succeeded / charge.refunded / charge.dispute.created / charge.dispute.closed.
 * Built ahead of that, per IMPLEMENTATION_PLAN.md Sprint 1, "so Sprint 5 doesn't have to invent
 * it under pressure."
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shifts: ShiftService,
  ) {}

  /** `tx`, if given, composes this write into a transaction the CALLER already opened (Sprint 5:
   * a webhook handler needs Payment.update + Transaction.create + this Ledger write to be one
   * atomic unit — a crash between Transaction and JournalEntry would otherwise leave a Transaction
   * with no financial trail behind it, exactly what ADR-002/ADR-003 exist to prevent). Omitted,
   * this opens its own transaction exactly as before — every existing caller/test is unaffected. */
  async postJournalEntry(
    input: PostJournalEntryInput,
    tx?: LedgerTransactionClient,
  ): Promise<JournalEntry> {
    // Layer 1 (Sprint 0 audit §2): fail fast, before any database write.
    assertBalanced(input.lines);
    assertCompensatingEntityMatchesType(input);

    const run = async (client: LedgerTransactionClient): Promise<JournalEntry> => {
      // ADR-064: one lookup per distinct Restaurant in this entry, not one per line. In practice
      // every line of an entry shares a restaurant, so this is a single query — but the entry
      // shape permits more than one, and resolving per restaurant rather than per line keeps that
      // case correct instead of merely unlikely.
      const restaurantIds = [
        ...new Set(input.lines.map((l) => l.restaurantId).filter((id): id is string => !!id)),
      ];
      const shiftByRestaurant = new Map<string, string>();
      for (const restaurantId of restaurantIds) {
        const shift = await this.shifts.resolveOpenShift(restaurantId, client);
        shiftByRestaurant.set(restaurantId, shift.id);
      }

      const entry = await client.journalEntry.create({
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
              // ADR-064's second label. Resolved here, in the posting transaction, so an entry
              // can never be split across two shifts by one closing mid-write.
              shiftId: line.restaurantId ? shiftByRestaurant.get(line.restaurantId) : null,
            })),
          },
        },
      });

      // ADR-003: the OutboxEvent is written in the SAME transaction as the Ledger write, so a
      // crash between the two is impossible — either both commit or neither does.
      await client.outboxEvent.create({
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
      await client.$executeRawUnsafe("SET CONSTRAINTS ledger_line_balanced IMMEDIATE");

      return entry;
    };

    if (tx) {
      return run(tx);
    }
    return this.prisma.$transaction(run);
  }
}
