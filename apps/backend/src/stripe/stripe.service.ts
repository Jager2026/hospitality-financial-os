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

// ADR-009 / ADR-014 (revised): Accounts v2, dashboard: "full" (Standard-equivalent) — the
// platform bears no fraud/chargeback liability for a restaurant's own payments (confirmed
// empirically: `losses_collector: "stripe"` is the ONLY accepted value paired with
// `dashboard: "full"`; the API rejects `"application"` for that pairing, not the other way
// around, which is why this isn't Express's shape).
@Injectable()
export class StripeService {
  private readonly stripe: Stripe;

  constructor(config: ConfigService) {
    this.stripe = new Stripe(config.getOrThrow<string>("STRIPE_SECRET_KEY"));
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
}
