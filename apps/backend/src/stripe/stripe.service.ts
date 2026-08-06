import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";

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

// ADR-009 / ADR-014 (revised): Accounts v2, dashboard: "full" (Standard-equivalent) — the
// platform bears no fraud/chargeback liability for a restaurant's own payments (confirmed
// empirically: `losses_collector: "stripe"` is the ONLY accepted value paired with
// `dashboard: "full"`; the API rejects `"application"` for that pairing, not the other way
// around, which is why this isn't Express's shape).
@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    this.stripe = new Stripe(config.getOrThrow<string>("STRIPE_SECRET_KEY"));
    this.webhookSecret = config.getOrThrow<string>("STRIPE_WEBHOOK_SECRET");
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

  /** ADR-004 / API_Contract.md, Incoming Webhooks: "Verifies the Stripe signature before any
   * processing." rawBody must be the exact, unparsed request bytes (main.ts's `rawBody: true`) —
   * constructEvent HMACs the raw bytes, not a re-serialized JSON.stringify of the parsed body. */
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
