import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import type { Payment, Restaurant } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { AlertService } from "../common/alerting/alert.service";
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

    await this.alert(
      payment,
      `Payment ${payment.id} has been PENDING for over 15 minutes. Stripe reports status="${intentStatus}".`,
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
