import { Injectable } from "@nestjs/common";
import type { Prisma, Wallet } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

type TransactionClient = Prisma.TransactionClient;

/**
 * ADR-024: the ONLY writer of Wallet rows (DATABASE.md, Wallet Rules) — full recompute from
 * LedgerLine, never an incremental delta. `recomputeBalance` is the single code path both the
 * Outbox consumer (below) and a from-scratch rebuild use — "rebuild" isn't a separate mode, it's
 * this same method called after the row was deleted.
 *
 * Cost, stated explicitly rather than left implicit: this is O(n) in that Membership's own
 * LedgerLine history on every call, not an O(1) incremental update. Deliberate for MVP scale —
 * a Membership's tip history is small, and idempotent-by-construction (a replayed or duplicated
 * Outbox event just recomputes the same total) is worth more right now than the complexity of a
 * checkpointed incremental scheme. Revisit if a real Membership's history ever grows large enough
 * for this to show up in practice — not a forgotten optimization, a deferred one.
 */
@Injectable()
export class WalletProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Re-derives one Membership's Wallet balance from zero, from its own LedgerLine rows only,
   * and upserts the result. Returns `null` when that Membership has no LedgerLine activity yet —
   * no Wallet is created for someone who hasn't earned anything (`Membership.wallet` stays
   * optional until then, matching `schema.prisma`). */
  async recomputeBalance(membershipId: string, tx?: TransactionClient): Promise<Wallet | null> {
    const client = tx ?? this.prisma;
    const lines = await client.ledgerLine.findMany({ where: { membershipId } });
    if (lines.length === 0) return null;

    // Wallet is single-currency per row (schema.prisma) — a Membership earning in more than one
    // currency has no representation this schema can express. ADR-012 confines launch to EUR and
    // every Restaurant is itself single-currency, so this should be unreachable today; a loud
    // failure here is deliberate (CLAUDE_RULES.md, Error Philosophy) rather than silently summing
    // two currencies' minor units together as if they were fungible.
    const currencies = new Set(lines.map((l) => l.currency));
    if (currencies.size > 1) {
      throw new Error(
        `Membership ${membershipId} has LedgerLine rows in more than one currency ` +
          `(${[...currencies].join(", ")}) — Wallet cannot represent a multi-currency balance.`,
      );
    }
    const currency = lines[0].currency;

    const availableBalance = lines.reduce(
      (sum, line) => sum + (line.direction === "CREDIT" ? line.amount : -line.amount),
      0n,
    );

    // ADR-024: pendingBalance stays 0. Not because nothing is ever "pending" in the abstract —
    // because Withdrawal doesn't exist yet (Future placeholder only, IMPLEMENTATION_PLAN.md
    // Sprint 7). With no way to cash anything out at all, "available" and "pending" would be
    // labeling the identical, equally-uncashable balance two different ways — a display split
    // with no monetary meaning until Withdrawal ships to give the distinction something real to
    // distinguish. The field stays in the schema for that.
    return client.wallet.upsert({
      where: { membershipId },
      create: { membershipId, availableBalance, pendingBalance: 0n, currency, status: "ACTIVE" },
      update: { availableBalance, pendingBalance: 0n, currency },
    });
  }

  /** The Outbox consumer entry point (ADR-024) — the first real handler
   * `OutboxPollerService` has ever dispatched to. Deliberately ignores `eventType`: per
   * `EVENT_CATALOG.md`'s own stated convention, a consumer re-reads the source of truth by id
   * rather than trusting a payload that could grow stale, and DATABASE.md's own LedgerLine rule
   * is that ANY line carrying a `membershipId` affects that person's Wallet, regardless of which
   * account or JournalEntryType it belongs to — so every entry type (PAYMENT_CAPTURED,
   * TIP_ALLOCATED, REFUND_ISSUED, CHARGEBACK) is handled by the exact same code, not a per-type
   * switch that would need a new case every time ADR-023 or a future decision adds another
   * membership-scoped line somewhere. A no-op (nothing to project) is a normal, successful
   * outcome for a JournalEntry with no membership-scoped lines at all, e.g. a tip-less payment. */
  async handleJournalEntryEvent(journalEntryId: string, tx: TransactionClient): Promise<void> {
    const lines = await tx.ledgerLine.findMany({
      where: { journalEntryId, membershipId: { not: null } },
      select: { membershipId: true },
    });
    const membershipIds = [...new Set(lines.map((l) => l.membershipId as string))];

    for (const membershipId of membershipIds) {
      await this.recomputeBalance(membershipId, tx);
    }
  }
}
