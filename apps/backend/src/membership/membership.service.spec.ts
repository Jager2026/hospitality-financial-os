import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { MembershipService } from "./membership.service";

describe("MembershipService (real database)", () => {
  const prisma = new PrismaService();
  const service = new MembershipService(prisma);
  let waiterRoleId: string;
  let managePermissionId: string;
  let managerRoleId: string;

  beforeAll(async () => {
    await prisma.$connect();

    const waiterRole = await prisma.role.upsert({
      where: { name: "Waiter" },
      update: {},
      create: { name: "Waiter", description: "Restaurant staff member" },
    });
    waiterRoleId = waiterRole.id;

    const managePermission = await prisma.permission.upsert({
      where: { name: "membership.manage" },
      update: {},
      create: { name: "membership.manage", description: "Edit or disable an existing Membership" },
    });
    managePermissionId = managePermission.id;

    const managerRole = await prisma.role.upsert({
      where: { name: "Manager" },
      update: {},
      create: { name: "Manager", description: "Day-to-day operational control of one Restaurant" },
    });
    managerRoleId = managerRole.id;
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: managerRoleId, permissionId: managePermissionId } },
      update: {},
      create: { roleId: managerRoleId, permissionId: managePermissionId },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createOrgWithTwoRestaurants() {
    const organization = await prisma.organization.create({
      data: { name: "Membership Test Org" },
    });
    const currency = await prisma.currency.upsert({
      where: { code: "EUR" },
      update: {},
      create: { code: "EUR", exponent: 2, name: "Euro" },
    });
    async function makeRestaurant(name: string) {
      return prisma.restaurant.create({
        data: {
          organizationId: organization.id,
          name,
          legalName: `${name} UAB`,
          companyNumber: `CO-${randomUUID()}`,
          vatNumber: `LT${randomUUID()}`,
          email: `${randomUUID()}@example.com`,
          phone: "+37060000000",
          country: "LT",
          currency: currency.code,
          defaultCustomerLocale: "en",
          timezone: "Europe/Vilnius",
          address: "Test address",
        },
      });
    }
    const first = await makeRestaurant("First");
    const second = await makeRestaurant("Second");
    return { organization, first, second };
  }

  async function createUser() {
    return prisma.user.create({
      data: { email: `${randomUUID()}@example.com`, passwordHash: "not-a-real-hash", locale: "en" },
    });
  }

  it("findAllForUser: a restaurant-scoped Membership sees only Memberships at its own Restaurant, not the whole Organization's team", async () => {
    // Same bug shape as restaurant.service.ts's own findAllForUser, caught live this session —
    // only distinguishable with a second Restaurant in the Organization.
    const { organization, first, second } = await createOrgWithTwoRestaurants();

    const managerUser = await createUser();
    const managerMembership = await prisma.membership.create({
      data: {
        userId: managerUser.id,
        organizationId: organization.id,
        restaurantId: first.id,
        roleId: managerRoleId,
        status: "ACTIVE",
      },
    });

    const otherUser = await createUser();
    const otherMembership = await prisma.membership.create({
      data: {
        userId: otherUser.id,
        organizationId: organization.id,
        restaurantId: second.id,
        roleId: waiterRoleId,
        status: "ACTIVE",
      },
    });

    const managerAsAuthenticatedUser: AuthenticatedUser = {
      id: managerUser.id,
      email: managerUser.email,
      locale: "en",
      memberships: [
        {
          id: managerMembership.id,
          organizationId: organization.id,
          restaurantId: first.id,
          role: { id: managerRoleId, name: "Manager", permissions: ["membership.manage"] },
        },
      ],
    };

    const visible = await service.findAllForUser(managerAsAuthenticatedUser);
    const visibleIds = visible.map((m) => m.id);

    expect(visibleIds).toContain(managerMembership.id);
    expect(visibleIds).not.toContain(otherMembership.id);
  });

  it("update() requires membership.manage scoped to the target Membership's Restaurant, not just anywhere", async () => {
    const { organization, first, second } = await createOrgWithTwoRestaurants();

    const targetUser = await createUser();
    const targetMembership = await prisma.membership.create({
      data: {
        userId: targetUser.id,
        organizationId: organization.id,
        restaurantId: second.id,
        roleId: waiterRoleId,
        status: "ACTIVE",
      },
    });

    const managerUser = await createUser();
    const managerMembership = await prisma.membership.create({
      data: {
        userId: managerUser.id,
        organizationId: organization.id,
        restaurantId: first.id, // manages the FIRST restaurant, not the second
        roleId: managerRoleId,
        status: "ACTIVE",
      },
    });

    const managerAsAuthenticatedUser: AuthenticatedUser = {
      id: managerUser.id,
      email: managerUser.email,
      locale: "en",
      memberships: [
        {
          id: managerMembership.id,
          organizationId: organization.id,
          restaurantId: first.id,
          role: { id: managerRoleId, name: "Manager", permissions: ["membership.manage"] },
        },
      ],
    };

    // Not reachable at all (different restaurant, restaurant-scoped) -> 404, matching
    // restaurant.service.ts's own no-enumeration convention.
    await expect(
      service.update(targetMembership.id, { roleId: waiterRoleId }, managerAsAuthenticatedUser),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_FOUND" });
  });
});
