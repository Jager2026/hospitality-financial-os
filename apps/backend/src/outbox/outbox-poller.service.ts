import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PinoLogger } from "nestjs-pino";
import { PrismaService } from "../prisma/prisma.service";

const POLL_INTERVAL_MS = 2000; // SEQUENCE_PAYMENT_TIP.md: "Every 1-2 seconds"
const MAX_ATTEMPTS_BEFORE_ALERT = 5; // SYSTEM_ARCHITECTURE.md: repeated failure becomes an alert, not an infinite retry loop
const BATCH_SIZE = 50;

/**
 * ADR-003's Transactional Outbox — the polling half. The write half (inserting OutboxEvent rows
 * in the same transaction as a Ledger write) lives in LedgerService.
 *
 * Skeleton only, per IMPLEMENTATION_PLAN.md Sprint 1: no projection handlers exist yet — Wallet,
 * Restaurant balance, and Analytics projections don't exist before Sprint 7/8/9/10. This worker
 * runs, polls, and logs; it has nothing to dispatch to until those modules register a handler.
 * Dispatch is deliberately not stubbed with a fake handler — an empty handler registry that
 * silently "succeeds" would be worse than an honest no-op, since it would hide the moment a real
 * handler should have been wired in.
 */
@Injectable()
export class OutboxPollerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboxPollerService.name);
  }

  @Interval(POLL_INTERVAL_MS)
  async poll(): Promise<void> {
    const unpublished = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    for (const event of unpublished) {
      await this.dispatch(event.id, event.eventType, event.attempts);
    }
  }

  private async dispatch(eventId: string, eventType: string, attempts: number): Promise<void> {
    // No projection handlers registered yet (Sprint 7+). Once one exists: dispatch here, set
    // published_at on success, and only increment `attempts` on failure (this skeleton
    // increments unconditionally since there's nothing to succeed or fail at yet — revisit this
    // method's body, not its polling shape, when the first real handler is wired in).
    this.logger.debug({ eventId, eventType }, "OutboxEvent polled — no handler registered yet");

    if (attempts + 1 >= MAX_ATTEMPTS_BEFORE_ALERT) {
      this.logger.error(
        { eventId, eventType, attempts: attempts + 1 },
        "OutboxEvent has failed repeatedly — operational alert (SYSTEM_ARCHITECTURE.md: Outbox Lag)",
      );
    }

    await this.prisma.outboxEvent.update({
      where: { id: eventId },
      data: { attempts: { increment: 1 } },
    });
  }
}
