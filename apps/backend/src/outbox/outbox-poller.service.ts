import { Injectable } from "@nestjs/common";
import type { OutboxEvent } from "@prisma/client";
import { Interval } from "@nestjs/schedule";
import { PinoLogger } from "nestjs-pino";
import { AlertService } from "../common/alerting/alert.service";
import {
  ABANDON_UNDELIVERED_AFTER_MS,
  EMAIL_OUTBOX_EVENT_TYPE,
  EmailOutboxService,
} from "../email/email-outbox.service";
import { PrismaService } from "../prisma/prisma.service";
import { WalletProjectionService } from "../wallet/wallet-projection.service";

const POLL_INTERVAL_MS = 2000; // SEQUENCE_PAYMENT_TIP.md: "Every 1-2 seconds"
const BATCH_SIZE = 50;

/**
 * The attempt count at which one alert is sent. **It bounds the ALERTING and nothing else.**
 *
 * It used to carry the comment "repeated failure becomes an alert, not an infinite retry loop",
 * which was false in its second half and stayed false for three sprints: nothing here has ever
 * stopped retrying because of an attempt count, and one e2e database was found holding an event at
 * **5,293 attempts** (#196). The sentence described an intention, the way `playwright.config.ts`
 * described one about truncation (ADR-082), and the two failures are the same shape — a comment
 * that reads as a mechanism.
 *
 * Where finality actually lives, since it is not here:
 *   - **Email** is abandoned after `ABANDON_UNDELIVERED_AFTER_MS` (ADR-075) — a window, not a
 *     count, tied to the lifetime of Resend's `Idempotency-Key`.
 *   - **Money** is retried forever, deliberately: abandoning a journal-entry projection leaves a
 *     Wallet permanently wrong, and nothing has established that giving up on money is ever right.
 */
const MAX_ATTEMPTS_BEFORE_ALERT = 5;

/**
 * The longest a failing event waits between attempts. Reached after eight failures.
 *
 * At five minutes a stuck event costs 288 attempts a day instead of the 43,200 a two-second retry
 * costs, while still recovering within five minutes of whatever broke being fixed — the number is
 * chosen against recovery latency, which is the thing a person actually waits for.
 */
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * How long an event waits after failing `attempts` times: 2s, 4s, 8s … capped at five minutes.
 *
 * **Why doubling, and why this is not a taste question.** Without it, the interval between attempts
 * is the poll interval, so a provider outage is answered by hammering the same failing call every
 * two seconds for as long as it lasts — a storm against the database and against whatever is
 * already unwell, at the moment it is least able to absorb one. Retrying is supposed to ride out a
 * blip, and a retry policy with no backoff converts a blip into load.
 *
 * **What it changes about ADR-075, which matters more than the numbers.** That decision chose a
 * time window over an attempt count, reasoning that "twenty attempts is forty seconds, which would
 * abandon real messages during an ordinary provider blip". That was true *because* attempts and
 * seconds were the same quantity at a fixed two-second interval. With a backoff they are no longer
 * the same quantity — and the window is STILL the right instrument, for the reason that survives:
 * it is pinned to the lifetime of Resend's `Idempotency-Key`, which is a duration in the world
 * rather than a property of how often we happen to ask. An attempt count could now be made safe;
 * it still would not be measuring the thing that expires.
 *
 * No jitter. It exists to stop many clients synchronising onto one target, and this poller is a
 * single instance draining one batch in sequence — adding it here would buy nothing and cost a
 * test that cannot assert an exact interval. Worth revisiting the day the claim step in `poll()`
 * is fixed and a second instance becomes possible.
 */
export function retryDelayMs(attempts: number): number {
  const doublings = Math.min(Math.max(attempts - 1, 0), 8);
  return Math.min(POLL_INTERVAL_MS * 2 ** doublings, MAX_RETRY_DELAY_MS);
}

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
    // ADR-075 option A: an email event past the retry window is abandoned — its body has been
    // redacted, so there is nothing left to send, and continuing to select it would burn a batch
    // slot forever on a row that can never publish. That crowding is the documented mechanism
    // behind the outbox specs starving (IMPLEMENTATION_PLAN.md).
    //
    // Scoped to EMAIL events on purpose, and the asymmetry is deliberate rather than an oversight.
    // A journal-entry event is a money projection: abandoning one silently would leave a Wallet
    // permanently wrong, and nothing about this change has established that giving up on money is
    // ever right. Those keep exactly today behaviour — retried forever, alerted at five.
    const abandonedBefore = new Date(Date.now() - ABANDON_UNDELIVERED_AFTER_MS);
    const unpublished = await this.prisma.outboxEvent.findMany({
      where: {
        publishedAt: null,
        // ADR-083. A row that failed recently is not due yet. Events that have never failed carry
        // `next_attempt_at = created_at`, so a healthy queue is selected exactly as it was before
        // the column existed — the backoff is invisible until something goes wrong, which is the
        // only time it should be visible at all.
        OR: [{ attempts: 0 }, { nextAttemptAt: { lte: new Date() } }],
        NOT: {
          eventType: EMAIL_OUTBOX_EVENT_TYPE,
          createdAt: { lt: abandonedBefore },
        },
      },
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
      // ADR-083. The increment and the delay are written together: an attempt that counted but did
      // not push the next one out would be counted twice within the same second, and the attempt
      // number is what the alert threshold reads.
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
        },
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
