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
  /** Edge-trigger state for `reportHeadPressure` — see its docstring for why it lives in memory. */
  private headSaturated = false;

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

    await this.reportHeadPressure(stuck.length);

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
        // An INCIDENT, and it is the discriminating pair for the canceled branch below: the same
        // method, the same conclusion, the opposite answer about the channel. A PaymentIntent id
        // Stripe has never heard of means our records and the processor's have diverged, which
        // nothing in the ordinary course produces and nobody can act on without being told.
        await this.conclude(payment, "FAILED", err.message, { incident: true });
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
      // ADR-087. Concluded, recorded, and NOT alerted. A cancelled payment is the ordinary end of
      // a card payment that did not happen — a guest who walked away, a card that was refused. It
      // used to raise one operational alert per payment, which is how a channel meant for
      // incidents fills with the second most common outcome in retail payments.
      await this.conclude(payment, "CANCELED", "Stripe reports the PaymentIntent was canceled");
      return;
    }

    // ADR-087. Every remaining status — requires_payment_method, requires_confirmation,
    // requires_action, processing, requires_capture — means **Stripe has an answer and the answer
    // is that this payment has not succeeded yet**. That is not an incident. It used to raise one
    // alert per Payment, gated once by `reconciliationAlertSentAt`; at two hundred covers an
    // evening and a tenth of them abandoned, that is twenty alerts a shift about nothing anyone
    // can act on, and a real Outbox Lag alert arriving in that channel a week later is not read.
    //
    // **What is deliberately NOT hidden by removing it:** the row stays PENDING, and this worker
    // goes on asking Stripe about it every five minutes forever. The alert was, by accident, the
    // only thing that made that visible. `reportHeadPressure` replaces it with a statement about
    // the CONDITION — the batch being full means newer stuck payments are not reached at all —
    // which is the thing actually worth waking someone for, and which fires once rather than once
    // per row. Ending the per-row work itself needs ADR-085's cancellation window, which is open
    // with its own trigger.
    //
    // `processing` is the one status here that could earn its own rule later: a card intent does
    // not sit in it for long. What "too long" means cannot be established at zero traffic, and
    // inventing the number is the same mistake the cancellation window is deliberately not making.
    this.logger.info(
      { paymentId: payment.id, intentStatus },
      "Stripe has an answer and it is not success — the payment has not been made, which is not an incident (ADR-087)",
    );
  }

  /**
   * ADR-087. One alert about the QUEUE, on the cycle it becomes saturated — not one alert per row.
   *
   * A full batch means this worker selected `BATCH_SIZE` payments that have all been `PENDING`
   * past the threshold, oldest first, and therefore **cannot see anything newer**. That is the
   * failure ADR-084 named, arriving in production instead of in a developer's database, and it is
   * an operational condition in the strict sense: the mechanism is no longer doing its job, and a
   * person has to decide something.
   *
   * It is the replacement for a signal this change removed on purpose. Per-row alerts about
   * abandoned payments were noise, but they were also — accidentally — the only evidence that the
   * head was filling. Removing a signal without replacing it is how ADR-045's invisible restart
   * loop happens: a system that has stopped working looks, from outside, exactly like one that is.
   *
   * **Edge-triggered, and the state is in memory, which has one consequence worth stating:** a
   * restart re-announces a condition that is still true. That is the right behaviour rather than a
   * defect — a new process has reported nothing yet, and a standing problem that nobody has been
   * told about is worse than one mentioned twice.
   */
  private async reportHeadPressure(batchSize: number): Promise<void> {
    const saturated = batchSize >= BATCH_SIZE;

    if (saturated && !this.headSaturated) {
      this.headSaturated = true;
      this.logger.error(
        { batchSize },
        "Reconciliation head saturated — operational alert (SYSTEM_ARCHITECTURE.md: Outbox Lag)",
      );
      try {
        await this.alertService.sendAlert(
          `Reconciliation Head Saturated: ${batchSize} payments have been PENDING past the ` +
            `threshold, which fills the whole batch. Payments newer than these are not being ` +
            `checked against Stripe at all until they resolve.`,
          { batchSize },
        );
      } catch (err) {
        this.logger.warn({ err }, "AlertService.sendAlert() itself threw");
      }
      return;
    }

    if (!saturated && this.headSaturated) {
      this.headSaturated = false;
      this.logger.info({ batchSize }, "Reconciliation head is no longer saturated");
    }
  }

  /**
   * ADR-085. Writes the terminal status this Payment has actually reached, so it leaves the queue.
   *
   * **Whether it also alerts is decided by the CALLER, because only the caller knows why**
   * (ADR-087). Concluding is one action with two meanings: a cancelled payment is the ordinary end
   * of a payment that did not happen, and a Payment whose intent Stripe has never heard of is a
   * divergence between our records and the processor's that somebody has to look at. Reading that
   * difference here — from a status enum — would be guessing from the outcome, which is exactly
   * what put expected behaviour in an incident channel in the first place.
   *
   * When it does alert, the alert is sent BEFORE the status is written, and the order is not
   * arbitrary: `alert()` reads `payment.reconciliationAlertSentAt` from the row this method was
   * handed, so writing the status first would change nothing about it — but a future edit that
   * filtered alerting by status would silently stop announcing the very transitions most worth
   * announcing. Sending first makes that impossible to introduce by accident.
   */
  private async conclude(
    payment: Payment,
    status: "CANCELED" | "FAILED",
    reason: string,
    options: { incident?: boolean } = {},
  ): Promise<void> {
    if (options.incident) {
      await this.alert(payment, `Payment ${payment.id} was concluded as ${status}. ${reason}`);
    }

    await this.prisma.payment.update({ where: { id: payment.id }, data: { status } });
    this.logger.info(
      { paymentId: payment.id, status, reason },
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
