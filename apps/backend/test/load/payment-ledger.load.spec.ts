import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module";
import { hashPassword } from "../../src/auth/password.util";
import { OutboxPollerService } from "../../src/outbox/outbox-poller.service";
import { PrismaService } from "../../src/prisma/prisma.service";
import type {
  ConnectAccountStatus,
  CreateConnectAccountParams,
  CreatedPaymentIntent,
  CreatePaymentIntentParams,
} from "../../src/stripe/stripe.service";
import { StripeService } from "../../src/stripe/stripe.service";

// IMPLEMENTATION_PLAN.md, Sprint 12: "Load testing on the Payment/Ledger path." Lives under
// test/, not src/ — vitest.config.ts's own `include: ["src/**/*.spec.ts"]` never picks this file
// up on a routine `pnpm test`; it only runs when named explicitly (`pnpm run test:load`, its own
// dedicated vitest.load.config.ts — see that file's own comment for why a second config exists at
// all: a standalone `tsx` script hit a real esbuild/decorator-metadata gap on the very first run).
//
// Three independent `describe` blocks, each booting its OWN app instance, not one shared app: Sprint
// 11 (ADR-028) put a real 20/min @Throttle on POST /payments specifically to make it an expensive
// abuse target — correct, intentional, and a real ceiling this load test must respect rather than
// route around. `ThrottlerGuard`'s in-memory counter lives on each app instance, so a fresh app
// means a fresh budget; sharing one app across all three phases would make later phases fail on
// 429s caused by an earlier phase's own traffic, not a Ledger correctness problem — found exactly
// this way on the first run of this file, not assumed in advance.
const WEBHOOK_SECRET = "whsec_load_test_secret";

class FakeStripeService {
  private readonly stripe = new Stripe("sk_test_load_never_calls_network");

  async createConnectAccount(_params: CreateConnectAccountParams): Promise<string> {
    return `acct_load_${randomUUID()}`;
  }

  async createOnboardingLink(): Promise<string> {
    return "https://example.com/onboarding";
  }

  async getAccountStatus(): Promise<ConnectAccountStatus> {
    return { cardPaymentsStatus: "active", payoutsStatus: "active", requirementsDue: null };
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<CreatedPaymentIntent> {
    return {
      id: `pi_load_${randomUUID()}`,
      clientSecret: `pi_load_secret_${randomUUID()}`,
      amount: Number(params.amount),
      currency: params.currency.toLowerCase(),
    };
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  }
}

function signEvent(payload: object): { rawBody: string; signature: string } {
  const raw = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET });
  return { rawBody: raw, signature: header };
}

function buildEvent(type: string, dataObject: Record<string, unknown>) {
  return {
    id: `evt_load_${randomUUID()}`,
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

const LOAD_TEST_TIMEOUT_MS = 60_000;
// Sprint 11 (ADR-028): POST /payments is @Throttle-d to 20/min per caller. Every phase below
// stays strictly under that, on its own freshly-booted app, so this file measures Payment/Ledger
// behavior under concurrency — not a re-test of the throttle itself (payment-throttle.integration.
// spec.ts already covers that).
const PAYMENTS_THROTTLE_LIMIT = 20;

interface LoadTestContext {
  prisma: PrismaService;
  app: INestApplication;
  url: string;
  restaurantId: string;
  accessToken: string;
  // ADR-033: every request below that carries a tip must submit this as waiterMembershipId —
  // no longer derived from the caller automatically.
  membershipId: string;
}

async function bootLoadTestApp(label: string): Promise<LoadTestContext> {
  const prisma = new PrismaService();
  await prisma.$connect();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(StripeService)
    .useValue(new FakeStripeService())
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix("api/v1", { exclude: ["health", "webhooks/stripe"] });
  await app.init();
  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();

  const org = await prisma.organization.create({ data: { name: `Load Test Org (${label})` } });
  const restaurant = await prisma.restaurant.create({
    data: {
      organizationId: org.id,
      name: `Load Test Restaurant (${label})`,
      legalName: "Load Test Restaurant UAB",
      companyNumber: `LOAD-${randomUUID()}`,
      vatNumber: `LT${randomUUID()}`,
      email: `restaurant-load-${randomUUID()}@example.com`,
      phone: "+37060000098",
      country: "LT",
      currency: "EUR",
      defaultCustomerLocale: "en",
      timezone: "Europe/Vilnius",
      address: "Load test address",
      stripeAccountId: `acct_load_${randomUUID()}`,
    },
  });

  const managerRole = await prisma.role.findUniqueOrThrow({ where: { name: "Manager" } });
  const email = `manager-load-${randomUUID()}@example.com`;
  const password = "load test password 123";
  const user = await prisma.user.create({
    data: {
      email,
      displayName: "Load Test Manager",
      passwordHash: await hashPassword(password),
      locale: "en",
    },
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: org.id,
      restaurantId: restaurant.id,
      roleId: managerRole.id,
      status: "ACTIVE",
    },
  });

  const loginRes = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = (await loginRes.json()) as { data: { accessToken: string } };

  return {
    prisma,
    app,
    url,
    restaurantId: restaurant.id,
    accessToken: loginBody.data.accessToken,
    membershipId: membership.id,
  };
}

async function teardown(ctx: LoadTestContext): Promise<void> {
  await ctx.app.close();
  await ctx.prisma.$disconnect();
}

describe("Payment/Ledger load test: concurrent distinct payments + Ledger reconciliation", () => {
  let ctx: LoadTestContext;
  const CONCURRENT_DISTINCT_PAYMENTS = PAYMENTS_THROTTLE_LIMIT - 5; // 15 — comfortable headroom

  beforeAll(async () => {
    ctx = await bootLoadTestApp("phase1");
  }, LOAD_TEST_TIMEOUT_MS);

  afterAll(async () => teardown(ctx));

  it(
    `${CONCURRENT_DISTINCT_PAYMENTS} concurrent distinct payments all succeed and the Ledger reconciles exactly`,
    async () => {
      const { url, restaurantId, accessToken, membershipId } = ctx;
      const paymentAmount = 2000;
      const tipAmount = 500;

      const results = await Promise.all(
        Array.from({ length: CONCURRENT_DISTINCT_PAYMENTS }, () =>
          fetch(`${url}/api/v1/payments`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
              "Idempotency-Key": randomUUID(),
            },
            body: JSON.stringify({
              restaurantId,
              amount: paymentAmount,
              tipAmount,
              waiterMembershipId: membershipId,
            }),
          }).then(async (r) => ({
            status: r.status,
            body: (await r.json()) as { data: { id: string } },
          })),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);

      const paymentIds = results.map((r) => r.body.data.id);
      const paymentRows = await ctx.prisma.payment.findMany({ where: { id: { in: paymentIds } } });
      expect(paymentRows).toHaveLength(CONCURRENT_DISTINCT_PAYMENTS);

      console.log(`\n=== ${paymentRows.length} concurrent webhook captures ===`);
      const webhookStatuses = await Promise.all(
        paymentRows.map((p) => {
          const { rawBody, signature } = signEvent(
            buildEvent("payment_intent.succeeded", {
              id: p.processorPaymentId,
              amount: Number(p.amount),
              currency: "eur",
            }),
          );
          return fetch(`${url}/webhooks/stripe`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "stripe-signature": signature },
            body: rawBody,
          }).then((r) => r.status);
        }),
      );
      expect(webhookStatuses.every((s) => s === 200)).toBe(true);

      const poller = ctx.app.get(OutboxPollerService);
      for (let i = 0; i < 5; i++) await poller.poll();

      console.log("=== Ledger reconciliation (MASTERPLAN.md's own MVP checklist item) ===");
      const grouped = await ctx.prisma.ledgerLine.groupBy({
        by: ["account", "direction"],
        where: { restaurantId },
        _sum: { amount: true },
      });
      const net = (account: string): bigint => {
        const credit =
          grouped.find((g) => g.account === account && g.direction === "CREDIT")?._sum.amount ?? 0n;
        const debit =
          grouped.find((g) => g.account === account && g.direction === "DEBIT")?._sum.amount ?? 0n;
        return credit - debit;
      };
      const billAmount = BigInt(paymentAmount - tipAmount);
      const n = BigInt(CONCURRENT_DISTINCT_PAYMENTS);
      const expectedRevenue = billAmount * n;
      const expectedTips = BigInt(tipAmount) * n;
      const actualRevenue = net("RESTAURANT_REVENUE_PAYABLE") + net("PLATFORM_FEE_REVENUE");
      const actualTips = net("TIP_PAYABLE");
      console.log(`  revenue: expected ${expectedRevenue}, actual ${actualRevenue}`);
      console.log(`  tips:    expected ${expectedTips}, actual ${actualTips}`);
      expect(actualRevenue).toBe(expectedRevenue);
      expect(actualTips).toBe(expectedTips);
    },
    LOAD_TEST_TIMEOUT_MS,
  );
});

describe("Payment/Ledger load test: identical Idempotency-Key race", () => {
  let ctx: LoadTestContext;
  const CONCURRENT_IDENTICAL_KEY_REQUESTS = PAYMENTS_THROTTLE_LIMIT - 5; // 15, own fresh app/budget

  beforeAll(async () => {
    ctx = await bootLoadTestApp("phase2");
  }, LOAD_TEST_TIMEOUT_MS);

  afterAll(async () => teardown(ctx));

  it(
    `${CONCURRENT_IDENTICAL_KEY_REQUESTS} truly concurrent requests with the SAME Idempotency-Key never produce more than one Payment row`,
    async () => {
      // IdempotencyInterceptor does findUnique-then-create — a check-then-act, not one atomic
      // upsert — so genuinely simultaneous requests are a real race window: more than one can see
      // "no existing key" before either has written its own row. The database's own unique
      // constraint on IdempotencyKey.key is the actual backstop, not application code. This test
      // observes what that race really produces (some mix of one 201 and N-1 rejections — 409 or
      // a raw 500 from the losing create()'s constraint violation), honestly, rather than
      // asserting a specific status-code split it hasn't verified.
      const { url, restaurantId, accessToken } = ctx;
      const raceKey = randomUUID();
      const statuses = await Promise.all(
        Array.from({ length: CONCURRENT_IDENTICAL_KEY_REQUESTS }, () =>
          fetch(`${url}/api/v1/payments`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
              "Idempotency-Key": raceKey,
            },
            body: JSON.stringify({ restaurantId, amount: 999, tipAmount: 0 }),
          }).then((r) => r.status),
        ),
      );
      const distribution = statuses.reduce<Record<number, number>>((acc, s) => {
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        `\n=== Identical-key race status distribution: ${JSON.stringify(distribution)} ===`,
      );

      const raceRows = await ctx.prisma.payment.count({
        where: { restaurantId, idempotencyKey: raceKey },
      });
      expect(raceRows).toBe(1); // the invariant that actually matters: never more than one
    },
    LOAD_TEST_TIMEOUT_MS,
  );
});

describe("Payment/Ledger load test: throughput within the real, intentional rate limit", () => {
  let ctx: LoadTestContext;
  // Not duration-bounded: unbounded concurrency would blow past 20/min in well under a second —
  // bounding the total request count instead measures real latency for a legitimate-sized burst
  // without tripping the anti-abuse throttle that same burst is designed to survive (ADR-028:
  // "still comfortably covers a single busy terminal's real traffic").
  const REQUEST_AMOUNT = PAYMENTS_THROTTLE_LIMIT - 2; // 18

  beforeAll(async () => {
    ctx = await bootLoadTestApp("phase3");
  }, LOAD_TEST_TIMEOUT_MS);

  afterAll(async () => teardown(ctx));

  it(
    `${REQUEST_AMOUNT} real distinct payment creations fired concurrently, all within the real 20/min limit`,
    async () => {
      // autocannon (installed as a devDependency, kept available for manual exploration) was
      // tried here first — its `setupRequest` did not reliably carry the top-level `headers`
      // forward in this version despite its own doc comment implying it would, silently dropping
      // Content-Type/Authorization and producing a 400 with no useful diagnostic surfaced back to
      // this test. A direct `fetch()` with the exact same headers/body succeeded immediately
      // (201), isolating the problem to autocannon's own request construction, not this
      // application. Rather than keep debugging a third-party library's internals for a
      // throughput number, this reuses the exact `Promise.all` + `fetch` pattern the first
      // describe block above already proved correct, and reports real measured latency itself.
      const { url, restaurantId, accessToken, membershipId } = ctx;
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      };
      const body = JSON.stringify({
        restaurantId,
        amount: 1500,
        tipAmount: 200,
        waiterMembershipId: membershipId,
      });

      const timings: number[] = [];
      const started = performance.now();
      const results = await Promise.all(
        Array.from({ length: REQUEST_AMOUNT }, () => {
          const requestStarted = performance.now();
          return fetch(`${url}/api/v1/payments`, {
            method: "POST",
            headers: { ...headers, "Idempotency-Key": randomUUID() },
            body,
          }).then((r) => {
            timings.push(performance.now() - requestStarted);
            return r.status;
          });
        }),
      );
      const elapsedMs = performance.now() - started;
      timings.sort((a, b) => a - b);
      const avg = timings.reduce((sum, t) => sum + t, 0) / timings.length;
      const p99 = timings[Math.floor(timings.length * 0.99)];

      console.log(`\n=== Throughput result (${REQUEST_AMOUNT} concurrent requests) ===`);
      console.log(`  wall-clock time: ${elapsedMs.toFixed(1)}ms`);
      console.log(`  latency avg/p99: ${avg.toFixed(1)}ms / ${p99.toFixed(1)}ms`);
      console.log(`  effective req/s: ${(REQUEST_AMOUNT / (elapsedMs / 1000)).toFixed(1)}`);

      expect(results.every((s) => s === 201)).toBe(true);
    },
    LOAD_TEST_TIMEOUT_MS,
  );
});
