import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Stripe from "stripe";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../prisma/prisma.service";
import type {
  ConnectAccountStatus,
  CreateConnectAccountParams,
  CreatedPaymentIntent,
  CreatePaymentIntentParams,
} from "../stripe/stripe.service";
import { StripeService } from "../stripe/stripe.service";
import { PLATFORM_TERMS_PLACEHOLDER } from "../common/agreements/agreement-versions";

const WEBHOOK_SECRET = "whsec_e2e_test_secret";
const PASSWORD = "correct horse battery staple";

/**
 * What closing a venue does, and what it deliberately does not do (ADR-054).
 *
 * Closing was implemented in Sprint 3 and **had no test of any kind** until this file — eleven
 * filtered read sites and eight deliberately unfiltered ones, none of them asserted anywhere. The
 * behaviour was correct by reading and unproven by execution, which is a weaker basis than an
 * access-affecting flag deserves.
 *
 * Three claims, each with the falsification that would break it:
 *
 *   1. A closed venue disappears from every OPERATIONAL route. Remove `deletedAt: null` from a
 *      gate and the matching case here fails.
 *   2. A closed venue's money stays visible on REPORTING routes. Add the filter there and these
 *      fail. Both halves are required: a suite that only proved disappearance would pass against
 *      an implementation that erased the venue's financial history, which is the outcome the
 *      ten-year retention floor forbids.
 *   3. A webhook arriving AFTER closure is processed and reaches the Ledger. This is the case
 *      that cannot be checked by reading a route table at all — the capture that was in flight
 *      when the owner clicked close, and the chargeback six months later.
 */
class FakeStripeService {
  private readonly stripe = new Stripe("sk_test_e2e_never_calls_network");

  async createConnectAccount(_params: CreateConnectAccountParams): Promise<string> {
    return `acct_closed_${randomUUID()}`;
  }
  async getAccountStatus(_accountId: string): Promise<ConnectAccountStatus> {
    return { cardPaymentsStatus: "active", payoutsStatus: "active", requirementsDue: [] };
  }
  async createAccountLink(_accountId: string): Promise<string> {
    return "https://connect.stripe.test/never-followed";
  }
  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<CreatedPaymentIntent> {
    return {
      id: `pi_closed_${randomUUID()}`,
      clientSecret: `pi_closed_secret_${randomUUID()}`,
      amount: Number(params.amount),
      currency: params.currency.toLowerCase(),
    };
  }
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  }
}

/** A raw JSON *string*, not a Buffer — superagent re-serialises a Buffer under a json
 * Content-Type and breaks byte equality with what was signed. Same reasoning, and same hard-won
 * detail, as `critical-flow.e2e.spec.ts`. */
function signEvent(payload: object): { rawBody: string; signature: string } {
  const raw = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET });
  return { rawBody: raw, signature: header };
}

function buildEvent(type: string, dataObject: Record<string, unknown>) {
  return {
    id: `evt_closed_${randomUUID()}`,
    object: "event",
    type,
    data: { object: dataObject },
    api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
  };
}

describe("A closed venue (E2E, real HTTP, real database)", () => {
  const prisma = new PrismaService();
  let app: INestApplication;

  let token: string;
  let restaurantId: string;
  let settledPaymentIntentId: string;
  let inFlightPaymentIntentId: string;

  async function createPayment(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/api/v1/payments")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ restaurantId, amount: 5000, tipAmount: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: res.body.data.id as string },
    });
    return payment.processorPaymentId as string;
  }

  async function deliverSucceeded(paymentIntentId: string): Promise<number> {
    const { rawBody, signature } = signEvent(
      buildEvent("payment_intent.succeeded", { id: paymentIntentId, object: "payment_intent" }),
    );
    const res = await request(app.getHttpServer())
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signature)
      .send(rawBody);
    return res.status;
  }

  async function ledgerLineCount(): Promise<number> {
    return prisma.ledgerLine.count({ where: { restaurantId } });
  }

  beforeAll(async () => {
    await prisma.$connect();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") }),
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService)
      .useValue(new FakeStripeService())
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix("api/v1", { exclude: ["health", "webhooks/stripe"] });
    await app.init();

    const email = `closed-${randomUUID()}@example.com`;
    await request(app.getHttpServer()).post("/api/v1/auth/register").send({
      email,
      password: PASSWORD,
      displayName: "Closing Owner",
      locale: "en",
      acceptedTermsVersion: PLATFORM_TERMS_PLACEHOLDER,
    });
    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    token = login.body.data.accessToken as string;

    const restaurant = await request(app.getHttpServer())
      .post("/api/v1/restaurants")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Closing Venue",
        legalName: "Closing Venue UAB",
        companyNumber: `CLOSE-${randomUUID()}`,
        vatNumber: `LT${Date.now()}`,
        email: `contact-${randomUUID()}@example.com`,
        phone: "+37060000000",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Gedimino pr. 1, Vilnius",
      });
    expect(restaurant.status, JSON.stringify(restaurant.body)).toBe(201);
    restaurantId = restaurant.body.data.id as string;

    // Two payments, both created while the venue is open. The first settles before closing and
    // becomes the financial history the reporting routes must keep showing. The second is left
    // deliberately unsettled — it is the capture still in flight at the moment the owner closes.
    settledPaymentIntentId = await createPayment();
    inFlightPaymentIntentId = await createPayment();
    expect(await deliverSucceeded(settledPaymentIntentId)).toBe(200);

    const close = await request(app.getHttpServer())
      .delete(`/api/v1/restaurants/${restaurantId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(close.status, JSON.stringify(close.body)).toBe(204);

    // Read the row rather than trusting the response: everything below is about what the next
    // query will see.
    const row = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.status).toBe("INACTIVE");
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
    await prisma.$disconnect();
  });

  // ─── 1. Operational routes: the venue is gone ────────────────────────────────────────────────

  it("disappears from the owner's own list of venues", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/restaurants")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((res.body.data as Array<{ id: string }>).map((r) => r.id)).not.toContain(restaurantId);
  });

  it("cannot be fetched, configured, staffed, or paid into", async () => {
    const auth = (path: string) =>
      request(app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

    expect((await auth(`/api/v1/restaurants/${restaurantId}`)).status).toBe(404);
    expect((await auth(`/api/v1/dashboard?restaurantId=${restaurantId}`)).status).toBe(404);
    expect((await auth(`/api/v1/restaurants/${restaurantId}/settings/tips`)).status).toBe(404);
    expect((await auth(`/api/v1/restaurants/${restaurantId}/staff`)).status).toBe(404);

    // The one that matters most: a closed venue must not be able to take another payment.
    const payment = await request(app.getHttpServer())
      .post("/api/v1/payments")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ restaurantId, amount: 1000, tipAmount: 0 });
    expect(payment.status, JSON.stringify(payment.body)).toBe(404);
  });

  // ─── 2. Reporting routes: the money stays ───────────────────────────────────────────────────

  it("keeps its settled payment visible on the reporting routes — the half that stops this suite proving the wrong thing", async () => {
    // Without this case, every assertion above would pass against an implementation that deleted
    // the venue and its financial history outright. That outcome is forbidden by the ten-year
    // accounting floor (PERSONAL_DATA_MAP.md §6), and a payment taken before closure still
    // happened.
    const payments = await request(app.getHttpServer())
      .get("/api/v1/payments")
      .set("Authorization", `Bearer ${token}`);
    expect(payments.status).toBe(200);
    expect(
      (payments.body.data.data as Array<{ restaurantId: string }>).some(
        (p) => p.restaurantId === restaurantId,
      ),
      "a closed venue's payments vanished from the payment list",
    ).toBe(true);

    const transactions = await request(app.getHttpServer())
      .get("/api/v1/transactions")
      .set("Authorization", `Bearer ${token}`);
    expect(transactions.status).toBe(200);
    expect(
      (transactions.body.data.data as Array<{ restaurantId: string }>).some(
        (t) => t.restaurantId === restaurantId,
      ),
      "a closed venue's transactions vanished from the transaction list",
    ).toBe(true);
  });

  // ─── 3. Webhooks after closure ──────────────────────────────────────────────────────────────

  it("still processes a webhook that arrives after closing, and the money reaches the Ledger", async () => {
    // The capture that was in flight when the owner clicked close. Nothing about a route table
    // answers this — the webhook path never reads Restaurant through a gate at all, and only an
    // execution shows whether the Ledger write still happens.
    //
    // Refusing it would strand money: Stripe would hold a settled charge that our books never
    // record, and PaymentReconciliationService compares exactly those two.
    const before = await ledgerLineCount();

    expect(await deliverSucceeded(inFlightPaymentIntentId)).toBe(200);

    const after = await ledgerLineCount();
    expect(after, "the post-closure webhook wrote nothing to the Ledger").toBeGreaterThan(before);

    const payment = await prisma.payment.findFirstOrThrow({
      where: { processorPaymentId: inFlightPaymentIntentId },
    });
    expect(payment.status).toBe("SUCCEEDED");
  });
});
