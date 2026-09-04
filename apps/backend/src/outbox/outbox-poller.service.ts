import { Injectable } from "@nestjs/common";
import type { OutboxEvent } from "@prisma/client";
import { Interval } from "@nestjs/schedule";
import { PinoLogger } from "nestjs-pino";
import { AlertService } from "../common/alerting/alert.service";
import { EMAIL_OUTBOX_EVENT_TYPE, EmailOutboxService } from "../email/email-outbox.service";
import { PrismaService } from "../prisma/prisma.service";
import { WalletProjectionService } from "../wallet/wallet-projection.service";

const POLL_INTERVAL_MS = 2000; // SEQUENCE_PAYMENT_TIP.md: "Every 1-2 seconds"
const MAX_ATTEMPTS_BEFORE_ALERT = 5; // SYSTEM_ARCHITECTURE.md: repeated failure becomes an alert, not an infinite retry loop
const BATCH_SIZE = 50;

/**
 * ADR-003's Transactional Outbox — the polling half. The write half (inserting OutboxEvent rows
 * in the same transaction as a Ledger write) lives in LedgerService.
 *
 * ADR-024: Wallet is the first real handler this worker has ever dispatched to
 * (IMPLEMENTATION_PLAN.md Sprint 7) — before this, it ran, polled, and logged, with nothing to
 * dispatch to (EVENT_CATALOG.md documents that earlier skeleton state). Dispatch goes straight to
 * `WalletProjectionService`, not through a handler registry: it's the only real consumer that
 * exists yet (Restaurant/Analytics projections are Sprint 8/9+, per SYSTEM_ARCHITECTURE.md's own
 * roadmap) — a registry earns its cost once a second one lands, not in advance.
 */
@Injectable()
export class OutboxPollerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletProjection: WalletProjectionService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly logger: PinoLogger,
    private readonly alertService: AlertService,
  ) {
    this.logger.setContext(OutboxPollerService.name);
  }

  // READ THIS BEFORE ADDING A SECOND CONSUMER — there is no claim step.
  //
  // This selects `publishedAt: null` and marks the row published only later, inside dispatch()'s
  // transaction. Between those two moments the row is visible to every other poller: no
  // `SELECT … FOR UPDATE SKIP LOCKED`, no claimed_at column, no advisory lock. Two instances read
  // the same rows and both dispatch them.
  //
  // It has never caused a problem, for two reasons, and NEITHER of them is this mechanism:
  //   1. production runs a single backend instance, and
  //   2. the only consumer, WalletProjectionService, recomputes a balance IN FULL rather than
  //      applying a delta — so dispatching twice happens to produce the same number.
  //
  // Reason 2 is a property of that one handler, not a guarantee this poller offers. A consumer
  // that increments a counter, appends a row, or sends anything outward (an email, a payout, a
  // webhook) turns a double dispatch into a double effect on the money path. The handler-registry
  // comment above says a second consumer is what earns the abstraction; this comment says a second
  // consumer is also what makes the missing claim step real. Fix the claim first.
  //
  // Tracked in IMPLEMENTATION_PLAN.md (Deferred), found while writing ADR-045.
  @Interval(POLL_INTERVAL_MS)
  async poll(): Promise<void> {
    const unpublished = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    for (const event of unpublished) {
      await this.dispatch(event);
    }
  }

  // Handling and marking published_at are one atomic transaction — a crash between "Wallet
  // updated" and "published_at set" would otherwise leave this event re-dispatched on the next
  // poll, re-running an already-applied projection. recomputeBalance() is idempotent against
  // exactly that (full recompute, not a delta), but the transaction still means a failure here
  // never marks the event published without actually having projected it, and never leaves a
  // half-applied state visible to a reader in between.
  private async dispatch(event: OutboxEvent): Promise<void> {
    try {
      // ADR-069 — the SECOND consumer, and the first time this poller has had to ask what an event
      // is before handling it. The branch is deliberately the only change to this method: every
      // event that is not an email request takes the identical path it took before, byte for byte,
      // and a test asserts that a journal-entry event still reaches WalletProjectionService and
      // that a malformed payload still throws.
      //
      // NOT a handler registry yet. The comment above says a second consumer is what earns that
      // abstraction; a registry for two entries is a lookup table with ceremony. The third one is
      // when this becomes a registry — and by then the claim step should be fixed too, because
      // that is the same threshold.
      if (event.eventType === EMAIL_OUTBOX_EVENT_TYPE) {
        // Marking published happens inside the handler, not here: the send must not run inside a
        // database transaction, so the handler owns both its own transaction and its own ordering.
        await this.emailOutbox.handle(event);
        return;
      }

      // EVENT_CATALOG.md: the only payload shape any real writer produces. Validated explicitly,
      // not just cast — Prisma silently treats `where: { journalEntryId: undefined }` as "omit
      // this filter" rather than erroring, so a malformed payload (missing journalEntryId) would
      // otherwise make WalletProjectionService match and recompute EVERY Membership's balance in
      // the whole database instead of failing fast. Not hypothetical: `ledger.service.spec.ts`'s
      // own atomicity test deliberately writes an OutboxEvent with `payload: {}` (a "TestMarker"
      // row, unrelated to Wallet, proving the write lands in the same transaction as the Ledger
      // write) — a real, permanent row this poller has to coexist with, not edit or delete.
      const payload = event.payload as { journalEntryId?: unknown };
      if (typeof payload.journalEntryId !== "string" || payload.journalEntryId.length === 0) {
        throw new Error(`OutboxEvent ${event.id} has no valid journalEntryId in its payload`);
      }
      const journalEntryId = payload.journalEntryId;

      await this.prisma.$transaction(async (tx) => {
        await this.walletProjection.handleJournalEntryEvent(journalEntryId, tx);
        await tx.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
      });
    } catch (err) {
      const attempts = event.attempts + 1;
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 } },
      });

      if (attempts >= MAX_ATTEMPTS_BEFORE_ALERT) {
        this.logger.error(
          { eventId: event.id, eventType: event.eventType, attempts, err },
          "OutboxEvent has failed repeatedly — operational alert (SYSTEM_ARCHITECTURE.md: Outbox Lag)",
        );
        // Fires exactly once per event, on the poll that crosses the threshold — not on every
        // subsequent retry past it, which would page the same incident again every 2 seconds
        // (POLL_INTERVAL_MS) for as long as the event stays stuck. The log line above still fires
        // every time, unchanged, for anyone tailing logs directly.
        if (attempts === MAX_ATTEMPTS_BEFORE_ALERT) {
          // AlertService itself never throws (it catches its own delivery failures) — this
          // try/catch is defense in depth anyway, not redundancy: a throw here would otherwise
          // propagate out of dispatch() entirely, and poll()'s own for-loop has no per-event
          // try/catch, so one alert failure would abort the WHOLE batch, silently skipping every
          // other unpublished event this cycle — found by this class's own discriminating test,
          // not assumed safe from AlertService's current implementation.
          try {
            const message =
              `Outbox Lag: OutboxEvent ${event.id} (${event.eventType}) has failed ` +
              `${attempts} times without publishing. ${err instanceof Error ? err.message : String(err)}`;
            await this.alertService.sendAlert(message, { eventId: event.id });
          } catch (alertErr) {
            this.logger.warn(
              { eventId: event.id, alertErr },
              "AlertService.sendAlert() itself threw",
            );
          }
        }
      } else {
        this.logger.warn(
          { eventId: event.id, eventType: event.eventType, attempts, err },
          "OutboxEvent dispatch failed, will retry on next poll",
        );
      }
    }
  }
}
