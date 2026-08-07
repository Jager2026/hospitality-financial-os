import { randomUUID } from "node:crypto";
import type { ExecutionContext, INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { computeFingerprint } from "../common/idempotency/fingerprint.util";
import { IdempotencyInterceptor } from "../common/idempotency/idempotency.interceptor";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";

// Founder review (post-Sprint-5 coverage audit): StripeService.createPaymentIntent had 0% direct
// coverage — every existing test faked StripeService itself, so its own body (BigInt->Number
// conversion, direct-charge stripeAccount param, application_fee_amount wiring, client_secret
// extraction) had never actually executed under test, only under my own manual curl checks this
// session. This file fakes the Stripe SDK's own constructor instead (vi.mock("stripe")), so the
// REAL PaymentController -> REAL PaymentService -> REAL StripeService all run for real; only the
// network-calling stripe.paymentIntents.create() itself is faked. Also closes
// IdempotencyInterceptor's two previously-uncovered branches (IN_PROGRESS/FAILED conflict
// rejection, and the real transition to FAILED on a genuinely erroring request) and
// PaymentController's own 0% coverage (route wiring, guards, interceptor all real).
const stripeMocks = vi.hoisted(() => ({
  paymentIntentsCreate: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    paymentIntents: { create: stripeMocks.paymentIntentsCreate },
    v2: { core: { accounts: { create: vi.fn(), retrieve: vi.fn() } } },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  })),
}));

describe("PaymentController (real controller, real PaymentService, real StripeService — Stripe SDK faked at its own boundary)", () => {
  const prisma = new PrismaService();
  let app: INestApplication;
  let currentUser: AuthenticatedUser;

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.currency.upsert({
      where: { code: "EUR" },
      update: {},
      create: { code: "EUR", exponent: 2, name: "Euro" },
    });

    const fakeConfig = {
      getOrThrow: (key: string) => {
        if (key === "STRIPE_SECRET_KEY") return "sk_test_fake_never_really_called";
        if (key === "STRIPE_WEBHOOK_SECRET") return "whsec_fake_never_really_called";
        if (key === "DEFAULT_PLATFORM_FEE_BASIS_POINTS") return 100; // 1.00%, matches ADR-021
        throw new Error(`unexpected config key in test: ${key}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        PaymentService,
        StripeService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: fakeConfig },
        IdempotencyInterceptor,
        PermissionsGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest();
          req.user = currentUser;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => {
    stripeMocks.paymentIntentsCreate.mockReset();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function seedRestaurant() {
    const org = await prisma.organization.create({ data: { name: "Payment Controller Test Org" } });
    return prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Payment Controller Test Restaurant",
        legalName: "Payment Controller Test Restaurant UAB",
        companyNumber: `PCT-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `${randomUUID()}@example.com`,
        phone: "+37060000000",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
        stripeAccountId: `acct_fake_${randomUUID()}`,
      },
    });
  }

  function ownerUserFor(restaurant: { organizationId: string }): AuthenticatedUser {
    return {
      id: randomUUID(),
      email: "owner@example.com",
      locale: "en",
      memberships: [
        {
          id: "irrelevant",
          organizationId: restaurant.organizationId,
          restaurantId: null, // org-wide — reaches the restaurant per ADR-005
          role: { id: "irrelevant", name: "Owner", permissions: ["payments.manage"] },
        },
      ],
    };
  }

  it("POST /payments: the real StripeService.createPaymentIntent runs for real — BigInt->Number conversion, direct-charge stripeAccount param, and application_fee_amount are all correctly wired against the faked SDK", async () => {
    const restaurant = await seedRestaurant();
    currentUser = ownerUserFor(restaurant);

    stripeMocks.paymentIntentsCreate.mockResolvedValueOnce({
      id: "pi_fake_test",
      client_secret: "pi_fake_test_secret_abc",
      amount: 1550,
      currency: "eur",
    });

    const res = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", `key-${randomUUID()}`)
      .send({ restaurantId: restaurant.id, amount: 1550 });

    expect(res.status).toBe(201);
    expect(res.body.clientSecret).toBe("pi_fake_test_secret_abc");
    expect(res.body.amount).toBe("1550");

    // The exact params StripeService's own body constructs — proves it's not the fake running,
    // it's the real conversion/wiring logic, verified against what actually reached the SDK.
    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalledWith(
      {
        amount: 1550, // a plain Number, not a bigint — proves Number(params.amount) really ran
        currency: "eur",
        application_fee_amount: 15, // 1% of 1550 via the real splitPlatformFee() call
      },
      { stripeAccount: restaurant.stripeAccountId },
    );

    const stored = await prisma.payment.findFirst({ where: { restaurantId: restaurant.id } });
    expect(stored?.amount).toBe(1550n);
    expect(stored?.status).toBe("PENDING");
  });

  it("POST /payments: a concurrent duplicate (same Idempotency-Key, still IN_PROGRESS) is rejected with 409 and never reaches Stripe", async () => {
    const restaurant = await seedRestaurant();
    currentUser = ownerUserFor(restaurant);
    const key = `key-${randomUUID()}`;
    const body = { restaurantId: restaurant.id, amount: 1000 };

    // Pre-seeded directly (not via a real concurrent request) so the test deterministically hits
    // the IN_PROGRESS branch specifically, not a fingerprint-mismatch — same fingerprint as the
    // body actually sent below, computed the identical way the interceptor computes it.
    await prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope: "/payments",
        requestFingerprint: computeFingerprint(body),
        status: "IN_PROGRESS",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", key)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(res.body.message).toMatch(/already being processed/i);
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("POST /payments: reusing a key whose prior attempt already FAILED is rejected with a retry-with-new-key message", async () => {
    const restaurant = await seedRestaurant();
    currentUser = ownerUserFor(restaurant);
    const key = `key-${randomUUID()}`;
    const body = { restaurantId: restaurant.id, amount: 1000 };

    await prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope: "/payments",
        requestFingerprint: computeFingerprint(body),
        status: "FAILED",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", key)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/previous request.*failed/i);
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("POST /payments: a genuinely failing Stripe call transitions the Idempotency-Key to FAILED for real, not left stuck IN_PROGRESS", async () => {
    const restaurant = await seedRestaurant();
    currentUser = ownerUserFor(restaurant);
    const key = `key-${randomUUID()}`;

    stripeMocks.paymentIntentsCreate.mockRejectedValueOnce(new Error("simulated Stripe outage"));

    const res = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", key)
      .send({ restaurantId: restaurant.id, amount: 1000 });

    expect(res.status).toBe(500);

    const stored = await prisma.idempotencyKey.findUnique({ where: { key } });
    expect(stored?.status).toBe("FAILED");
    // Not left in a state a retry-with-a-new-key can't distinguish from "the response snapshot
    // just hasn't been written yet" — a naive implementation that never awaited the FAILED write
    // (the exact race this session's own IdempotencyInterceptor fix addressed) would leave this
    // row IN_PROGRESS at this assertion point instead.
  });

  it("POST /payments: missing Idempotency-Key header is rejected with 400 before ever reaching the handler", async () => {
    const restaurant = await seedRestaurant();
    currentUser = ownerUserFor(restaurant);

    const res = await request(app.getHttpServer())
      .post("/payments")
      .send({ restaurantId: restaurant.id, amount: 1000 }); // no Idempotency-Key header set

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });
});
