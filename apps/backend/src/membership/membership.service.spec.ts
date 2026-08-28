import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { MembershipService } from "./membership.service";

describe("MembershipService (real database)", () => {
  const prisma = new PrismaService();
  const service = new MembershipService(prisma);
  let waiterRoleId: string;
  let managerRoleId: string;

  beforeAll(async () => {
    await prisma.$connect();

    // Currency/Role/Permission/RolePermission rows are seeded once, globally, before any spec
    // file runs — see test/global-setup.ts for why (a real cross-file upsert race, not a
    // hypothetical). Looked up here, never written, so this file can't race another one seeding
    // the same rows.
    const waiterRole = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
    waiterRoleId = waiterRole.id;

    const managerRole = await prisma.role.findUniqueOrThrow({ where: { name: "Manager" } });
    managerRoleId = managerRole.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createOrgWithTwoRestaurants() {
    const organization = await prisma.organization.create({
      data: { name: "Membership Test Org" },
    });
    const currency = await prisma.currency.findUniqueOrThrow({ where: { code: "EUR" } });
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
      data: {
        email: `${randomUUID()}@example.com`,
        displayName: "Test User",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
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

  // Sprint 13 audit finding: getReachableOrThrow had no test covering its cross-Organization
  // rejection, so findOne() was uncovered entirely. Discriminating by construction: the caller
  // holds a genuinely ORG-WIDE Membership (restaurantId null) — just in a different Organization.
  // The exact implementation this catches is the one CLAUDE.md's Architecture Review paragraph
  // names by name: treating `restaurantId === null` alone as proof of reach, without comparing
  // organizationId. Under that version an org-wide Owner of any Organization reads every
  // Membership in every other one; under the correct version this is a 404.
  it("findOne: an org-wide Membership in a DIFFERENT Organization cannot reach this Membership — org-wide 'somewhere' is not org-wide 'here'", async () => {
    const { organization, first } = await createOrgWithTwoRestaurants();

    const targetUser = await createUser();
    const targetMembership = await prisma.membership.create({
      data: {
        userId: targetUser.id,
        organizationId: organization.id,
        restaurantId: first.id,
        roleId: waiterRoleId,
        status: "ACTIVE",
      },
    });

    // A completely unrelated Organization, whose Owner is org-wide within it.
    const outsiderOrg = await createOrgWithTwoRestaurants();
    const outsiderUser = await createUser();
    const outsiderMembership = await prisma.membership.create({
      data: {
        userId: outsiderUser.id,
        organizationId: outsiderOrg.organization.id,
        restaurantId: null, // org-wide — but in the WRONG Organization
        roleId: managerRoleId,
        status: "ACTIVE",
      },
    });

    const outsider: AuthenticatedUser = {
      id: outsiderUser.id,
      email: outsiderUser.email,
      locale: "en",
      memberships: [
        {
          id: outsiderMembership.id,
          organizationId: outsiderOrg.organization.id,
          restaurantId: null,
          role: { id: managerRoleId, name: "Manager", permissions: ["membership.manage"] },
        },
      ],
    };

    await expect(service.findOne(targetMembership.id, outsider)).rejects.toMatchObject({
      code: "MEMBERSHIP_NOT_FOUND",
    });

    // And the same caller CAN reach a Membership inside their own Organization — proving the
    // rejection above is real scoping, not a blanket denial that would pass for the wrong reason.
    const insiderUser = await createUser();
    const insiderMembership = await prisma.membership.create({
      data: {
        userId: insiderUser.id,
        organizationId: outsiderOrg.organization.id,
        restaurantId: outsiderOrg.first.id,
        roleId: waiterRoleId,
        status: "ACTIVE",
      },
    });
    const reachable = await service.findOne(insiderMembership.id, outsider);
    expect(reachable.id).toBe(insiderMembership.id);
  });

  // Sprint 13 audit finding: disable() was uncovered, and it is the one write path that both
  // resolves reachability AND checks a permission. Discriminating on the permission half: the
  // caller genuinely reaches the target (same Organization, org-wide) but holds no
  // membership.manage at all — an implementation that checked only reachability and skipped
  // assertPermission would disable the Membership instead of throwing.
  it("disable: reachability alone is not enough — a caller without membership.manage is rejected, and the Membership stays ACTIVE", async () => {
    const { organization, first } = await createOrgWithTwoRestaurants();

    const targetUser = await createUser();
    const targetMembership = await prisma.membership.create({
      data: {
        userId: targetUser.id,
        organizationId: organization.id,
        restaurantId: first.id,
        roleId: waiterRoleId,
        status: "ACTIVE",
      },
    });

    const weakUser = await createUser();
    const weakMembership = await prisma.membership.create({
      data: {
        userId: weakUser.id,
        organizationId: organization.id,
        restaurantId: null, // org-wide in the RIGHT Organization — genuinely reaches the target
        roleId: waiterRoleId,
        status: "ACTIVE",
      },
    });

    const weakCaller: AuthenticatedUser = {
      id: weakUser.id,
      email: weakUser.email,
      locale: "en",
      memberships: [
        {
          id: weakMembership.id,
          organizationId: organization.id,
          restaurantId: null,
          role: { id: waiterRoleId, name: "Waiter", permissions: [] }, // no membership.manage
        },
      ],
    };

    await expect(service.disable(targetMembership.id, weakCaller)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    // The rejection must be real, not merely thrown after the write already happened.
    const untouched = await prisma.membership.findUniqueOrThrow({
      where: { id: targetMembership.id },
    });
    expect(untouched.status).toBe("ACTIVE");
  });

  it("GET /memberships returns exactly these fields — the recorded revisit condition, made checkable", async () => {
    // API_Contract.md decides this route requires authentication only, on the grounds that a
    // colleague list is operational information the people on it already have. That decision is
    // about WHAT IS RETURNED, not about the route — and a route does not change when a column is
    // added to the model behind it. findAllForUser returns the raw Prisma Membership, so any new
    // column would be exposed the day it is added, silently, to everyone who works a shift.
    //
    // This assertion is the revisit condition itself rather than an intention to remember it:
    // add a field to Membership and this fails, which forces the decision to be re-taken instead
    // of quietly inherited.
    const { organization, first } = await createOrgWithTwoRestaurants();
    const user = await createUser();
    const waiterRole = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        restaurantId: first.id,
        roleId: waiterRole.id,
      },
    });

    const rows = await service.findAllForUser({
      id: user.id,
      email: user.email,
      locale: "en",
      memberships: [
        {
          id: membership.id,
          organizationId: organization.id,
          restaurantId: first.id,
          role: { id: membership.roleId, name: "Waiter", permissions: [] },
        },
      ],
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "createdAt",
        "deletedAt",
        "hireDate",
        "id",
        "organizationId",
        "restaurantId",
        "roleId",
        "status",
        "updatedAt",
        "userId",
      ].sort(),
    );
  });
});
