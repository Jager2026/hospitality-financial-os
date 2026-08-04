import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import type { CreateRestaurantDto } from "./dto/create-restaurant.schema";
import { RestaurantService } from "./restaurant.service";

// Real database, real RestaurantService, real Prisma transaction — only StripeService is faked
// (no real Stripe network call from an automated test). Seeds exactly the Role/Permission rows
// this test needs directly, matching ledger-trigger.integration.spec.ts's own precedent, rather
// than depending on a separate seed step CI doesn't run.
describe("RestaurantService (real database)", () => {
  const prisma = new PrismaService();
  let service: RestaurantService;
  let ownerRoleId: string;
  let waiterRoleId: string;

  const fakeStripe = {
    createConnectAccount: vi
      .fn()
      .mockImplementation(() => Promise.resolve(`acct_fake_${randomUUID()}`)),
    createOnboardingLink: vi.fn().mockResolvedValue("https://connect.stripe.com/fake"),
    getAccountStatus: vi.fn().mockResolvedValue({
      cardPaymentsStatus: "active",
      payoutsStatus: "active",
      requirementsDue: [],
    }),
  };

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.currency.upsert({
      where: { code: "EUR" },
      update: {},
      create: { code: "EUR", exponent: 2, name: "Euro" },
    });

    const restaurantCreate = await prisma.permission.upsert({
      where: { name: "restaurant.create" },
      update: {},
      create: { name: "restaurant.create", description: "Create a new Restaurant" },
    });
    const restaurantEdit = await prisma.permission.upsert({
      where: { name: "restaurant.edit" },
      update: {},
      create: { name: "restaurant.edit", description: "Edit Restaurant details and settings" },
    });

    const ownerRole = await prisma.role.upsert({
      where: { name: "Owner" },
      update: {},
      create: { name: "Owner", description: "Full control" },
    });
    ownerRoleId = ownerRole.id;
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: ownerRole.id, permissionId: restaurantCreate.id } },
      update: {},
      create: { roleId: ownerRole.id, permissionId: restaurantCreate.id },
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: ownerRole.id, permissionId: restaurantEdit.id } },
      update: {},
      create: { roleId: ownerRole.id, permissionId: restaurantEdit.id },
    });

    const waiterRole = await prisma.role.upsert({
      where: { name: "Waiter" },
      update: {},
      create: { name: "Waiter", description: "Restaurant staff member" },
    });
    waiterRoleId = waiterRole.id;

    const moduleRef = await Test.createTestingModule({
      providers: [
        RestaurantService,
        { provide: PrismaService, useValue: prisma },
        { provide: StripeService, useValue: fakeStripe },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => "http://localhost:3000" },
        },
      ],
    }).compile();

    service = moduleRef.get(RestaurantService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function baseDto(overrides: Partial<CreateRestaurantDto> = {}): CreateRestaurantDto {
    return {
      name: "Test Bistro",
      legalName: "Test Bistro UAB",
      companyNumber: "111222333",
      vatNumber: "LT111222333",
      email: `bistro-${randomUUID()}@example.com`,
      phone: "+37060000001",
      country: "LT",
      currency: "EUR",
      defaultCustomerLocale: "en",
      timezone: "Europe/Vilnius",
      address: "Test address 1",
      ...overrides,
    };
  }

  async function createTestUser(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `user-${randomUUID()}@example.com`,
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    return user.id;
  }

  it("bootstrap creation: creates an Organization, an org-wide Owner Membership, and the Restaurant in one transaction", async () => {
    const userId = await createTestUser();

    const restaurant = await service.create(baseDto(), userId, null);

    expect(restaurant.stripeAccountId).toMatch(/^acct_fake_/);
    expect(fakeStripe.createConnectAccount).toHaveBeenCalledWith(
      expect.objectContaining({ country: "LT" }),
    );

    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId: restaurant.organizationId },
    });
    expect(membership).not.toBeNull();
    expect(membership?.restaurantId).toBeNull(); // org-wide, per DATABASE.md
    expect(membership?.roleId).toBe(ownerRoleId);

    const organization = await prisma.organization.findUnique({
      where: { id: restaurant.organizationId },
    });
    expect(organization).not.toBeNull();
  });

  it("second restaurant for an existing organization does NOT create a second Membership", async () => {
    const userId = await createTestUser();
    const first = await service.create(baseDto(), userId, null);

    await service.create(baseDto({ name: "Second Location" }), userId, first.organizationId);

    const memberships = await prisma.membership.findMany({
      where: { userId, organizationId: first.organizationId },
    });
    // Exactly one org-wide Membership reaches both restaurants — a naive implementation that
    // always creates a fresh Membership per Restaurant would fail this, not just one that creates
    // zero.
    expect(memberships).toHaveLength(1);
  });

  it("a reachable-but-unpermitted user (Waiter, zero permissions) can read but not edit", async () => {
    const ownerUserId = await createTestUser();
    const restaurant = await service.create(baseDto(), ownerUserId, null);

    const waiterUserId = await createTestUser();
    await prisma.membership.create({
      data: {
        userId: waiterUserId,
        organizationId: restaurant.organizationId,
        restaurantId: null,
        roleId: waiterRoleId,
        status: "ACTIVE",
      },
    });

    const waiterAsAuthenticatedUser: AuthenticatedUser = {
      id: waiterUserId,
      email: "waiter@example.com",
      locale: "en",
      memberships: [
        {
          id: "irrelevant",
          organizationId: restaurant.organizationId,
          restaurantId: null,
          role: { id: waiterRoleId, name: "Waiter", permissions: [] },
        },
      ],
    };

    // Reachable: findOne must not throw NOT_FOUND for a Membership that legitimately reaches it.
    await expect(service.findOne(restaurant.id, waiterAsAuthenticatedUser)).resolves.toMatchObject({
      id: restaurant.id,
    });

    // Not permitted: same restaurant, but the Waiter role carries none of the permissions —
    // the discriminating case that separates "can see it" from "can change it."
    await expect(
      service.update(restaurant.id, { name: "Hacked" }, waiterAsAuthenticatedUser),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("a user with no Membership at all cannot reach the restaurant (404, not 403 — no enumeration)", async () => {
    const ownerUserId = await createTestUser();
    const restaurant = await service.create(baseDto(), ownerUserId, null);

    const outsiderUserId = await createTestUser();
    const outsider: AuthenticatedUser = {
      id: outsiderUserId,
      email: "outsider@example.com",
      locale: "en",
      memberships: [],
    };

    await expect(service.findOne(restaurant.id, outsider)).rejects.toMatchObject({
      code: "RESTAURANT_NOT_FOUND",
    });
  });
});
