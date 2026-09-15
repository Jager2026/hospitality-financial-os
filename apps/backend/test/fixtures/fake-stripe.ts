import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { StripeService } from "../../src/stripe/stripe.service";

/**
 * **The public surface of `StripeService`, as a type a double must satisfy in full.**
 *
 * `implements StripeService` is not available and the reason is worth stating, because it is the
 * first thing anyone will try: the real class has **private** members (`stripe`, `webhookSecret`,
 * `nodeEnv`, its two injected dependencies), and TypeScript treats private members nominally — a
 * class implementing another class with privates is rejected outright. A mapped type over
 * `keyof StripeService` keeps only the public members, which is exactly the contract a double owes.
 *
 * **What this catches:** a method added to the real service (the literal below stops compiling, as
 * `TS2741: Property … is missing`), a method removed from it (the double's extra member is now an
 * excess property), and a changed signature of any method the double implements.
 *
 * **What it does not catch, said plainly so the mechanism is not read as wider than it is:** a
 * change of *meaning* under an unchanged signature. If `retrieveProcessingFee` starts returning the
 * fee in the settlement currency rather than the charge's, every double here still compiles and
 * still lies. Nothing in a type system can see that; only a test against the real thing can.
 */
export type StripePublicApi = { [K in keyof StripeService]: StripeService[K] };

export interface FakeStripeOptions {
  /** Prefix for the synthetic connected-account ids this fake mints — e.g. `"acct_e2e"`. */
  accountPrefix?: string;
  /** The secret webhook signatures are generated with, so a spec can sign what it delivers. */
  webhookSecret?: string;
  /** Prefix for synthetic PaymentIntent ids. */
  paymentIntentPrefix?: string;
  /** The capability status `getAccountStatus` reports; the two shapes the copies used both appear. */
  requirementsDue?: Awaited<ReturnType<StripeService["getAccountStatus"]>>["requirementsDue"];
  /** Per-spec behaviour, applied over the complete base — the only thing a spec should need. */
  overrides?: Partial<StripePublicApi>;
}

/**
 * One double for `StripeService`, replacing five hand-written copies.
 *
 * **A factory rather than a shared instance, and that is the answer to the shared-state cost.** One
 * exported object would be state shared across spec files running in parallel workers — one spec's
 * override visible to another, which is its own class of defect and a worse one than duplication,
 * because it is invisible until two files happen to run together. Each caller gets its own.
 *
 * **It talks to no network.** The `Stripe` instance exists only to verify webhook signatures
 * locally, which is a pure HMAC over bytes.
 */
export function createFakeStripe(options: FakeStripeOptions = {}): StripeService {
  const {
    accountPrefix = "acct_fake",
    webhookSecret = "whsec_test_fake_secret_for_signing_only",
    paymentIntentPrefix = "pi_fake",
    requirementsDue = [],
    overrides = {},
  } = options;

  const signatureVerifier = new Stripe("sk_test_fake_never_calls_network");

  const base: StripePublicApi = {
    // Present because the real service has it, not because a spec uses it. That is the whole
    // point: a double that implements only what today's tests call is a double that will be
    // incomplete the first time the product reaches further.
    onModuleInit: async () => undefined,

    createConnectAccount: async () => `${accountPrefix}_${randomUUID()}`,

    // The real method is `createOnboardingLink`. THREE of the five copies this replaces defined
    // `createAccountLink` — a method the real service has never had — and defined no
    // `createOnboardingLink` at all. Nothing noticed, because nothing compared them.
    createOnboardingLink: async () => "https://connect.stripe.test/never-followed",

    getAccountStatus: async () => ({
      cardPaymentsStatus: "active",
      payoutsStatus: "active",
      requirementsDue,
    }),

    createPaymentIntent: async (params) => ({
      id: `${paymentIntentPrefix}_${randomUUID()}`,
      clientSecret: `${paymentIntentPrefix}_secret_${randomUUID()}`,
      amount: Number(params.amount),
      currency: params.currency.toLowerCase(),
    }),

    retrievePaymentIntent: async (_stripeAccountId: string, paymentIntentId: string) => ({
      id: paymentIntentId,
      status: "succeeded",
    }),

    // `null` is the real method's own word for *not yet* (ADR-094), so a fake that never reaches
    // Stripe gives the honest answer: the poller retries and, at its limit, abandons. Nothing is
    // posted to the Ledger, which is where these specs' behaviour was before the fee existed.
    retrieveProcessingFee: async () => null,

    constructWebhookEvent: (rawBody: Buffer, signature: string) =>
      signatureVerifier.webhooks.constructEvent(rawBody, signature, webhookSecret),
  };

  // The assertion is here, at the boundary, and nowhere else. `StripePublicApi` has already been
  // satisfied in full above — the cast only carries the private members Nest never looks at.
  return { ...base, ...overrides } as unknown as StripeService;
}
