import { Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import Stripe from "stripe";
import { AlertService } from "../common/alerting/alert.service";
import type { Env } from "../config/env.validation";

export interface CreateConnectAccountParams {
  contactEmail: string;
  displayName: string;
  country: string; // ISO 3166-1 alpha-2
}

export interface ConnectAccountStatus {
  cardPaymentsStatus: string | null;
  payoutsStatus: string | null;
  requirementsDue: unknown;
}

/** Direct charge (ADR-014: SaaS pattern — dashboard "full", Restaurant is merchant of record).
 * The PaymentIntent is created ON the connected account (stripeAccountId), not the platform
 * account. applicationFeeAmount is the platform's cut — optional and left unset by every caller
 * today; Sprint 5's platform-fee percentage is still an open founder decision (tracked
 * separately), and this method only accepts whatever it's given, it never computes a fee. */
export interface CreatePaymentIntentParams {
  stripeAccountId: string;
  amount: bigint; // minor units (ADR-001)
  currency: string; // ISO 4217
  applicationFeeAmount?: bigint; // minor units — platform's cut, if any
}

export interface CreatedPaymentIntent {
  id: string;
  clientSecret: string;
  amount: number;
  currency: string;
}

export interface RetrievedPaymentIntent {
  id: string;
  status: Stripe.PaymentIntent.Status;
}

// ADR-009 / ADR-014 (revised): Accounts v2, dashboard: "full" (Standard-equivalent) — the
// platform bears no fraud/chargeback liability for a restaurant's own payments (confirmed
// empirically: `losses_collector: "stripe"` is the ONLY accepted value paired with
// `dashboard: "full"`; the API rejects `"application"` for that pairing, not the other way
// around, which is why this isn't Express's shape).
@Injectable()
export class StripeService implements OnModuleInit {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly nodeEnv: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly alerts: AlertService,
    private readonly logger: PinoLogger,
  ) {
    this.stripe = new Stripe(config.getOrThrow<string>("STRIPE_SECRET_KEY"));
    this.webhookSecret = config.getOrThrow<string>("STRIPE_WEBHOOK_SECRET");
    this.nodeEnv = config.getOrThrow<string>("NODE_ENV");
    this.logger.setContext(StripeService.name);
  }

  /** ADR-038 Decision 2 — the boot-time liveness probe, and the only mechanism in this codebase
   * that catches a *silently corrupted* credential rather than a malformed-looking one.
   *
   * Why it exists: a `STRIPE_SECRET_KEY` missing exactly one character out of 107 passed every
   * shape rule, booted cleanly, went green on /health, and surfaced eleven days later on a real
   * business call as `invalid_v2_key` — an error naming the key's permissions, not its integrity,
   * which sent the investigation everywhere except the actual cause. This asks the only question
   * that matters, at the one moment where the answer is unambiguous: does this credential work?
   *
   * **It MUST call a v2 endpoint. Do not "optimize" this to a cheaper v1 call.** Not for the
   * reason originally assumed — a v1 call does reject the truncated key too (verified directly
   * against the real corrupted value, contradicting what this project had earlier told Stripe
   * support). The real reason is narrower and survives that correction: v2 Accounts access is
   * enabled per Stripe account and can be absent while the key is otherwise perfectly valid. Only
   * a v2 call proves the credential can do the thing restaurant onboarding actually needs
   * (`v2.core.accounts.create`, ADR-009/ADR-014). A v1 probe would report a healthy key for an
   * account that cannot create a single connected account.
   *
   * Alerts, never blocks (Founder decision): the problem being solved is *time to discovery*, not
   * a bad boot. Refusing to start would couple this service's availability to Stripe's, which is
   * disproportionate for an application that today serves every non-payment route without Stripe
   * at all. The ERROR log is unconditional and deliberately separate from `sendAlert()`, which
   * returns early when `ALERT_WEBHOOK_URL` is unset (optional by ADR-031) — the same "log always,
   * webhook additionally" split `OutboxPollerService` already uses, so an unconfigured channel
   * degrades to a loud log rather than to silence.
   *
   * Production only, gated on `NODE_ENV` — deliberately NOT a dedicated on/off flag. A bypass flag
   * is a thing that can be set correctly everywhere and wrongly in one place, and the one place
   * that matters is the one where nobody would notice. `NODE_ENV` already exists, is already a
   * validated enum, and is already load-bearing for far more than this: a wrong value there breaks
   * so much else that it cannot fail quietly the way a bespoke flag could. */
  async onModuleInit(): Promise<void> {
    if (this.nodeEnv !== "production") return;
    await this.verifyCredentialOrAlert();
  }

  private async verifyCredentialOrAlert(): Promise<void> {
    try {
      await this.stripe.v2.core.accounts.list({ limit: 1 });
      this.logger.info("Stripe credential verified at boot (v2 Accounts reachable)");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code;
      // Unconditional, and first: this must survive ALERT_WEBHOOK_URL being unset.
      this.logger.error(
        { err, code },
        "STRIPE CREDENTIAL REJECTED AT BOOT — the configured STRIPE_SECRET_KEY does not work " +
          "against the Stripe v2 Accounts API. Payments and restaurant onboarding will fail. " +
          "Check the value for truncation or corruption in transit; compare its length and last " +
          "characters against the key shown in the Stripe Dashboard.",
      );
      try {
        await this.alerts.sendAlert(
          `Stripe credential rejected at boot: ${code ?? "unknown"} — ${detail}`,
          { code },
        );
      } catch (alertErr) {
        // Defensive, matching PaymentReconciliationService/OutboxPollerService (ADR-032): a
        // throwing AlertService must never turn a diagnostic into a crashed boot.
        this.logger.warn({ err: alertErr }, "Failed to dispatch the Stripe credential alert");
      }
    }
  }

  async createConnectAccount(params: CreateConnectAccountParams): Promise<string> {
    const account = await this.stripe.v2.core.accounts.create({
      contact_email: params.contactEmail,
      display_name: params.displayName,
      dashboard: "full",
      defaults: {
        responsibilities: {
          losses_collector: "stripe",
          fees_collector: "stripe",
        },
      },
      identity: { country: params.country },
      configuration: {
        customer: {},
        merchant: {
          capabilities: { card_payments: { requested: true } },
        },
      },
    });
    return account.id;
  }

  async createOnboardingLink(
    stripeAccountId: string,
    refreshUrl: string,
    returnUrl: string,
  ): Promise<string> {
    const link = await this.stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    });
    return link.url;
  }

  /** Reads the real capability-status shape (ADR-009's revision) — never flattens to a boolean.
   * card_payments and stripe_balance.payouts are the only two capabilities this platform
   * requests, so they're the only two read back. */
  async getAccountStatus(stripeAccountId: string): Promise<ConnectAccountStatus> {
    const account = await this.stripe.v2.core.accounts.retrieve(stripeAccountId, {
      include: ["configuration.merchant", "requirements"],
    });
    const capabilities = account.configuration?.merchant?.capabilities;
    return {
      cardPaymentsStatus: capabilities?.card_payments?.status ?? null,
      payoutsStatus: capabilities?.stripe_balance?.payouts?.status ?? null,
      requirementsDue: account.requirements?.entries ?? null,
    };
  }

  /** Direct charge: the second argument (`{ stripeAccount }`) is Stripe's request-option for
   * "create this ON the connected account," not a body field — the connected account is the
   * merchant of record (ADR-014). No `payment_method_types` — deliberately omitted so Stripe
   * surfaces dynamic, Dashboard-configured payment methods rather than a hardcoded one; the one
   * exception (Terminal / `card_present`) doesn't apply here, this is Stripe.js client-side
   * confirmation (ADR-015), not physical card-reader hardware. */
  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<CreatedPaymentIntent> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: Number(params.amount),
        currency: params.currency.toLowerCase(),
        ...(params.applicationFeeAmount !== undefined
          ? { application_fee_amount: Number(params.applicationFeeAmount) }
          : {}),
      },
      { stripeAccount: params.stripeAccountId },
    );
    if (!intent.client_secret) {
      throw new Error("Stripe PaymentIntent created without a client_secret.");
    }
    return {
      id: intent.id,
      clientSecret: intent.client_secret,
      amount: intent.amount,
      currency: intent.currency,
    };
  }

  /** Sprint 13 (Deployment follow-up), ADR-032: PaymentReconciliationService's own read against
   * Stripe's real, current state for a Payment stuck in PENDING — never trusted from a cached
   * value, the same "ask the source of truth directly" reasoning as everywhere else Stripe is the
   * system of record. Direct charge, same `{ stripeAccount }` request-option as createPaymentIntent
   * — this PaymentIntent lives on the connected account, not the platform account. */
  async retrievePaymentIntent(
    stripeAccountId: string,
    paymentIntentId: string,
  ): Promise<RetrievedPaymentIntent> {
    const intent = await this.stripe.paymentIntents.retrieve(
      paymentIntentId,
      {},
      { stripeAccount: stripeAccountId },
    );
    return { id: intent.id, status: intent.status };
  }

  /** ADR-004 / API_Contract.md, Incoming Webhooks: "Verifies the Stripe signature before any
   * processing." rawBody must be the exact, unparsed request bytes (main.ts's `rawBody: true`) —
   * constructEvent HMACs the raw bytes, not a re-serialized JSON.stringify of the parsed body. */
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
