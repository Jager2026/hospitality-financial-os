import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import type { Payment, Restaurant } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { AlertService } from "../common/alerting/alert.service";
import { PermanentRejection } from "../common/errors/permanent-rejection";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { WebhooksService } from "../webhooks/webhooks.service";

const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — starting point, not measured against real payment latency yet
const PENDING_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes — a Payment normally resolves in seconds; this is "clearly stuck," not "slow"
const BATCH_SIZE = 100; // same bounded-query discipline as OutboxPollerService's own BATCH_SIZE — a real incident with many stuck payments should not turn one query unbounded

/** ADR-032: THREAT_MODEL.md's "Stripe unreachable at the moment of payment," "Bank or card issuer
 * timeout during confirmation," and "Webhook and client-side confirmation diverging" — a real,
 * running-now mechanism, not just an alert. A Payment stuck in PENDING past the threshold gets
 * checked directly against Stripe (the actual source of truth, never assumed from our own stale
 * copy): if Stripe already confirms success, this self-heals by running the exact same capture
 * logic the webhook itself would have (WebhooksService.captureFromPaymentIntentId) — most of
 * these existing threats are exactly "the webhook that should have told us this never arrived,"
 * which this closes without waiting for a human. Anything Stripe itself can't resolve (Stripe
 * unreachable, or genuinely still stuck/failed on Stripe's own side) becomes an alert via the same
 * AlertService the Outbox Lag mechanism already uses (ADR-031) — fired once per Payment, not every
 * cycle, the same "exactly once" reasoning as that mechanism's own threshold check. */
@Injectable()
export class PaymentReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly webhooksService: WebhooksService,
    private readonly alertService: AlertService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PaymentReconciliationService.name);
  }

  @Interval(RECONCILIATION_INTERVAL_MS)
  async reconcile(): Promise<void> {
    // Deliberately NOT filtered by reconciliationAlertSentAt here — every stuck Payment gets
    // checked against Stripe on every cycle regardless of alert history, so a payment that
    // resolves on Stripe's side AFTER already being alerted about still gets self-healed on the
    // very next cycle. Only the alert-SENDING step (below) is gated by that marker.
    // ADR-085. This query needed no new clause, and that is the whole point of the change below:
    // `Payment.status` has had CANCELED, FAILED and DECLINED in its enum since the schema was
    // written, and nothing in this codebase has ever written any of them. A Payment could leave
    // PENDING in exactly one way — by succeeding — so every payment that did not succeed stayed in
    // this batch of 100 forever, oldest-first, and a genuinely stuck one behind them was never
    // reached. The terminal states were designed in from the start; they were simply never wired
    // up.
    const stuck = await this.prisma.payment.findMany({
      where: {
        status: "PENDING",
        createdAt: { lt: new Date(Date.now() - PENDING_THRESHOLD_MS) },
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
      include: { restaurant: true },
    });

    for (const payment of stuck) {
      // One Payment's own failure (Stripe error, a bug in self-healing, an alert delivery
      // problem) must never abort reconciliation for every OTHER stuck Payment in the same
      // batch — found via the exact same class of gap OutboxPollerService's own alert call site
      // had (ADR-031/032): no per-item guard around a loop whose body can throw.
      try {
        await this.reconcileOne(payment);
      } catch (err) {
        this.logger.error(
          { paymentId: payment.id, err },
          "Reconciliation failed unexpectedly for this Payment",
        );
      }
    }
  }

  private async reconcileOne(payment: Payment & { restaurant: Restaurant }): Promise<void> {
    if (!payment.restaurant.stripeAccountId) {
      // Unreachable through the normal flow — PaymentService requires a connected account before
      // it will ever create a Payment (createPaymentIntent, restaurant.service.ts) — but a stuck
      // PENDING row with no way to ask Stripe anything is exactly the kind of state this worker
      // exists to catch, not silently skip.
      await this.alert(
        payment,
        `Payment ${payment.id} has been PENDING for over 15 minutes and its Restaurant has no Stripe account — cannot reconcile.`,
      );
      return;
    }

    // Retrieving from Stripe and self-healing are deliberately NOT in the same try/catch — a
    // failure inside captureFromPaymentIntentId (a real bug in our own Ledger/Wallet code) would
    // otherwise be caught here and misreported as "Stripe could not be reached," which is a
    // different, factually wrong diagnosis pointing whoever reads the alert at the wrong system.
    let intentStatus: string;
    try {
      const intent = await this.stripe.retrievePaymentIntent(
        payment.restaurant.stripeAccountId,
        payment.processorPaymentId,
      );
      intentStatus = intent.status;
    } catch (err) {
      // ADR-085. StripeService raises PermanentRejection for one thing only: this PaymentIntent
      // does not exist on this connected account. That is not "Stripe could not be reached" — it
      // is an answer, and the answer will not change. A Payment row pointing at an id Stripe has
      // never heard of is a divergence between our records and the processor's, so it alerts as
      // loudly as before; what it no longer does is ask the same unanswerable question every five
      // minutes forever from the head of the batch.
      if (err instanceof PermanentRejection) {
        await this.conclude(
          payment,
          "FAILED",
          `Payment ${payment.id} has been PENDING for over 15 minutes and Stripe does not have it. ${err.message}`,
        );
        return;
      }

      await this.alert(
        payment,
        `Payment ${payment.id} has been PENDING for over 15 minutes and Stripe could not be reached to verify it. ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (intentStatus === "succeeded") {
      this.logger.warn(
        { paymentId: payment.id },
        "Reconciliation found a PENDING Payment that Stripe already confirmed succeeded — self-healing (the payment_intent.succeeded webhook likely never arrived)",
      );
      await this.webhooksService.captureFromPaymentIntentId(payment.processorPaymentId);
      return;
    }

    // ADR-085. `canceled` is one of exactly two terminal PaymentIntent statuses (the other is
    // `succeeded`, handled above): Stripe's own documentation says cancellation invalidates the
    // intent for future payment attempts and cannot be undone. So this Payment is finished, and
    // recording that is not "giving up" — it is copying a conclusion Stripe has already reached.
    //
    // Every other status — requires_payment_method, requires_confirmation, requires_action,
    // processing, requires_capture — is NON-terminal, and this deliberately does nothing new with
    // them. An intent sitting at requires_payment_method could still be paid, and marking our row
    // CANCELED while the intent is live at Stripe would let a later success webhook capture money
    // against a Payment we had already written off. Concluding those safely means cancelling the
    // intent at Stripe first, which is an outward action against a customer's payment and a
    // product decision, not an engineering one — recorded as the open case in ADR-085.
    if (intentStatus === "canceled") {
      await this.conclude(
        payment,
        "CANCELED",
        `Payment ${payment.id} has been PENDING for over 15 minutes and Stripe reports it was canceled.`,
      );
      return;
    }

    await this.alert(
      payment,
      `Payment ${payment.id} has been PENDING for over 15 minutes. Stripe reports status="${intentStatus}".`,
    );
  }

  /**
   * ADR-085. Writes the terminal status this Payment has actually reached, so it leaves the queue.
   *
   * **The alert count is deliberately unchanged by this method.** `alert()` below is already
   * gated on `reconciliationAlertSentAt` and fires at most once per Payment; every case routed
   * here alerted exactly once before this change too, on the same channel, and still does. What
   * changes is the wording (it now says what was concluded rather than describing a status) and
   * the fact that the row stops being re-asked about afterwards.
   *
   * The alert is sent BEFORE the status is written, and the order is not arbitrary: `alert()`
   * reads `payment.reconciliationAlertSentAt` from the row this method was handed, so writing the
   * status first would change nothing about it — but a future edit that filtered alerting by
   * status would silently stop announcing the very transitions most worth announcing. Sending
   * first makes that impossible to introduce by accident.
   */
  private async conclude(
    payment: Payment,
    status: "CANCELED" | "FAILED",
    message: string,
  ): Promise<void> {
    await this.alert(payment, message);
    await this.prisma.payment.update({ where: { id: payment.id }, data: { status } });
    this.logger.warn(
      { paymentId: payment.id, status },
      "Reconciliation concluded a stuck PENDING Payment — it can never succeed (ADR-085)",
    );
  }

  // Fires at most once per Payment (ADR-031's own "exactly once" reasoning) — every cycle after
  // the first still runs the real Stripe check and self-heals if it can, it just stops re-sending
  // the same notification for a Payment that's still stuck in the same way it already reported.
  private async alert(payment: Payment, message: string): Promise<void> {
    if (payment.reconciliationAlertSentAt) return;

    // AlertService itself never throws — this try/catch is defense in depth anyway, the same
    // reasoning as OutboxPollerService's own call site (ADR-031/032): a throw here must not stop
    // the reconciliationAlertSentAt write below, or the next cycle would re-attempt (and
    // presumably re-fail) the same alert forever instead of degrading to "marked, not resent."
    try {
      await this.alertService.sendAlert(message, { paymentId: payment.id });
    } catch (err) {
      this.logger.warn({ paymentId: payment.id, err }, "AlertService.sendAlert() itself threw");
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { reconciliationAlertSentAt: new Date() },
    });
  }
}
