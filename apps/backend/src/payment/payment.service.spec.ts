import { randomUUID } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import type { StripeService } from "../stripe/stripe.service";
import { PaymentService } from "./payment.service";

// Real database, real PaymentService — only StripeService is faked (no real Stripe network call
// from an automated test), same precedent as restaurant.service.spec.ts.
describe("PaymentService (real database)", () => {
  const prisma = new PrismaService();
  let service: PaymentService;
  let waiterRoleId: string;
  let managerRoleId: string;

  const fakeStripe = {
    createPaymentIntent: vi.fn().mockImplementation(() =>
      Promise.resolve({
        id: `pi_fake_${randomUUID()}`,
        clientSecret: `pi_fake_secret_${randomUUID()}`,
        amount: 1550,
        currency: "eur",
      }),
    ),
  } as unknown as StripeService;

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.currency.upsert({
      where: { code: "EUR" },
      update: {},
      create: { code: "EUR", exponent: 2, name: "Euro" },
    });

    const paymentsManage = await prisma.permission.upsert({
      where: { name: "payments.manage" },
      update: {},
      create: { name: "payments.manage", description: "View and manage payment activity" },
    });

    const managerRole = await prisma.role.upsert({
      where: { name: "Manager" },
      update: {},
      create: { name: "Manager", description: "Day-to-day operational control of one Restaurant" },
    });
    managerRoleId = managerRole.id;
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: managerRoleId, permissionId: paymentsManage.id },
      },
      update: {},
      create: { roleId: managerRoleId, permissionId: paymentsManage.id },
    });

    const waiterRole = await prisma.role.upsert({
      where: { name: "Waiter" },
      update: {},
      create: { name: "Waiter", description: "Restaurant staff member" },
    });
    waiterRoleId = waiterRole.id;

    const fakeConfig = { getOrThrow: () => 100 } as unknown as ConfigService; // 1.00%, Founder decision
    service = new PaymentService(prisma, fakeStripe, fakeConfig);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createOrg() {
    return prisma.organization.create({ data: { name: "Payment Test Org" } });
  }

  async function createRestaurant(
    organizationId: string,
    overrides: { stripeAccountId?: string | null } = {},
  ) {
    return prisma.restaurant.create({
      data: {
        organizationId,
        name: "Payment Test Restaurant",
        legalName: "Payment Test Restaurant UAB",
        companyNumber: `PAY-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000003",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
        stripeAccountId:
          overrides.stripeAccountId === undefined
            ? `acct_fake_${randomUUID()}`
            : overrides.stripeAccountId,
      },
    });
  }

  async function createUserWithMembership(
    organizationId: string,
    restaurantId: string | null,
    roleId: string,
  ) {
    const user = await prisma.user.create({
      data: {
        email: `user-${randomUUID()}@example.com`,
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId, restaurantId, roleId, status: "ACTIVE" },
    });
    return { user, membership };
  }

  function asAuthenticatedUser(
    user: { id: string; email: string },
    membership: { id: string; organizationId: string; restaurantId: string | null },
    role: { id: string; name: string; permissions: string[] },
  ): AuthenticatedUser {
    return {
      id: user.id,
      email: user.email,
      locale: "en",
      memberships: [
        {
          id: membership.id,
          organizationId: membership.organizationId,
          restaurantId: membership.restaurantId,
          role,
        },
      ],
    };
  }

  async function seedIdempotencyKey(key: string, endpointScope: string) {
    return prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope,
        requestFingerprint: "test-fingerprint",
        status: "IN_PROGRESS",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  }

  it("createPaymentIntent: creates a PENDING Payment linked to the pre-created IdempotencyKey, amount preserved exactly as a bigint", async () => {
    const org = await createOrg();
    const restaurant = await createRestaurant(org.id);
    const { user, membership } = await createUserWithMembership(
      org.id,
      restaurant.id,
      managerRoleId,
    );
    const authedUser = asAuthenticatedUser(user, membership, {
      id: managerRoleId,
      name: "Manager",
      permissions: ["payments.manage"],
    });

    const key = `pay-key-${randomUUID()}`;
    await seedIdempotencyKey(key, "/payments");

    const result = await service.createPaymentIntent(
      { restaurantId: restaurant.id, amount: 1550 },
      key,
      authedUser,
    );

    expect(result.status).toBe("PENDING");
    expect(result.amount).toBe("1550"); // string, not a float-rounded Number
    expect(result.currency).toBe("EUR");
    expect(result.clientSecret).toBeTruthy();

    const stored = await prisma.payment.findUnique({ where: { id: result.id } });
    expect(stored?.amount).toBe(1550n); // genuinely a bigint round-trip, not coerced
    expect(stored?.idempotencyKey).toBe(key);
    expect(stored?.restaurantId).toBe(restaurant.id);
    expect(stored?.processor).toBe("stripe");

    expect(fakeStripe.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeAccountId: restaurant.stripeAccountId,
        amount: 1550n,
        applicationFeeAmount: 15n, // 1% of 1550, Founder decision (100 basis points)
      }),
    );
  });

  it("createPaymentIntent: a user with no Membership at the Restaurant cannot create a payment (404, not 403 — no enumeration)", async () => {
    const org = await createOrg();
    const restaurant = await createRestaurant(org.id);
    const outsider: AuthenticatedUser = {
      id: randomUUID(),
      email: "outsider@example.com",
      locale: "en",
      memberships: [],
    };

    await expect(
      service.createPaymentIntent(
        { restaurantId: restaurant.id, amount: 1000 },
        `outsider-key-${randomUUID()}`,
        outsider,
      ),
    ).rejects.toMatchObject({ code: "RESTAURANT_NOT_FOUND" });
  });

  it("createPaymentIntent: a reachable Waiter (no payments.manage) is rejected with PERMISSION_DENIED", async () => {
    const org = await createOrg();
    const restaurant = await createRestaurant(org.id);
    const { user, membership } = await createUserWithMembership(
      org.id,
      restaurant.id,
      waiterRoleId,
    );
    const authedUser = asAuthenticatedUser(user, membership, {
      id: waiterRoleId,
      name: "Waiter",
      permissions: [],
    });

    await expect(
      service.createPaymentIntent(
        { restaurantId: restaurant.id, amount: 1000 },
        `waiter-key-${randomUUID()}`,
        authedUser,
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("createPaymentIntent: a Restaurant with no Stripe account cannot accept payments yet", async () => {
    const org = await createOrg();
    const restaurant = await createRestaurant(org.id, { stripeAccountId: null });
    const { user, membership } = await createUserWithMembership(
      org.id,
      restaurant.id,
      managerRoleId,
    );
    const authedUser = asAuthenticatedUser(user, membership, {
      id: managerRoleId,
      name: "Manager",
      permissions: ["payments.manage"],
    });

    await expect(
      service.createPaymentIntent(
        { restaurantId: restaurant.id, amount: 1000 },
        `no-stripe-key-${randomUUID()}`,
        authedUser,
      ),
    ).rejects.toMatchObject({ code: "RESTAURANT_NOT_FOUND" });
  });

  it("findAllForUser: a restaurant-scoped Membership sees only Payments at its own Restaurant, not every Restaurant in the Organization", async () => {
    // Same reachability bug shape caught live in Sprint 4 (restaurant.service.ts, membership.service.ts)
    // — this test requires a SECOND Restaurant in the same Organization to be discriminating.
    const org = await createOrg();
    const first = await createRestaurant(org.id);
    const second = await createRestaurant(org.id);
    const { user, membership } = await createUserWithMembership(org.id, first.id, managerRoleId);
    const authedUser = asAuthenticatedUser(user, membership, {
      id: managerRoleId,
      name: "Manager",
      permissions: ["payments.manage"],
    });

    const keyFirst = `scope-first-${randomUUID()}`;
    const keySecond = `scope-second-${randomUUID()}`;
    await seedIdempotencyKey(keyFirst, "/payments");
    await seedIdempotencyKey(keySecond, "/payments");

    const paymentFirst = await service.createPaymentIntent(
      { restaurantId: first.id, amount: 500 },
      keyFirst,
      authedUser,
    );
    // Second Payment created directly (not through the scoped user, who can't reach `second`) —
    // simulates a payment that legitimately exists at the other Restaurant.
    await prisma.payment.create({
      data: {
        restaurantId: second.id,
        processor: "stripe",
        processorPaymentId: `pi_fake_${randomUUID()}`,
        amount: 700n,
        currency: "EUR",
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey: keySecond,
      },
    });

    const page = await service.findAllForUser(authedUser, { page: 1, limit: 20 });
    const ids = page.data.map((p) => p.id);

    expect(ids).toContain(paymentFirst.id);
    expect(ids.length).toBe(1); // not the second restaurant's payment too
  });
});
