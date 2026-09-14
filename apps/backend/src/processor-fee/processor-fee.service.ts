import { Injectable } from "@nestjs/common";
import type { OutboxEvent } from "@prisma/client";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PermanentRejection } from "../common/errors/permanent-rejection";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";

/** The Outbox event that asks for one payment's processing fee. Written by the capture handler in
 * the same transaction as the Transaction it belongs to (ADR-003), so it cannot go missing. */
export const PROCESSOR_FEE_EVENT_TYPE = "processor_fee.fetch_requested";

/**
 * **The attempt limit, named here because point 2 of this work required it to be named.**
 *
 * Four, and the number is chosen against two other numbers rather than picked. ADR-083's backoff
 * is 2s, 4s, 8s — so four attempts spend about fourteen seconds of waiting on a value measured to
 * appear within seconds. And `MAX_ATTEMPTS_BEFORE_ALERT` in the poller is **five**: stopping at
 * four means the alert a permanently-missing fee raises is this handler's own, which says what
 * happened, rather than the generic "OutboxEvent has failed repeatedly", which does not.
 */
export const MAX_FEE_FETCH_ATTEMPTS = 4;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ADR-094 — Stripe's processing fee enters the Ledger.
 *
 * **Why this is a scheduled consumer and not two lines in the webhook handler.** The fee is not in
 * the event: `payment_intent.succeeded` carries `latest_charge` as a bare id, and Stripe's own fee
 * lives on the BalanceTransaction below it (ADR-093, measured). Fetching it inside the capture
 * transaction would mean a network round trip inside a database transaction, and — measured —
 * would frequently come back **null**, because the BalanceTransaction is not populated at the
 * instant the charge succeeds. A handler that wrote nothing in that case would leave the fee
 * missing silently, which is the same defect this change exists to remove, entered from the other
 * side.
 *
 * So the fetch runs on the Outbox's own schedule, where "not yet" is a retry rather than a result.
 */
@Injectable()
export class ProcessorFeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly ledger: LedgerService,
    @InjectPinoLogger(ProcessorFeeService.name) private readonly logger: PinoLogger,
  ) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = event.payload as { paymentId?: unknown };
    if (typeof payload.paymentId !== "string" || !UUID_PATTERN.test(payload.paymentId)) {
      // ADR-085: a rejection rather than a failure — retrying cannot put a paymentId into a
      // payload that has none, and there is no fee behind this row to lose.
      throw new PermanentRejection(
        `OutboxEvent ${event.id} has no valid paymentId in its payload`,
        { isIncident: false },
      );
    }
    const paymentId = payload.paymentId;

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { restaurant: true, transaction: true },
    });
    if (!payment) {
      throw new PermanentRejection(`Payment ${paymentId} no longer exists — no fee to attach`);
    }
    const transaction = payment.transaction;
    if (!transaction) {
      // Capture writes Payment.update, Transaction.create and this event in ONE transaction, so a
      // missing Transaction is not a race — it is an event produced by some other route.
      throw new PermanentRejection(
        `Payment ${paymentId} has no Transaction — this event was not produced by capture`,
      );
    }
    if (transaction.processorFeeBalanceTxnId !== null) {
      // Converged: some earlier delivery already posted it. Acknowledged, nothing written — the
      // same answer the dispute handler gives to a redelivery (ADR-090).
      await this.markPublished(event.id);
      this.logger.info(
        { eventId: event.id, transactionId: transaction.id },
        "Processing fee already posted for this Transaction — acknowledged, nothing written",
      );
      return;
    }
    if (!payment.restaurant.stripeAccountId) {
      throw new PermanentRejection(
        `Restaurant ${payment.restaurantId} has no Stripe account — its fee cannot be read`,
      );
    }

    const fee = await this.stripe.retrieveProcessingFee(
      payment.restaurant.stripeAccountId,
      payment.processorPaymentId,
    );

    if (fee === null) {
      // "Not yet", which is a retry and not an error — and the limit is what stops it being a
      // retry forever.
      if (event.attempts + 1 >= MAX_FEE_FETCH_ATTEMPTS) {
        // **What happens after the limit, stated rather than left to be discovered.** The event is
        // abandoned, so it leaves the queue instead of occupying a slot no one can free (ADR-085),
        // and the abandonment ALERTS, because a real payment whose fee is never recorded is a
        // permanent hole in the books — exactly the question ADR-087 says an operational alert is
        // for. The Transaction keeps `processorFeeBalanceTxnId = null`, and that is what the
        // Transaction Details screen reads to say *unavailable* rather than *pending*: a silence
        // nobody can see is the thing this change removes, so this silence is visible.
        throw new PermanentRejection(
          `Stripe published no BalanceTransaction for payment ${paymentId} after ` +
            `${MAX_FEE_FETCH_ATTEMPTS} attempts — its processing fee will never be posted`,
        );
      }
      throw new Error(
        `BalanceTransaction not published yet for payment ${paymentId} ` +
          `(attempt ${event.attempts + 1} of ${MAX_FEE_FETCH_ATTEMPTS}) — retrying`,
      );
    }

    if (fee.currency !== transaction.currency) {
      // A settlement currency different from the charge's is currency conversion, which this
      // system has never modelled and which OC-15 records as unestablished. Refusing is the only
      // honest option: posting a foreign-currency amount against this Transaction's currency would
      // put a wrong number in the Ledger, and the balance trigger — which sums per currency —
      // would not object to it.
      throw new PermanentRejection(
        `BalanceTransaction ${fee.balanceTransactionId} settles in ${fee.currency} but ` +
          `Transaction ${transaction.id} is ${transaction.currency} — conversion is not modelled`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // **The claim and the posting are one transaction, and the claim is the conditional write.**
      // Fourth use of the project's named idiom (CLAUDE_RULES.md): the write carries the
      // condition, and the number of rows it touched answers "was I first?". The balance trigger
      // sums an entry's own lines and knows nothing about whether another entry describes the same
      // fee (ADR-089), so nothing below the claim can catch a duplicate.
      //
      // Inside the transaction rather than before it, deliberately: a claim that committed while
      // the posting did not would mark this fee as handled with no entry behind it, permanently —
      // a silent hole created by the very mechanism meant to prevent one.
      const claimed = await tx.transaction.updateMany({
        where: { id: transaction.id, processorFeeBalanceTxnId: null },
        data: { processorFeeBalanceTxnId: fee.balanceTransactionId },
      });
      if (claimed.count !== 1) {
        this.logger.info(
          { eventId: event.id, transactionId: transaction.id },
          "Another delivery claimed this fee first — acknowledged, nothing written",
        );
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { publishedAt: new Date() },
        });
        return;
      }

      if (fee.fee > 0n) {
        await this.ledger.postJournalEntry(
          {
            entryType: "PROCESSOR_FEE",
            transactionId: transaction.id,
            description: "Stripe processing fee",
            lines: [
              {
                account: "PROCESSOR_FEE",
                direction: "DEBIT",
                amount: fee.fee,
                currency: transaction.currency,
                restaurantId: transaction.restaurantId,
              },
              {
                account: "PROCESSOR_CLEARING",
                direction: "CREDIT",
                amount: fee.fee,
                currency: transaction.currency,
                restaurantId: transaction.restaurantId,
              },
            ],
          },
          tx,
        );
      }
      // A zero fee posts no entry and still sets the claim — a zero-amount LedgerLine is noise,
      // the same convention PAYMENT_CAPTURED already follows for a fee that rounds to nothing.
      // This is why the screen reads the CLAIM rather than the entry to decide whether the number
      // is known: "known and zero" and "not known" must not collapse into one state.

      await tx.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
    });

    this.logger.info(
      {
        transactionId: transaction.id,
        balanceTransactionId: fee.balanceTransactionId,
        fee: fee.fee.toString(),
      },
      "Processing fee posted to the Ledger",
    );
  }

  private async markPublished(eventId: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: eventId },
      data: { publishedAt: new Date() },
    });
  }
}
