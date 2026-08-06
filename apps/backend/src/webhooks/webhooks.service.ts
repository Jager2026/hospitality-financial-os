import { Injectable, Logger } from "@nestjs/common";
import type Stripe from "stripe";
import { AppException } from "../common/exceptions/app.exception";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";

const WEBHOOK_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** API_Contract.md, Incoming Webhooks — Stripe. Verifies the signature first, then deduplicates
 * by Stripe's own event id (via IdempotencyKey — same table the header-based IdempotencyInterceptor
 * uses for client requests, ADR-004) before any Ledger write. */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly ledger: LedgerService,
    private readonly restaurantService: RestaurantService,
  ) {}

  async handleEvent(rawBody: Buffer, signature: string | undefined): Promise<{ received: true }> {
    if (!signature) {
      throw new AppException("VALIDATION_ERROR", "Missing Stripe-Signature header.", 400);
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.constructWebhookEvent(rawBody, signature);
    } catch {
      throw new AppException("VALIDATION_ERROR", "Invalid Stripe webhook signature.", 400);
    }

    const shouldProcess = await this.claimEvent(event);
    if (!shouldProcess) {
      return { received: true }; // known duplicate delivery — acknowledged, not reprocessed
    }

    try {
      await this.dispatch(event);
      await this.prisma.idempotencyKey.update({
        where: { key: event.id },
        data: { status: "COMPLETED", responseSnapshot: { received: true } },
      });
    } catch (err) {
      // Delete rather than mark FAILED: FAILED is a terminal state for a client-supplied key
      // (API_Contract.md — the client mints a new one and retries), but Stripe always resends
      // the SAME event id on retry. Deleting lets claimEvent() accept that retry cleanly instead
      // of permanently refusing to ever reprocess a transiently-failed event.
      await this.prisma.idempotencyKey.delete({ where: { key: event.id } }).catch(() => undefined);
      throw err;
    }

    return { received: true };
  }

  /** True if this delivery should be processed now; false if it's a known duplicate (already
   * COMPLETED, or IN_PROGRESS from a concurrent delivery) that should be quietly acknowledged. */
  private async claimEvent(event: Stripe.Event): Promise<boolean> {
    const existing = await this.prisma.idempotencyKey.findUnique({ where: { key: event.id } });
    if (existing) return false;

    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: event.id,
          endpointScope: "webhooks/stripe",
          requestFingerprint: event.type,
          status: "IN_PROGRESS",
          expiresAt: new Date(Date.now() + WEBHOOK_KEY_TTL_MS),
        },
      });
      return true;
    } catch {
      // Unique-constraint race: two near-simultaneous deliveries both passed findUnique above
      // before either insert landed — the loser here also treats it as a duplicate.
      return false;
    }
  }

  private async dispatch(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case "payment_intent.succeeded":
        return this.handlePaymentIntentSucceeded(event);
      case "charge.refunded":
        return this.handleChargeRefunded(event);
      case "charge.dispute.created":
        return this.handleDisputeCreated(event);
      case "charge.dispute.closed":
        return this.handleDisputeClosed(event);
      case "account.updated":
        return this.handleAccountUpdated(event);
      default:
        this.logger.debug(`Unhandled Stripe event type: ${event.type}`);
    }
  }

  /** ADR-015: the Ledger write happens here, asynchronously, driven by this webhook — never
   * synchronously in POST /payments' response. No platform-fee split yet: Sprint 5's fee
   * percentage is a separate, still-open founder decision (tracked separately, not guessed) — the
   * full remitted amount posts to Restaurant Revenue Payable today, an honest "not yet decided"
   * state, not a fabricated split. Payment.update + Transaction.create + the Ledger write are one
   * atomic transaction (LedgerService's tx param) — a crash between them would otherwise leave a
   * Transaction with no financial trail behind it. */
  private async handlePaymentIntentSucceeded(event: Stripe.Event): Promise<void> {
    const intent = event.data.object as Stripe.PaymentIntent;
    const payment = await this.prisma.payment.findFirst({
      where: { processorPaymentId: intent.id },
    });
    if (!payment) {
      this.logger.warn(`payment_intent.succeeded for unknown PaymentIntent ${intent.id}`);
      return;
    }
    if (payment.status === "SUCCEEDED") return; // defensive no-op; claimEvent already dedupes the normal case

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED" } });

      const transaction = await tx.transaction.create({
        data: {
          paymentId: payment.id,
          restaurantId: payment.restaurantId,
          grossAmount: payment.amount,
          currency: payment.currency,
          status: "COMPLETED",
        },
      });

      await this.ledger.postJournalEntry(
        {
          entryType: "PAYMENT_CAPTURED",
          transactionId: transaction.id,
          lines: [
            {
              account: "PROCESSOR_CLEARING",
              direction: "DEBIT",
              amount: payment.amount,
              currency: payment.currency,
              restaurantId: payment.restaurantId,
            },
            {
              account: "RESTAURANT_REVENUE_PAYABLE",
              direction: "CREDIT",
              amount: payment.amount,
              currency: payment.currency,
              restaurantId: payment.restaurantId,
            },
          ],
        },
        tx,
      );
    });
  }

  /** ADR-008: always produces a new JournalEntry reversing Restaurant Revenue Payable into
   * Refund Contra — the original entry is never edited. `charge.amount_refunded` is Stripe's
   * CUMULATIVE total refunded on this charge so far; the delta against what we've already
   * recorded (sum of our own Refund rows) is THIS specific refund's amount — derived from our own
   * data, not assumed from the payload's `refunds` sub-list ordering, so multiple partial refunds
   * each land as their own correct row (DATABASE.md, Refund Rules). */
  private async handleChargeRefunded(event: Stripe.Event): Promise<void> {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId =
      typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    if (!paymentIntentId) {
      this.logger.warn(`charge.refunded with no payment_intent on charge ${charge.id}`);
      return;
    }

    const payment = await this.prisma.payment.findFirst({
      where: { processorPaymentId: paymentIntentId },
    });
    if (!payment) {
      this.logger.warn(`charge.refunded for unknown PaymentIntent ${paymentIntentId}`);
      return;
    }
    const transaction = await this.prisma.transaction.findUnique({
      where: { paymentId: payment.id },
    });
    if (!transaction) {
      this.logger.warn(`charge.refunded for Payment ${payment.id} with no Transaction yet`);
      return;
    }

    const alreadyRefunded = await this.prisma.refund.aggregate({
      where: { transactionId: transaction.id },
      _sum: { amount: true },
    });
    const previouslyRecorded = alreadyRefunded._sum.amount ?? 0n;
    const newRefundAmount = BigInt(charge.amount_refunded) - previouslyRecorded;
    if (newRefundAmount <= 0n) {
      return; // nothing new — a duplicate or out-of-order delivery
    }

    // Known boundary: under out-of-order delivery, `latestRefund` (Stripe's most-recent-first
    // list) isn't guaranteed to be the specific refund that produced THIS delta — the Ledger
    // amount stays correct either way (it's derived from amount_refunded, not from this object),
    // but processorRefundId/reason on this particular Refund row could end up describing a
    // different originating event than the amount it's attached to.
    const latestRefund = charge.refunds?.data?.[0];
    const totalRefunded = previouslyRecorded + newRefundAmount;

    await this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.create({
        data: {
          transactionId: transaction.id,
          processorRefundId: latestRefund?.id ?? `unmatched_${event.id}`,
          amount: newRefundAmount,
          currency: transaction.currency,
          reason: latestRefund?.reason ?? "unspecified",
          tipRefunded: false, // no Tip exists yet — Sprint 6
          status: "SUCCEEDED",
        },
      });

      await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          status: totalRefunded >= transaction.grossAmount ? "REFUNDED" : "PARTIALLY_REFUNDED",
        },
      });

      await this.ledger.postJournalEntry(
        {
          entryType: "REFUND_ISSUED",
          transactionId: transaction.id,
          refundId: refund.id,
          lines: [
            {
              account: "RESTAURANT_REVENUE_PAYABLE",
              direction: "DEBIT",
              amount: newRefundAmount,
              currency: transaction.currency,
              restaurantId: transaction.restaurantId,
            },
            {
              account: "REFUND_CONTRA",
              direction: "CREDIT",
              amount: newRefundAmount,
              currency: transaction.currency,
              restaurantId: transaction.restaurantId,
            },
          ],
        },
        tx,
      );
    });
  }

  /** ADR-016: a dispute is a provisional loss the moment it opens — written immediately, the
   * same shape as a Refund. Never a held-funds account; if the dispute is later won,
   * handleDisputeClosed posts a second, reversing JournalEntry rather than editing this one. */
  private async handleDisputeCreated(event: Stripe.Event): Promise<void> {
    const dispute = event.data.object as Stripe.Dispute;
    const paymentIntentId =
      typeof dispute.payment_intent === "string"
        ? dispute.payment_intent
        : dispute.payment_intent?.id;
    if (!paymentIntentId) {
      this.logger.warn(`charge.dispute.created with no payment_intent, dispute ${dispute.id}`);
      return;
    }

    const payment = await this.prisma.payment.findFirst({
      where: { processorPaymentId: paymentIntentId },
    });
    if (!payment) {
      this.logger.warn(`charge.dispute.created for unknown PaymentIntent ${paymentIntentId}`);
      return;
    }
    const transaction = await this.prisma.transaction.findUnique({
      where: { paymentId: payment.id },
    });
    if (!transaction) return;

    await this.prisma.$transaction(async (tx) => {
      const chargeback = await tx.chargeback.create({
        data: {
          transactionId: transaction.id,
          processorDisputeId: dispute.id,
          reason: dispute.reason,
          amount: BigInt(dispute.amount),
          currency: transaction.currency,
          status: "UNDER_REVIEW",
          evidenceDueBy: dispute.evidence_details?.due_by
            ? new Date(dispute.evidence_details.due_by * 1000)
            : null,
        },
      });

      await tx.transaction.update({ where: { id: transaction.id }, data: { status: "DISPUTED" } });

      await this.ledger.postJournalEntry(
        {
          entryType: "CHARGEBACK",
          transactionId: transaction.id,
          chargebackId: chargeback.id,
          description: "Provisional loss — dispute opened",
          lines: [
            {
              account: "RESTAURANT_REVENUE_PAYABLE",
              direction: "DEBIT",
              amount: BigInt(dispute.amount),
              currency: transaction.currency,
              restaurantId: transaction.restaurantId,
            },
            {
              account: "REFUND_CONTRA",
              direction: "CREDIT",
              amount: BigInt(dispute.amount),
              currency: transaction.currency,
              restaurantId: transaction.restaurantId,
            },
          ],
        },
        tx,
      );
    });
  }

  /** ADR-016: WON reverses the provisional loss with a second JournalEntry. LOST posts nothing
   * further — the provisional loss already posted at dispute.created stands as the final,
   * correct state. Either way, the original provisional entry is never edited. */
  private async handleDisputeClosed(event: Stripe.Event): Promise<void> {
    const dispute = event.data.object as Stripe.Dispute;
    const chargeback = await this.prisma.chargeback.findFirst({
      where: { processorDisputeId: dispute.id },
    });
    if (!chargeback) {
      this.logger.warn(`charge.dispute.closed for unknown dispute ${dispute.id}`);
      return;
    }
    if (chargeback.status !== "UNDER_REVIEW") return; // already resolved — dedup safety net

    const transaction = await this.prisma.transaction.findUnique({
      where: { id: chargeback.transactionId },
    });
    if (!transaction) return;

    const won = dispute.status === "won";

    await this.prisma.$transaction(async (tx) => {
      await tx.chargeback.update({
        where: { id: chargeback.id },
        data: { status: won ? "WON" : "LOST", resolvedAt: new Date() },
      });

      if (won) {
        await this.ledger.postJournalEntry(
          {
            entryType: "CHARGEBACK",
            transactionId: transaction.id,
            chargebackId: chargeback.id,
            description: "Dispute won — reversing provisional loss",
            lines: [
              {
                account: "REFUND_CONTRA",
                direction: "DEBIT",
                amount: chargeback.amount,
                currency: chargeback.currency,
                restaurantId: transaction.restaurantId,
              },
              {
                account: "RESTAURANT_REVENUE_PAYABLE",
                direction: "CREDIT",
                amount: chargeback.amount,
                currency: chargeback.currency,
                restaurantId: transaction.restaurantId,
              },
            ],
          },
          tx,
        );
      }

      await tx.transaction.update({
        where: { id: transaction.id },
        data: { status: won ? "COMPLETED" : "DISPUTED" },
      });
    });
  }

  /** The webhook only tells us WHICH account changed, never what changed to — see
   * RestaurantService.refreshStripeStatusByAccountId's own comment for why we deliberately never
   * parse the webhook payload's embedded Account object for capability data. */
  private async handleAccountUpdated(event: Stripe.Event): Promise<void> {
    const account = event.data.object as Stripe.Account;
    const updated = await this.restaurantService.refreshStripeStatusByAccountId(account.id);
    if (!updated) {
      this.logger.warn(`account.updated for unknown Stripe account ${account.id}`);
    }
  }
}
