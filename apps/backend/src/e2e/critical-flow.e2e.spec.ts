import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Stripe from "stripe";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { OutboxPollerService } from "../outbox/outbox-poller.service";
import { PrismaService } from "../prisma/prisma.service";
import type {
  ConnectAccountStatus,
  CreateConnectAccountParams,
  CreatedPaymentIntent,
  CreatePaymentIntentParams,
} from "../stripe/stripe.service";
import { StripeService } from "../stripe/stripe.service";

const WEBHOOK_SECRET = "whsec_e2e_test_secret";

/** Stands in for the real StripeService at exactly the network boundary — every other real
 * Controller/Guard/Service/Prisma/Ledger/Outbox class in the app runs unmodified, driven by real
 * HTTP requests through the actual AppModule. Only the literal outbound call to Stripe's API is
 * replaced — the same boundary every other spec file in this codebase already stubs (no test
 * anywhere makes a live Stripe network call). `constructWebhookEvent` is real local HMAC
 * verification (no network), so the webhook step still proves real signature verification. */
class FakeStripeService {
  private readonly stripe = new Stripe("sk_test_e2e_never_calls_network");

  async createConnectAccount(_params: CreateConnectAccountParams): Promise<string> {
    return `acct_e2e_${randomUUID()}`;
  }

  async createOnboardingLink(): Promise<string> {
    return "https://example.com/onboarding";
  }

  async getAccountStatus(): Promise<ConnectAccountStatus> {
    return { cardPaymentsStatus: "active", payoutsStatus: "active", requirementsDue: null };
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<CreatedPaymentIntent> {
    return {
      id: `pi_e2e_${randomUUID()}`,
      clientSecret: `pi_e2e_secret_${randomUUID()}`,
      amount: Number(params.amount),
      currency: params.currency.toLowerCase(),
    };
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  }
}

// Returns the raw JSON *string*, not a Buffer — supertest/superagent, given an explicit
// `Content-Type: application/json` and a Buffer body, re-serializes it via JSON.stringify (which
// turns a Buffer into `{"type":"Buffer","data":[...]}`), silently breaking byte-for-byte equality
// with whatever was actually HMAC-signed below. A string body under a json Content-Type is instead
// sent verbatim by superagent — the reliable way to drive a raw-body-verified webhook through a
// real HTTP client in a test, found by hitting exactly this mismatch.
function signEvent(payload: object): { rawBody: string; signature: string } {
  const raw = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET });
  return { rawBody: raw, signature: header };
}

function buildEvent(type: string, dataObject: Record<string, unknown>) {
  return {
    id: `evt_e2e_${randomUUID()}`,
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

// IMPLEMENTATION_PLAN.md, Sprint 12: "End-to-end critical-flow tests (register → create
// restaurant → invite staff → pay → tip → wallet updates → dashboard)." Driven entirely through
// real HTTP against the real, fully-booted AppModule — real JwtAuthGuard/PermissionsGuard/
// ThrottlerGuard, real Prisma writes, real LedgerService, real Outbox, real WalletProjection, real
// AuditLog — the first test in this codebase to exercise that full real pipeline end to end
// instead of hand-building an AuthenticatedUser or calling a service method directly (every
// existing *.service.spec.ts does the latter). Only StripeService's own network boundary is
// stubbed (FakeStripeService above), same boundary every other test in this codebase already
// stubs — no frontend UI exists yet for any of these screens (apps/frontend/src has only the
// Next.js scaffold), so "end-to-end" here means the full real backend HTTP surface, not a browser.
//
// "Invite staff" invites a Manager, not a Waiter: PaymentService.createPaymentIntent attributes
// the tip to whichever Membership held by the CALLER actually grants `payments.manage` — under
// today's real seed data (prisma/seed.ts) a plain Waiter holds zero Permissions and cannot legally
// call POST /payments at all. A Manager is the only staff role that can realistically both be
// invited and capture their own payment through the real, permission-checked HTTP path. Found by
// building this test against the real permission system for the first time, not assumed — worth
// recording here rather than silently working around it.
describe("Critical flow (E2E, real HTTP, real database)", () => {
  const prisma = new PrismaService();
  let app: INestApplication;

  beforeAll(async () => {
    await prisma.$connect();

    // register()/accept() both call isPasswordBreached() (ADR-032) — this test's own fixture
    // passwords are XKCD's famous example phrase, plausibly present in a real breach corpus, and
    // no test in this codebase makes a live network call regardless (same precedent as
    // FakeStripeService). supertest talks to the in-process server directly via Node's http
    // module, never through global fetch, so this doesn't interfere with the real HTTP requests
    // this test makes.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") }),
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService)
      .useValue(new FakeStripeService())
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    // Mirrors main.ts's own bootstrap exactly (minus helmet/CORS, which supertest never exercises
    // — it talks to the in-process HTTP server directly, no browser, no real network hop).
    app.setGlobalPrefix("api/v1", { exclude: ["health", "webhooks/stripe"] });
    await app.init();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
    await prisma.$disconnect();
  });

  it("register -> create restaurant -> invite staff -> pay -> tip -> wallet updates -> dashboard", async () => {
    const ownerEmail = `owner-e2e-${randomUUID()}@example.com`;
    const ownerPassword = "correct horse battery staple";

    // 1. Register
    const registerRes = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        email: ownerEmail,
        password: ownerPassword,
        displayName: "Test Owner",
        locale: "en",
      });
    expect(registerRes.status).toBe(201);
    expect(registerRes.body.data.accessToken).toBeTruthy();

    // 2. Login (real bcrypt hash written by register, real bcrypt verify here)
    const loginRes = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: ownerEmail, password: ownerPassword });
    expect(loginRes.status).toBe(200);
    const ownerAccessToken: string = loginRes.body.data.accessToken;

    // 3. Create Restaurant — auto-creates Organization + org-wide Owner Membership
    // (restaurant.controller.ts's own documented behavior); real Stripe Connect account
    // creation is stubbed by FakeStripeService.
    const restaurantRes = await request(app.getHttpServer())
      .post("/api/v1/restaurants")
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .send({
        name: "E2E Test Restaurant",
        legalName: "E2E Test Restaurant UAB",
        companyNumber: `E2E-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-e2e-${randomUUID()}@example.com`,
        phone: "+37060000099",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address 1",
      });
    expect(restaurantRes.status).toBe(201);
    const restaurantId: string = restaurantRes.body.data.id;
    expect(restaurantId).toBeTruthy();

    // 4. Invite a Manager (see file doc comment: the only staff role that can itself hold
    // payments.manage under today's real seed data)
    const managerRole = await prisma.role.findUniqueOrThrow({ where: { name: "Manager" } });
    const managerEmail = `manager-e2e-${randomUUID()}@example.com`;
    const managerPassword = "another correct horse battery staple";

    const inviteRes = await request(app.getHttpServer())
      .post("/api/v1/memberships")
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .send({ email: managerEmail, restaurantId, roleId: managerRole.id });
    expect(inviteRes.status).toBe(201);
    const invitationToken: string = inviteRes.body.data.token;
    expect(invitationToken).toBeTruthy();

    // 5. Manager accepts the invitation (creates User + password + Membership)
    const acceptRes = await request(app.getHttpServer())
      .post("/api/v1/memberships/invitations/accept")
      .send({
        email: managerEmail,
        token: invitationToken,
        password: managerPassword,
        displayName: "Test Manager",
      });
    expect(acceptRes.status).toBe(200);
    const managerMembershipId: string = acceptRes.body.data.id;
    expect(managerMembershipId).toBeTruthy();

    // 6. Manager logs in
    const managerLoginRes = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: managerEmail, password: managerPassword });
    expect(managerLoginRes.status).toBe(200);
    const managerAccessToken: string = managerLoginRes.body.data.accessToken;

    // 7. Manager captures a payment with a tip — real permission check (payments.manage), real
    // billAmount/fee split, real Payment row write; only the outbound Stripe PaymentIntent
    // creation is stubbed. waiterMembershipId (ADR-033): the Manager selects THEMSELVES via the
    // terminal's own staff picker (a real, legitimate case now that selection isn't restricted to
    // any one Role) — this flow tests end-to-end payment/tip/wallet plumbing, not the picker's own
    // selection logic (membership.service.spec.ts covers that).
    const paymentRes = await request(app.getHttpServer())
      .post("/api/v1/payments")
      .set("Authorization", `Bearer ${managerAccessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        restaurantId,
        amount: 2000,
        tipAmount: 500,
        waiterMembershipId: managerMembershipId,
      }); // billAmount=1500, tip=500
    expect(paymentRes.status).toBe(201);
    const paymentId: string = paymentRes.body.data.id;
    expect(paymentId).toBeTruthy();

    const paymentRow = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    // 8. The real webhook endpoint — real signature verification, real LedgerService posting,
    // real Outbox write.
    const { rawBody, signature } = signEvent(
      buildEvent("payment_intent.succeeded", {
        id: paymentRow.processorPaymentId,
        amount: 2000,
        currency: "eur",
      }),
    );
    const webhookRes = await request(app.getHttpServer())
      .post("/webhooks/stripe")
      .set("stripe-signature", signature)
      .set("Content-Type", "application/json")
      .send(rawBody);
    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.data).toEqual({ received: true });

    // Outbox dispatch (WalletProjectionService's own consumer) runs on its own @Interval poll,
    // not synchronously with the webhook response (ADR-024) — poll it directly here rather than
    // sleeping a guessed duration, matching this codebase's own "explicit over implicit" style.
    //
    // A single poll() call is not enough to rely on: poll() dispatches up to BATCH_SIZE (50)
    // unpublished OutboxEvent rows across the WHOLE shared test database, oldest-createdAt-first —
    // not just this test's own. Found live in CI (not locally — CI's own concurrency/timing made
    // this event miss the first batch two runs in a row), the same "bounded catch-up, not a bare
    // single poll() call" reasoning outbox-poller.service.spec.ts's own pollUntilSettled already
    // documents for exactly this shared-database contention. Scoped to this payment's own
    // JournalEntry-derived OutboxEvent rows specifically, not a blind retry count.
    const outboxPoller = app.get(OutboxPollerService);
    const transactionForPayment = await prisma.transaction.findFirstOrThrow({
      where: { paymentId: paymentId },
    });
    const journalEntriesForPayment = await prisma.journalEntry.findMany({
      where: { transactionId: transactionForPayment.id },
    });
    const outboxEventIds = journalEntriesForPayment.map((e) => e.id);
    for (let i = 0; i < 20; i++) {
      const remaining = await prisma.outboxEvent.count({
        where: { aggregateId: { in: outboxEventIds }, publishedAt: null },
      });
      if (remaining === 0) break;
      await outboxPoller.poll();
    }

    // 9. Manager's own Wallet reflects the tip
    const walletRes = await request(app.getHttpServer())
      .get("/api/v1/wallets")
      .set("Authorization", `Bearer ${managerAccessToken}`);
    expect(walletRes.status).toBe(200);
    const wallets = walletRes.body.data as Array<{ availableBalance: string }>;
    expect(wallets).toHaveLength(1);
    expect(wallets[0].availableBalance).toBe("500");

    // 10. Owner's Dashboard reflects today's revenue and the Manager's tip
    const dashboardRes = await request(app.getHttpServer())
      .get(`/api/v1/dashboard?restaurantId=${restaurantId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`);
    expect(dashboardRes.status).toBe(200);
    const dashboard = dashboardRes.body.data;
    expect(dashboard.todayRevenue).toBe("1500"); // billAmount = amount(2000) - tipAmount(500)
    expect(dashboard.todayTips).toBe("500");
  }, 20_000);
});
