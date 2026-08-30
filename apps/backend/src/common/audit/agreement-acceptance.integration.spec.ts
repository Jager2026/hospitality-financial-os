import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * ADR-049's database constraints, exercised against the real database.
 *
 * The shape — two nullable subject columns and a type that says which one applies — is only a
 * convention until Postgres enforces it. These tests are the enforcement, written the same way as
 * `ledger-trigger.integration.spec.ts`: the rows are inserted directly through Prisma, deliberately
 * bypassing any application-layer validation, so the constraint is the only thing standing between
 * a wrong row and the table.
 */
describe("AgreementAcceptance constraints (real database)", () => {
  const prisma = new PrismaService();
  let userId: string;
  let restaurantId: string;

  beforeAll(async () => {
    await prisma.$connect();

    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        displayName: "Acceptance Test User",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    userId = user.id;

    const organization = await prisma.organization.create({
      data: { name: "Acceptance Test Org" },
    });
    const currency = await prisma.currency.findUniqueOrThrow({ where: { code: "EUR" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: organization.id,
        name: "Acceptance Test",
        legalName: "Acceptance Test UAB",
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
    restaurantId = restaurant.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("accepts the two shapes the design allows — without this, every rejection below could pass for the wrong reason", async () => {
    const platform = await prisma.agreementAcceptance.create({
      data: { agreement: "PLATFORM_TERMS", version: "2026-08-30", userId },
    });
    expect(platform.restaurantId).toBeNull();

    const stripe = await prisma.agreementAcceptance.create({
      data: { agreement: "STRIPE_CONNECTED_ACCOUNT", version: "2026-08-30", restaurantId },
    });
    expect(stripe.userId).toBeNull();
  });

  it("refuses platform terms accepted by a Restaurant — the subject is a person", async () => {
    await expect(
      prisma.agreementAcceptance.create({
        data: { agreement: "PLATFORM_TERMS", version: "2026-08-30", restaurantId },
      }),
    ).rejects.toThrow(/agreement_acceptance_subject_matches_type/);
  });

  it("refuses the Stripe agreement accepted by a User — the account holder is the business", async () => {
    await expect(
      prisma.agreementAcceptance.create({
        data: { agreement: "STRIPE_CONNECTED_ACCOUNT", version: "2026-08-30", userId },
      }),
    ).rejects.toThrow(/agreement_acceptance_subject_matches_type/);
  });

  it("refuses an acceptance with no subject at all", async () => {
    await expect(
      prisma.agreementAcceptance.create({
        data: { agreement: "PLATFORM_TERMS", version: "2026-08-30" },
      }),
    ).rejects.toThrow(/agreement_acceptance_subject_matches_type/);
  });

  it("refuses an acceptance carrying both subjects", async () => {
    await expect(
      prisma.agreementAcceptance.create({
        data: { agreement: "PLATFORM_TERMS", version: "2026-08-30", userId, restaurantId },
      }),
    ).rejects.toThrow(/agreement_acceptance_subject_matches_type/);
  });

  it("refuses a blank version — present but empty answers nothing", async () => {
    // The fourth appearance of "an empty string is a present value, not an absent one" in this
    // project (CLAUDE.md, Workspace Hygiene). NOT NULL is satisfied by "   " and the record would
    // then claim someone agreed to a revision it cannot name.
    await expect(
      prisma.agreementAcceptance.create({
        data: { agreement: "PLATFORM_TERMS", version: "   ", userId },
      }),
    ).rejects.toThrow(/agreement_acceptance_version_not_blank/);
  });
});
