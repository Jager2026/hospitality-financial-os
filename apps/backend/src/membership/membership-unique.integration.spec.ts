import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";

/**
 * ADR-088 — `membership_one_active_per_scope`, the partial unique index the schema cannot express.
 *
 * **Three tests, and the two that matter are the ones that say NO to the index rather than yes.**
 * A full `@@unique([userId, organizationId, restaurantId])` passes the first test and fails the
 * second; an index without `NULLS NOT DISTINCT` passes the first two and fails the third. Only the
 * shape actually shipped passes all three, which is what makes them a specification rather than a
 * demonstration.
 *
 * The rule this defends is in `MembershipInvitationService.accept`, and it is correct there. The
 * index exists because a rule is something the next code path can simply not apply, in silence.
 */
describe("membership_one_active_per_scope (ADR-088)", () => {
  const prisma = new PrismaService();
  let organizationId: string;
  let restaurantId: string;
  let roleId: string;
  const seededUsers: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
    const org = await prisma.organization.create({ data: { name: "Membership Unique Test Org" } });
    organizationId = org.id;
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId,
        name: "Membership Unique Test Restaurant",
        legalName: "Membership Unique Test Restaurant UAB",
        companyNumber: `MU-${randomUUID()}`,
        vatNumber: `LTMU${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000012",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
      },
    });
    restaurantId = restaurant.id;
    roleId = (await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } })).id;
  });

  afterAll(async () => {
    await prisma.membership.deleteMany({ where: { userId: { in: seededUsers } } });
    await prisma.$disconnect();
  });

  async function seedUser(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `membership-unique-${randomUUID()}@example.com`,
        displayName: "Constraint Fixture",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    seededUsers.push(user.id);
    return user.id;
  }

  function membership(
    userId: string,
    scope: { restaurantId: string | null; status?: "ACTIVE" | "INACTIVE" },
  ) {
    return prisma.membership.create({
      data: {
        userId,
        organizationId,
        restaurantId: scope.restaurantId,
        roleId,
        status: scope.status ?? "ACTIVE",
      },
    });
  }

  it("refuses a second ACTIVE Membership for the same person at the same restaurant", async () => {
    const userId = await seedUser();
    await membership(userId, { restaurantId });

    await expect(
      membership(userId, { restaurantId }),
      "two ACTIVE memberships at one employer means two Wallets for one person (ADR-006)",
    ).rejects.toThrow(/membership_one_active_per_scope|Unique constraint/i);
  });

  it(
    "ALLOWS a new ACTIVE Membership beside an INACTIVE one — re-hiring somebody is an ordinary " +
      "thing to do, and a full unique index would have blocked it",
    async () => {
      const userId = await seedUser();
      // Removal is `MembershipService.disable`: status goes INACTIVE and the row stays. Nothing in
      // this codebase writes `deleted_at` on a membership, which is why the predicate is on
      // `status` and not on `deleted_at` — a partial index on the latter would cover every row and
      // be a full unique index wearing a WHERE clause.
      await membership(userId, { restaurantId, status: "INACTIVE" });

      const rehired = await membership(userId, { restaurantId });

      expect(rehired.status).toBe("ACTIVE");
    },
  );

  it(
    "refuses a second ACTIVE ORG-WIDE Membership, where restaurant_id is NULL — the half that " +
      "NULLS NOT DISTINCT buys, and the one an index without it would leave open",
    async () => {
      const userId = await seedUser();
      // ADR-005: `restaurant_id IS NULL` is a role over every restaurant in the Organization.
      // Postgres treats NULLs as distinct in a unique index by default, so without the clause this
      // is precisely the case — the widest grant in the system — that would go unconstrained.
      await membership(userId, { restaurantId: null });

      await expect(
        membership(userId, { restaurantId: null }),
        "two org-wide memberships for one person in one Organization",
      ).rejects.toThrow(/membership_one_active_per_scope|Unique constraint/i);
    },
  );
});
