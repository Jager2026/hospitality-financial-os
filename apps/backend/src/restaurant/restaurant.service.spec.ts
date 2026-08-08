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

    // Currency/Role/Permission/RolePermission rows are seeded once, globally, before any spec
    // file runs — see test/global-setup.ts for why (a real cross-file upsert race, not a
    // hypothetical). Looked up here, never written, so this file can't race another one seeding
    // the same rows.
    const ownerRole = await prisma.role.findUniqueOrThrow({ where: { name: "Owner" } });
    ownerRoleId = ownerRole.id;

    const waiterRole = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
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

  it("findAllForUser: a restaurant-scoped Membership sees only its own Restaurant, not every Restaurant in the Organization", async () => {
    // Real bug, caught live (not by this test first — the other way around): the original
    // findAllForUser used every Membership's organizationId regardless of whether that
    // Membership was org-wide or restaurant-scoped, so a restaurant-scoped Membership could see
    // every Restaurant in the Organization the moment a second one existed. This test only fails
    // against that buggy version because it requires a SECOND Restaurant in the same
    // Organization — a single-restaurant Organization can't distinguish the two implementations.
    const ownerUserId = await createTestUser();
    const first = await service.create(baseDto({ name: "Scoped First" }), ownerUserId, null);
    const second = await service.create(
      baseDto({ name: "Scoped Second" }),
      ownerUserId,
      first.organizationId,
    );

    const scopedUserId = await createTestUser();
    await prisma.membership.create({
      data: {
        userId: scopedUserId,
        organizationId: first.organizationId,
        restaurantId: first.id, // scoped to the FIRST restaurant only
        roleId: waiterRoleId,
        status: "ACTIVE",
      },
    });

    const scopedUser: AuthenticatedUser = {
      id: scopedUserId,
      email: "scoped@example.com",
      locale: "en",
      memberships: [
        {
          id: "irrelevant",
          organizationId: first.organizationId,
          restaurantId: first.id,
          role: { id: waiterRoleId, name: "Waiter", permissions: [] },
        },
      ],
    };

    const visible = await service.findAllForUser(scopedUser);
    const visibleIds = visible.map((r) => r.id);

    expect(visibleIds).toContain(first.id);
    expect(visibleIds).not.toContain(second.id);
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

  it("refreshStripeStatusByAccountId: re-derives onboarding_status from a live capability re-fetch, keyed by stripeAccountId (Sprint 5, account.updated webhook entry point)", async () => {
    const ownerUserId = await createTestUser();
    const restaurant = await service.create(baseDto(), ownerUserId, null);
    expect(restaurant.onboardingStatus).toBe("NOT_STARTED"); // fakeStripe's default getAccountStatus mock

    fakeStripe.getAccountStatus.mockResolvedValueOnce({
      cardPaymentsStatus: "active",
      payoutsStatus: "active",
      requirementsDue: [],
    });

    const updated = await service.refreshStripeStatusByAccountId(
      restaurant.stripeAccountId as string,
    );

    expect(updated?.onboardingStatus).toBe("COMPLETE");
    expect(updated?.cardPaymentsStatus).toBe("active");
  });

  it("refreshStripeStatusByAccountId: an unknown stripeAccountId returns null rather than throwing", async () => {
    const result = await service.refreshStripeStatusByAccountId("acct_does_not_exist");
    expect(result).toBeNull();
  });
});
