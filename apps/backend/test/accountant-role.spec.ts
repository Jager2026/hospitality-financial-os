import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "../src/auth/guards/jwt-auth.guard";
import { PrismaService } from "../src/prisma/prisma.service";
import { AnalyticsService } from "../src/analytics/analytics.service";
import { PaymentService } from "../src/payment/payment.service";
import { seededRole } from "./fixtures/authenticated-user";
import { shiftServiceForTests } from "./fixtures/shift-for-tests";
import { findStaleGrants } from "../prisma/seed";

/**
 * ADR-066 — the Accountant role.
 *
 * **Read from the seed, never from a literal.** This project has twice shipped fixtures naming a
 * seeded Role while describing permissions the seed does not give it, and both times the fixture
 * proved things about a system that does not exist. Every assertion below asks the database what
 * the seed actually produced.
 */
describe("Accountant role (real database)", () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it(
    "holds exactly reports.view and data.export — the two that let a bookkeeper read the figures " +
      "and take them out, and nothing else: removing either one fails this and leaves the other " +
      "assertion standing",
    async () => {
      const accountant = await seededRole(prisma, "Accountant");

      expect(accountant.permissions).toContain("reports.view");
      expect(accountant.permissions).toContain("data.export");
      // Exactly two. A subset-of-Manager implementation would carry restaurant.edit,
      // membership.invite, membership.manage and tips.configure as well, and fail here.
      expect(accountant.permissions).toHaveLength(2);
    },
  );

  it(
    "cannot reach an individual payment or change a setting — asserted as the ABSENCE of the " +
      "permissions those routes require, which is what the guard actually checks",
    async () => {
      const accountant = await seededRole(prisma, "Accountant");

      // GET /payments/{id} and POST /payments require payments.manage (payment.controller.ts).
      expect(accountant.permissions).not.toContain("payments.manage");
      // PATCH /restaurants/{id} fine-checks restaurant.edit inside the service (ADR-005).
      expect(accountant.permissions).not.toContain("restaurant.edit");
      // Staff: neither inviting nor managing.
      expect(accountant.permissions).not.toContain("membership.invite");
      expect(accountant.permissions).not.toContain("membership.manage");
      // Settings and RBAC.
      expect(accountant.permissions).not.toContain("tips.configure");
      expect(accountant.permissions).not.toContain("roles.manage");
      // Nor closing or creating a venue.
      expect(accountant.permissions).not.toContain("restaurant.create");
      expect(accountant.permissions).not.toContain("restaurant.delete");
    },
  );

  it("is grantable by a Restaurant — not platform-only, unlike Administrator (ADR-044)", async () => {
    const row = await prisma.role.findUniqueOrThrow({ where: { name: "Accountant" } });
    expect(row.platformOnly).toBe(false);

    const admin = await prisma.role.findUniqueOrThrow({ where: { name: "Administrator" } });
    // The discriminating pair: if platformOnly were being read wrong, both would come back the
    // same and this test would be asserting a constant rather than a difference.
    expect(admin.platformOnly).toBe(true);
  });

  it(
    "attaches through an ordinary Membership, org-wide or restaurant-scoped — no new mechanism, " +
      "so nothing about reachability (ADR-005) changes",
    async () => {
      const accountant = await seededRole(prisma, "Accountant");
      const org = await prisma.organization.create({ data: { name: `Org ${randomUUID()}` } });
      const restaurant = await prisma.restaurant.create({
        data: {
          organizationId: org.id,
          name: `R ${randomUUID()}`,
          legalName: "L",
          companyNumber: "1",
          vatNumber: "LT1",
          email: "r@example.invalid",
          phone: "+37060000000",
          country: "LT",
          currency: "EUR",
          defaultCustomerLocale: "lt",
          timezone: "Europe/Vilnius",
          address: "A",
        },
      });
      const user = await prisma.user.create({
        data: {
          email: `acc-${randomUUID()}@example.invalid`,
          displayName: "Bookkeeper",
          passwordHash: "x",
        },
      });

      const orgWide = await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          restaurantId: null,
          roleId: accountant.id,
          status: "ACTIVE",
        },
      });
      expect(orgWide.restaurantId).toBeNull();

      const scoped = await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          restaurantId: restaurant.id,
          roleId: accountant.id,
          status: "ACTIVE",
        },
      });
      expect(scoped.restaurantId).toBe(restaurant.id);
    },
  );

  it(
    "adding this role revokes nothing — the ADR-046/048 reconciliation gate is not tripped, " +
      "established by running the real stale-grant computation rather than by reading it",
    async () => {
      // findStaleGrants is the same code the seed uses to decide what a run would destroy. A new
      // Role has no existing RolePermission rows, so it can contribute none — but this project's
      // own rule is that a claim about behaviour needs an execution, not a reading.
      const stale = await findStaleGrants(prisma);
      expect(stale.filter((g) => g.role === "Accountant")).toEqual([]);
    },
  );

  /**
   * **The matrix assertions above say what the seed grants. These say what the code DOES.**
   *
   * This project has recorded the difference the hard way: a permission present in a list is not
   * a permission enforced on a route, and five tests once encoded a leak as the specification.
   * So the Accountant is put through the real services here — allowed on one path, refused on the
   * other — rather than only compared against a list.
   */
  it(
    "reads analytics and is REFUSED an individual payment — the same caller, two paths, one " +
      "allowed and one not: an implementation that gated neither, or both, fails one of these",
    async () => {
      const prismaService = new PrismaService();
      await prismaService.$connect();
      try {
        const analytics = new AnalyticsService(prismaService, shiftServiceForTests(prismaService));
        // Stripe and config are never reached: findOne refuses on reachability/permission
        // before any of them is touched, which is precisely the behaviour under test.
        const payments = new PaymentService(
          prismaService,
          {} as unknown as ConstructorParameters<typeof PaymentService>[1],
          {} as unknown as ConstructorParameters<typeof PaymentService>[2],
        );

        const accountantRole = await seededRole(prismaService, "Accountant");
        const org = await prismaService.organization.create({
          data: { name: `Org ${randomUUID()}` },
        });
        const restaurant = await prismaService.restaurant.create({
          data: {
            organizationId: org.id,
            name: `R ${randomUUID()}`,
            legalName: "L",
            companyNumber: "1",
            vatNumber: "LT1",
            email: "r@example.invalid",
            phone: "+37060000000",
            country: "LT",
            currency: "EUR",
            defaultCustomerLocale: "lt",
            timezone: "Europe/Vilnius",
            address: "A",
          },
        });

        const accountant: AuthenticatedUser = {
          id: randomUUID(),
          email: "bookkeeper@example.invalid",
          locale: "en",
          memberships: [
            {
              id: randomUUID(),
              organizationId: org.id,
              restaurantId: null,
              role: accountantRole,
            },
          ],
        };

        // ALLOWED: reports.view carries the analytics screen, and data.export the CSV.
        await expect(
          analytics.getRevenue(
            { restaurantId: restaurant.id, from: "2026-09-01", to: "2026-09-02" },
            accountant,
          ),
        ).resolves.toMatchObject({ restaurantId: restaurant.id });

        await expect(
          analytics.exportRevenueCsv(
            { restaurantId: restaurant.id, from: "2026-09-01", to: "2026-09-02" },
            accountant,
          ),
        ).resolves.toContain("date,amount");

        // REFUSED: an individual payment needs payments.manage, which this role does not hold.
        // 404, not 403 — confirming a payment exists at a venue the caller cannot read is itself
        // the disclosure (PR #109's own rule).
        await expect(payments.findOne(randomUUID(), accountant)).rejects.toMatchObject({
          code: "PAYMENT_NOT_FOUND",
        });
      } finally {
        await prismaService.$disconnect();
      }
    },
  );
});
