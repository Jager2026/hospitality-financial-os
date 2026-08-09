import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type Stripe from "stripe";
import { AppException } from "../common/exceptions/app.exception";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { splitPlatformFee } from "../payment/platform-fee.util";
import { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";
import {
  TIP_ALLOCATION_STRATEGY,
  type TipAllocationStrategy,
} from "../tip/tip-allocation-strategy.interface";

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
    private readonly config: ConfigService,
    @Inject(TIP_ALLOCATION_STRATEGY) private readonly tipAllocationStrategy: TipAllocationStrategy,
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
   * synchronously in POST /payments' response. The platform-fee split (Founder decision,
   * DEFAULT_PLATFORM_FEE_BASIS_POINTS) is computed by the SAME splitPlatformFee() call as
   * PaymentService used at PaymentIntent creation time, on the same billAmount (ADR-022:
   * payment.amount - payment.tipAmount — the fee excludes tips), so the amount Stripe actually
   * deducted (application_fee_amount) and the amount posted here to PLATFORM_FEE_REVENUE are
   * identical by construction, not two numbers that could drift apart. Payment.update +
   * Transaction.create + both Ledger writes (PAYMENT_CAPTURED, and TIP_ALLOCATED when there's a
   * tip) are one atomic transaction (LedgerService's tx param) — a crash partway through would
   * otherwise leave a Transaction with no financial trail, or a tip credited to the general
   * TIP_PAYABLE liability with no entry ever attributing it to anyone. */
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

    const billAmount = payment.amount - payment.tipAmount;
    const basisPoints = this.config.getOrThrow<number>("DEFAULT_PLATFORM_FEE_BASIS_POINTS");
    const { feeAmount, restaurantRevenue } = splitPlatformFee(billAmount, basisPoints);

    if (payment.tipAmount > 0n && !payment.waiterMembershipId) {
      // Unreachable through PaymentService's own code path (it always sets waiterMembershipId) —
      // loud failure over a silent one, per CLAUDE_RULES.md's Error Philosophy. Left unhandled
      // deliberately: the webhook's own catch (handleEvent) already deletes the IdempotencyKey on
      // any thrown error so Stripe's automatic retry can reprocess once the data is fixed.
      throw new Error(
        `Payment ${payment.id} has tipAmount > 0 but no waiterMembershipId — cannot allocate tip`,
      );
    }

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
              amount: restaurantRevenue,
              currency: payment.currency,
              restaurantId: payment.restaurantId,
            },
            // Omitted entirely when feeAmount is 0 (e.g. a gross amount small enough that basis-
            // point truncation rounds the fee down to nothing) — a zero-amount LedgerLine is
            // noise, not a fact worth recording, and the entry still balances without it.
            ...(feeAmount > 0n
              ? [
                  {
                    account: "PLATFORM_FEE_REVENUE" as const,
                    direction: "CREDIT" as const,
                    amount: feeAmount,
                    currency: payment.currency,
                    restaurantId: payment.restaurantId,
                  },
                ]
              : []),
            // ADR-022's 4th line: the general TIP_PAYABLE liability, not yet attributed to anyone
            // specific — TIP_ALLOCATED (below, same transaction) does the attribution. Omitted
            // entirely when there's no tip, same reasoning as the fee line above.
            ...(payment.tipAmount > 0n
              ? [
                  {
                    account: "TIP_PAYABLE" as const,
                    direction: "CREDIT" as const,
                    amount: payment.tipAmount,
                    currency: payment.currency,
                    restaurantId: payment.restaurantId,
                  },
                ]
              : []),
          ],
        },
        tx,
      );

      // ADR-022: tip attribution — a second, separate JournalEntry, atomic with PAYMENT_CAPTURED
      // above via the same tx. Transaction -> zero-or-one Tip (DATABASE.md): only when there's
      // actually a tip.
      if (payment.tipAmount > 0n && payment.waiterMembershipId) {
        await tx.tip.create({
          data: {
            transactionId: transaction.id,
            grossTip: payment.tipAmount,
            currency: payment.currency,
            // Both JournalEntry rows land together, atomically, in this same transaction — no
            // real PENDING window for MVP's Individual strategy to ever observe.
            status: "ALLOCATED",
          },
        });

        const allocations = this.tipAllocationStrategy.allocate(
          payment.tipAmount,
          payment.waiterMembershipId,
        );

        await this.ledger.postJournalEntry(
          {
            entryType: "TIP_ALLOCATED",
            transactionId: transaction.id,
            lines: [
              // Reverses the general liability PAYMENT_CAPTURED just credited above — no
              // membershipId. Same account as the credit(s) below; membershipId is the only
              // discriminator (ADR-022).
              {
                account: "TIP_PAYABLE",
                direction: "DEBIT",
                amount: payment.tipAmount,
                currency: payment.currency,
                restaurantId: payment.restaurantId,
              },
              ...allocations.map((allocation) => ({
                account: "TIP_PAYABLE" as const,
                direction: "CREDIT" as const,
                amount: allocation.amount,
                currency: payment.currency,
                restaurantId: payment.restaurantId,
                membershipId: allocation.membershipId,
              })),
            ],
          },
          tx,
        );
      }
    });
  }

  /** ADR-008 + ADR-023: reverses THREE accounts proportionally, not one unconditionally —
   * RESTAURANT_REVENUE_PAYABLE, PLATFORM_FEE_REVENUE, and TIP_PAYABLE (at the waiter's own
   * membershipId) — never the original entry itself, always a new compensating one.
   * `charge.amount_refunded` is Stripe's CUMULATIVE total refunded on this charge so far; the
   * delta against what we've already recorded is THIS specific refund's amount, computed the same
   * way per account as it already is for the total (DATABASE.md, Refund Rules). */
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
    const cumulativeRefunded = previouslyRecorded + newRefundAmount;

    // ADR-023: the ORIGINAL capture-time fee, read back from PAYMENT_CAPTURED's own LedgerLine —
    // never re-derived via splitPlatformFee() against the CURRENT basis-point rate, which is a
    // mutable env var (ADR-021) that could have changed between capture and this refund. Reading
    // the Ledger's own historical record instead is immune to that drift.
    const capturedFeeLine = await this.prisma.ledgerLine.findFirst({
      where: {
        account: "PLATFORM_FEE_REVENUE",
        journalEntry: { transactionId: transaction.id, entryType: "PAYMENT_CAPTURED" },
      },
    });
    const originalFeeAmount = capturedFeeLine?.amount ?? 0n;
    const originalTipAmount = payment.tipAmount; // trusted directly, same as everywhere else

    // Proportional, cumulative amount for each account — RESTAURANT_REVENUE_PAYABLE's share is
    // always the residual, never its own independent division (ADR-001/ADR-021's largest-
    // remainder discipline: two independently-floored shares can round down and leave a
    // remainder; deriving the third by subtraction is what keeps the three shares summing to
    // exactly cumulativeRefunded, which LedgerService's own balance check requires regardless).
    const cumulativeTipReversed = (originalTipAmount * cumulativeRefunded) / payment.amount;
    const cumulativeFeeReversed = (originalFeeAmount * cumulativeRefunded) / payment.amount;
    const cumulativeRevenueReversed =
      cumulativeRefunded - cumulativeTipReversed - cumulativeFeeReversed;

    // "Already reversed" per account — read back from prior REFUND_ISSUED LedgerLines for this
    // Transaction, the same way previouslyRecorded above reads prior Refund rows. No new stored
    // running total: the Ledger already owns this history (ADR-002).
    const priorRevenueReversed = await this.sumPriorRefundReversal(
      transaction.id,
      "RESTAURANT_REVENUE_PAYABLE",
    );
    const priorFeeReversed = await this.sumPriorRefundReversal(
      transaction.id,
      "PLATFORM_FEE_REVENUE",
    );
    const priorTipReversed = payment.waiterMembershipId
      ? await this.sumPriorRefundReversal(transaction.id, "TIP_PAYABLE", payment.waiterMembershipId)
      : 0n;

    const revenueDelta = cumulativeRevenueReversed - priorRevenueReversed;
    const feeDelta = cumulativeFeeReversed - priorFeeReversed;
    const tipDelta = cumulativeTipReversed - priorTipReversed;

    // Known boundary: under out-of-order delivery, `latestRefund` (Stripe's most-recent-first
    // list) isn't guaranteed to be the specific refund that produced THIS delta — the Ledger
    // amount stays correct either way (it's derived from amount_refunded, not from this object),
    // but processorRefundId/reason on this particular Refund row could end up describing a
    // different originating event than the amount it's attached to.
    const latestRefund = charge.refunds?.data?.[0];

    await this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.create({
        data: {
          transactionId: transaction.id,
          processorRefundId: latestRefund?.id ?? `unmatched_${event.id}`,
          amount: newRefundAmount,
          currency: transaction.currency,
          reason: latestRefund?.reason ?? "unspecified",
          tipRefunded: tipDelta > 0n, // ADR-023: computed per event, not hardcoded
          status: "SUCCEEDED",
        },
      });

      await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          status: cumulativeRefunded >= transaction.grossAmount ? "REFUNDED" : "PARTIALLY_REFUNDED",
        },
      });

      await this.ledger.postJournalEntry(
        {
          entryType: "REFUND_ISSUED",
          transactionId: transaction.id,
          refundId: refund.id,
          lines: [
            // Each omitted when its delta rounds to exactly zero — same convention
            // PAYMENT_CAPTURED already uses for PLATFORM_FEE_REVENUE and TIP_PAYABLE.
            ...(revenueDelta > 0n
              ? [
                  {
                    account: "RESTAURANT_REVENUE_PAYABLE" as const,
                    direction: "DEBIT" as const,
                    amount: revenueDelta,
                    currency: transaction.currency,
                    restaurantId: transaction.restaurantId,
                  },
                ]
              : []),
            ...(feeDelta > 0n
              ? [
                  {
                    account: "PLATFORM_FEE_REVENUE" as const,
                    direction: "DEBIT" as const,
                    amount: feeDelta,
                    currency: transaction.currency,
                    restaurantId: transaction.restaurantId,
                  },
                ]
              : []),
            // Reverses the waiter's own credited share (ADR-022) — never the general
            // membershipId: null line, which no longer exists once TIP_ALLOCATED has run.
            ...(tipDelta > 0n && payment.waiterMembershipId
              ? [
                  {
                    account: "TIP_PAYABLE" as const,
                    direction: "DEBIT" as const,
                    amount: tipDelta,
                    currency: transaction.currency,
                    restaurantId: transaction.restaurantId,
                    membershipId: payment.waiterMembershipId,
                  },
                ]
              : []),
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

  /** Sum of a single account's DEBIT lines across every prior REFUND_ISSUED entry on this
   * Transaction — the "already reversed" side of handleChargeRefunded's per-account delta. */
  private async sumPriorRefundReversal(
    transactionId: string,
    account: "RESTAURANT_REVENUE_PAYABLE" | "PLATFORM_FEE_REVENUE" | "TIP_PAYABLE",
    membershipId?: string,
  ): Promise<bigint> {
    const result = await this.prisma.ledgerLine.aggregate({
      where: {
        account,
        direction: "DEBIT",
        membershipId: membershipId ?? null,
        journalEntry: { transactionId, entryType: "REFUND_ISSUED" },
      },
      _sum: { amount: true },
    });
    return result._sum.amount ?? 0n;
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
