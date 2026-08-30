import { randomUUID } from "node:crypto";
import type { ExecutionContext, INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { computeFingerprint } from "../common/idempotency/fingerprint.util";
import { IdempotencyInterceptor } from "../common/idempotency/idempotency.interceptor";
import { AlertService } from "../common/alerting/alert.service";
import { AuditLogInterceptor } from "../common/interceptors/audit-log.interceptor";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import { seededRole } from "../../test/fixtures/authenticated-user";

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

    const fakeConfig = {
      getOrThrow: (key: string) => {
        if (key === "STRIPE_SECRET_KEY") return "sk_test_fake_never_really_called";
        if (key === "STRIPE_WEBHOOK_SECRET") return "whsec_fake_never_really_called";
        if (key === "DEFAULT_PLATFORM_FEE_BASIS_POINTS") return 100; // 1.00%, matches ADR-021
        // ADR-038: StripeService reads NODE_ENV to decide whether to run its boot-time credential
        // probe. "test" keeps it off, so no network call is ever attempted from this suite.
        if (key === "NODE_ENV") return "test";
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
        // ADR-033: real AuditLogInterceptor, real database — proves the dual-identity write
        // (userId + metadata.waiterMembershipId) against the actual global interceptor, not a
        // synthetic stand-in.
        {
          provide: PinoLogger,
          useValue: {
            setContext: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            error: () => undefined,
          } as unknown as PinoLogger,
        },
        // ADR-038: StripeService now depends on AlertService for its boot-time credential probe.
        // Without this the module fails to resolve at runtime — the exact failure shape CLAUDE.md's
        // Architecture Review paragraph describes, which typechecks cleanly and only surfaces when
        // Nest actually builds the graph. The probe itself never runs here (NODE_ENV is not
        // "production"), so this stub only needs to exist.
        {
          provide: AlertService,
          useValue: { sendAlert: async () => undefined } as unknown as AlertService,
        },
        { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
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

  // Sprint 6 (ADR-022), revised Sprint 13 (ADR-033): Payment.waiterMembershipId is a real FK,
  // required whenever tipAmount > 0 — the caller's own Membership is used below purely as a
  // convenient, always-valid id to submit as waiterMembershipId (any reachable Membership works,
  // no Role restriction), not because it's still derived from the caller automatically. A real
  // User + Membership row is required regardless; the Role FK reuses the "Manager" role Vitest's
  // own globalSetup already seeds (test/global-setup.ts) rather than creating a redundant one. The
  // permissions PaymentService's own in-process check reads come from the AuthenticatedUser object
  // below, not from this Membership row's real RolePermission grants — JwtAuthGuard is fully
  // overridden in this test file, so the two are independent by design.
  async function ownerUserFor(restaurant: { organizationId: string }): Promise<AuthenticatedUser> {
    // Seeded Manager, WITH its Permissions — the fixture below needs them, and a plain Role row
    // has none. Previously the spec hand-wrote the two it cared about.
    const managerRole = await seededRole(prisma, "Manager");
    const user = await prisma.user.create({
      data: {
        email: `owner-${randomUUID()}@example.com`,
        displayName: "Test Owner",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: restaurant.organizationId,
        restaurantId: null, // org-wide — reaches the restaurant per ADR-005
        roleId: managerRole.id,
      },
    });

    return {
      id: user.id,
      email: user.email,
      locale: user.locale,
      memberships: [
        {
          id: membership.id,
          organizationId: restaurant.organizationId,
          restaurantId: null,
          // ADR-043: this fixture fetched the Manager role but labelled it "Owner" and gave it
          // one permission — matching neither real Role. A hand-built AuthenticatedUser that
          // drifts from seed.ts proves things about a system that does not exist; the same drift
          // was already recorded once in seed.ts own comment. Corrected to the real Manager.
          // The real seeded Manager, which holds both of these and five more.
          role: managerRole,
        },
      ],
    };
  }

  it("POST /payments: the real StripeService.createPaymentIntent runs for real — BigInt->Number conversion, direct-charge stripeAccount param, and application_fee_amount are all correctly wired against the faked SDK", async () => {
    const restaurant = await seedRestaurant();
    currentUser = await ownerUserFor(restaurant);

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
    expect(stored?.tipAmount).toBe(0n);
    // ADR-033: no tip, no waiterMembershipId submitted -> null, not the caller's own Membership —
    // "who is logged in" and "who receives the tip" are independent facts now.
    expect(stored?.waiterMembershipId).toBeNull();
  });

  it("POST /payments: with a tip, the platform fee is computed from billAmount (amount - tipAmount), not the full amount (ADR-022) — discriminating: a naive amount-based implementation would compute 20, not 15", async () => {
    const restaurant = await seedRestaurant();
    currentUser = await ownerUserFor(restaurant);

    stripeMocks.paymentIntentsCreate.mockResolvedValueOnce({
      id: "pi_fake_tip_test",
      client_secret: "pi_fake_tip_secret",
      amount: 2000,
      currency: "eur",
    });

    // amount=2000 (bill+tip combined), tipAmount=500 -> billAmount=1500 -> fee = 1% of 1500 = 15.
    // A naive implementation computing the fee from the full amount (2000) would produce 20 —
    // the exact number this test's application_fee_amount assertion below would need to see for
    // that wrong implementation to pass, and does not.
    //
    // waiterMembershipId (ADR-033): reuses the caller's own Membership purely for minimal test
    // setup — this test's own focus is the fee split, not staff selection (that's
    // membership.service.spec.ts/payment.service.spec.ts's own dedicated coverage). A tip requires
    // SOME valid, reachable waiterMembershipId now; it no longer defaults to the caller silently.
    const res = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", `key-tip-${randomUUID()}`)
      .send({
        restaurantId: restaurant.id,
        amount: 2000,
        tipAmount: 500,
        waiterMembershipId: currentUser.memberships[0].id,
      });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe("2000");
    expect(res.body.tipAmount).toBe("500");

    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalledWith(
      {
        amount: 2000,
        currency: "eur",
        application_fee_amount: 15, // NOT 20 — see the discriminating comment above
      },
      { stripeAccount: restaurant.stripeAccountId },
    );

    const stored = await prisma.payment.findFirst({ where: { restaurantId: restaurant.id } });
    expect(stored?.amount).toBe(2000n);
    expect(stored?.tipAmount).toBe(500n);
    expect(stored?.waiterMembershipId).toBe(currentUser.memberships[0].id);
  });

  it("POST /payments: tipAmount exceeding amount is rejected with VALIDATION_ERROR before ever reaching Stripe", async () => {
    const restaurant = await seedRestaurant();
    currentUser = await ownerUserFor(restaurant);

    const res = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", `key-badtip-${randomUUID()}`)
      .send({ restaurantId: restaurant.id, amount: 1000, tipAmount: 1001 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("POST /payments: a concurrent duplicate (same Idempotency-Key, still IN_PROGRESS) is rejected with 409 and never reaches Stripe", async () => {
    const restaurant = await seedRestaurant();
    currentUser = await ownerUserFor(restaurant);
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
    currentUser = await ownerUserFor(restaurant);
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
    currentUser = await ownerUserFor(restaurant);
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
    currentUser = await ownerUserFor(restaurant);

    const res = await request(app.getHttpServer())
      .post("/payments")
      .send({ restaurantId: restaurant.id, amount: 1000 }); // no Idempotency-Key header set

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  // ADR-033: the Founder's own explicit requirement — AuditLog must record BOTH identities as
  // independent facts, not one. Discriminating: uses a SECOND, genuinely different staff member as
  // the selected recipient (not the caller's own Membership, as the fee-split test above reuses
  // for simplicity) — a naive implementation that logged req.user.id under both fields, or that
  // conflated "who called" with "who was selected," would still pass a test using the same person
  // for both; it cannot pass this one.
  it("POST /payments: AuditLog records the logged-in caller (userId) and the selected tip recipient (metadata.waiterMembershipId) as two independently correct, different values", async () => {
    const restaurant = await seedRestaurant();
    currentUser = await ownerUserFor(restaurant);

    const waiterRole = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
    const waiterUser = await prisma.user.create({
      data: {
        email: `waiter-${randomUUID()}@example.com`,
        displayName: "Test Waiter",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    const waiterMembership = await prisma.membership.create({
      data: {
        userId: waiterUser.id,
        organizationId: restaurant.organizationId,
        restaurantId: restaurant.id,
        roleId: waiterRole.id,
        status: "ACTIVE",
      },
    });

    stripeMocks.paymentIntentsCreate.mockResolvedValueOnce({
      id: "pi_fake_audit_test",
      client_secret: "pi_fake_audit_secret",
      amount: 1500,
      currency: "eur",
    });

    const res = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", `key-audit-${randomUUID()}`)
      .send({
        restaurantId: restaurant.id,
        amount: 1500,
        tipAmount: 300,
        waiterMembershipId: waiterMembership.id,
      });

    expect(res.status).toBe(201);

    const auditRow = await prisma.auditLog.findFirst({
      where: { entity: "Payment", entityId: res.body.id },
    });
    expect(auditRow).not.toBeNull();
    // Two different Memberships, both real, both correctly attributed — not the same value read
    // twice under two different names.
    expect(auditRow?.userId).toBe(currentUser.id);
    expect((auditRow?.metadata as { waiterMembershipId?: string } | null)?.waiterMembershipId).toBe(
      waiterMembership.id,
    );
    expect(auditRow?.userId).not.toBe(waiterMembership.id);
  });

  // Sprint 13 audit finding: validateWaiterMembershipOrThrow's own reject branch had zero coverage
  // anywhere in the suite — a naive implementation that dropped the `if (!membership)` check
  // entirely (or inverted it) would still pass every other test in this file, since they all submit
  // a genuinely valid waiterMembershipId. Discriminating: a random UUID that matches no real
  // Membership row at all, not merely one at the wrong Restaurant — proves the lookup's own
  // not-found case is actually reached and rejected, not just its reachability filter.
  it("POST /payments: a nonexistent waiterMembershipId is rejected with 400 VALIDATION_ERROR before Stripe is ever called, and no Payment row is created", async () => {
    const restaurant = await seedRestaurant();
    currentUser = await ownerUserFor(restaurant);

    const res = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", `key-invalid-waiter-${randomUUID()}`)
      .send({
        restaurantId: restaurant.id,
        amount: 1500,
        tipAmount: 300,
        waiterMembershipId: randomUUID(), // syntactically valid, matches no real Membership
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();

    const stored = await prisma.payment.findFirst({ where: { restaurantId: restaurant.id } });
    expect(stored).toBeNull();
  });

  // Sprint 13 audit finding: PaymentController's three read endpoints had zero coverage — every
  // existing test in this file exercises POST only. Reachability on a read path is exactly the bug
  // shape CLAUDE.md's Architecture Review paragraph calls out (RestaurantService.findAllForUser,
  // Sprint 4), so the discriminating case is a caller whose Membership is org-wide in a DIFFERENT
  // Organization: an implementation that accepted any org-wide Membership as proof of reach —
  // rather than comparing organizationId — would return the payment instead of 404ing.
  it("GET /payments/:id and /:id/status: a payment in another Organization is 404, not readable — discriminating against an org-wide Membership that reaches somewhere else", async () => {
    const restaurant = await seedRestaurant();
    currentUser = await ownerUserFor(restaurant);

    stripeMocks.paymentIntentsCreate.mockResolvedValueOnce({
      id: "pi_fake_read_test",
      client_secret: "pi_fake_read_secret",
      amount: 900,
      currency: "eur",
    });

    const created = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", `key-read-${randomUUID()}`)
      .send({ restaurantId: restaurant.id, amount: 900 });
    expect(created.status).toBe(201);
    const paymentId = created.body.id;

    // The owner who created it can read it, through both read routes.
    const mine = await request(app.getHttpServer()).get(`/payments/${paymentId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.id).toBe(paymentId);

    const mineStatus = await request(app.getHttpServer()).get(`/payments/${paymentId}/status`);
    expect(mineStatus.status).toBe(200);
    expect(mineStatus.body.status).toBe("PENDING");

    // A different Organization entirely, with its own org-wide Owner. Org-wide "somewhere" must
    // never mean org-wide "here" — the exact gap that shipped in Sprint 4 and was caught live.
    const otherRestaurant = await seedRestaurant();
    currentUser = await ownerUserFor(otherRestaurant);

    const stranger = await request(app.getHttpServer()).get(`/payments/${paymentId}`);
    expect(stranger.status).toBe(404);
    expect(stranger.body.code).toBe("PAYMENT_NOT_FOUND");

    const strangerStatus = await request(app.getHttpServer()).get(`/payments/${paymentId}/status`);
    expect(strangerStatus.status).toBe(404);
    expect(strangerStatus.body.code).toBe("PAYMENT_NOT_FOUND");
  });

  // GET /payments (list) — same reachability rule, different failure mode: a leak here returns
  // someone else's rows rather than one row, so the discriminating assertion is that the stranger's
  // own list is empty of this payment while the owner's contains it. A naive implementation that
  // skipped scoping entirely (returning every Payment) passes the owner half and fails this one.
  it("GET /payments: scoped to reachable restaurants only — a caller in another Organization does not see the payment", async () => {
    const restaurant = await seedRestaurant();
    currentUser = await ownerUserFor(restaurant);

    stripeMocks.paymentIntentsCreate.mockResolvedValueOnce({
      id: "pi_fake_list_test",
      client_secret: "pi_fake_list_secret",
      amount: 700,
      currency: "eur",
    });

    const created = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", `key-list-${randomUUID()}`)
      .send({ restaurantId: restaurant.id, amount: 700 });
    expect(created.status).toBe(201);
    const paymentId = created.body.id;

    const ownerList = await request(app.getHttpServer()).get("/payments");
    expect(ownerList.status).toBe(200);
    expect((ownerList.body.data as Array<{ id: string }>).some((p) => p.id === paymentId)).toBe(
      true,
    );

    const otherRestaurant = await seedRestaurant();
    currentUser = await ownerUserFor(otherRestaurant);

    const strangerList = await request(app.getHttpServer()).get("/payments");
    expect(strangerList.status).toBe(200);
    expect((strangerList.body.data as Array<{ id: string }>).some((p) => p.id === paymentId)).toBe(
      false,
    );
  });
});
