import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { WalletProjectionService } from "./wallet-projection.service";
import { WalletService } from "./wallet.service";

describe("WalletService (real database)", () => {
  const prisma = new PrismaService();
  let walletService: WalletService;
  let walletProjection: WalletProjectionService;

  beforeAll(async () => {
    await prisma.$connect();
    walletService = new WalletService(prisma);
    walletProjection = new WalletProjectionService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedOrgRestaurant(name: string) {
    const org = await prisma.organization.create({ data: { name: `${name} Org` } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name,
        legalName: `${name} UAB`,
        companyNumber: `WS-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000008",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
        stripeAccountId: `acct_fake_${randomUUID()}`,
      },
    });
    return { org, restaurant };
  }

  async function seedMembership(
    organizationId: string,
    restaurantId: string | null,
    roleName: "Waiter" | "Manager" | "Owner",
  ) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    const user = await prisma.user.create({
      data: {
        email: `member-${randomUUID()}@example.com`,
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    return prisma.membership.create({
      data: { userId: user.id, organizationId, restaurantId, roleId: role.id },
    });
  }

  async function giveEarnings(membershipId: string, restaurantId: string, amount: bigint) {
    const key = `wallet-service-test-key-${randomUUID()}`;
    await prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope: "/payments",
        requestFingerprint: "test",
        status: "COMPLETED",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const payment = await prisma.payment.create({
      data: {
        restaurantId,
        processor: "stripe",
        processorPaymentId: `pi_${randomUUID()}`,
        amount,
        tipAmount: amount,
        waiterMembershipId: membershipId,
        currency: "EUR",
        status: "SUCCEEDED",
        paymentMethod: "card",
        idempotencyKey: key,
      },
    });
    const transaction = await prisma.transaction.create({
      data: {
        paymentId: payment.id,
        restaurantId,
        grossAmount: amount,
        currency: "EUR",
        status: "COMPLETED",
      },
    });
    const entry = await prisma.journalEntry.create({
      data: { entryType: "TIP_ALLOCATED", transactionId: transaction.id },
    });
    await prisma.ledgerLine.createMany({
      data: [
        {
          journalEntryId: entry.id,
          account: "TIP_PAYABLE",
          direction: "DEBIT",
          amount,
          currency: "EUR",
        },
        {
          journalEntryId: entry.id,
          account: "TIP_PAYABLE",
          direction: "CREDIT",
          amount,
          currency: "EUR",
          membershipId,
        },
      ],
    });
    return walletProjection.recomputeBalance(membershipId);
  }

  function asUser(membership: {
    id: string;
    organizationId: string;
    restaurantId: string | null;
  }): AuthenticatedUser {
    return {
      id: randomUUID(),
      email: "test@example.com",
      locale: "en",
      memberships: [
        {
          id: membership.id,
          organizationId: membership.organizationId,
          restaurantId: membership.restaurantId,
          role: { id: randomUUID(), name: "Waiter", permissions: [] },
        },
      ],
    };
  }

  it("findMine returns only the caller's own Wallets, not anyone else's", async () => {
    const { org, restaurant } = await seedOrgRestaurant("FindMine Test");
    const waiter = await seedMembership(org.id, restaurant.id, "Waiter");
    const otherWaiter = await seedMembership(org.id, restaurant.id, "Waiter");
    await giveEarnings(waiter.id, restaurant.id, 400n);
    await giveEarnings(otherWaiter.id, restaurant.id, 900n);

    const results = await walletService.findMine(asUser(waiter));

    expect(results).toHaveLength(1);
    expect(results[0].membershipId).toBe(waiter.id);
    expect(results[0].availableBalance).toBe("400");
    expect(results[0].restaurantName).toBe("FindMine Test");
  });

  it("findOne: a Manager reachable to the same Restaurant can view a Waiter's Wallet (Employee Details, UX_MAP.md)", async () => {
    const { org, restaurant } = await seedOrgRestaurant("Reachable Test");
    const waiter = await seedMembership(org.id, restaurant.id, "Waiter");
    const manager = await seedMembership(org.id, restaurant.id, "Manager");
    const wallet = await giveEarnings(waiter.id, restaurant.id, 250n);

    const result = await walletService.findOne(wallet!.id, asUser(manager));
    expect(result.membershipId).toBe(waiter.id);
  });

  it("findOne: an org-wide Membership reaches a Wallet at any Restaurant in the same Organization", async () => {
    const { org, restaurant } = await seedOrgRestaurant("Org Wide Reach Test");
    const waiter = await seedMembership(org.id, restaurant.id, "Waiter");
    const owner = await seedMembership(org.id, null, "Owner"); // org-wide
    const wallet = await giveEarnings(waiter.id, restaurant.id, 150n);

    const result = await walletService.findOne(wallet!.id, asUser(owner));
    expect(result.membershipId).toBe(waiter.id);
  });

  it("findOne: a completely unrelated Membership (different Organization) cannot reach the Wallet", async () => {
    const { org: orgA, restaurant: restaurantA } = await seedOrgRestaurant("Isolation Test A");
    const { org: orgB } = await seedOrgRestaurant("Isolation Test B");
    const waiter = await seedMembership(orgA.id, restaurantA.id, "Waiter");
    const strangerOwner = await seedMembership(orgB.id, null, "Owner");
    const wallet = await giveEarnings(waiter.id, restaurantA.id, 600n);

    await expect(walletService.findOne(wallet!.id, asUser(strangerOwner))).rejects.toMatchObject({
      code: "WALLET_NOT_FOUND",
    });
  });

  it("findOne: an org-wide Wallet's own holder is the ONLY one who can reach it — never widened to any org-wide Membership (the exact bug shape CLAUDE_RULES.md flags)", async () => {
    const { org, restaurant } = await seedOrgRestaurant("Org Wide Wallet Test");
    const orgWideEarner = await seedMembership(org.id, null, "Owner"); // took a payment personally
    const otherOrgWideMembership = await seedMembership(org.id, null, "Owner"); // a second org-wide Owner, same org
    const wallet = await giveEarnings(orgWideEarner.id, restaurant.id, 800n);

    // Owns it — reachable.
    const own = await walletService.findOne(wallet!.id, asUser(orgWideEarner));
    expect(own.membershipId).toBe(orgWideEarner.id);

    // A second org-wide Membership in the SAME Organization — NOT reachable, since the Wallet's
    // own Membership has no Restaurant to check reachability against.
    await expect(
      walletService.findOne(wallet!.id, asUser(otherOrgWideMembership)),
    ).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
  });

  it("findTransactions returns Ledger-derived entries for this Wallet only", async () => {
    const { org, restaurant } = await seedOrgRestaurant("Transactions Test");
    const waiter = await seedMembership(org.id, restaurant.id, "Waiter");
    const wallet = await giveEarnings(waiter.id, restaurant.id, 350n);

    const entries = await walletService.findTransactions(wallet!.id, asUser(waiter));

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.amount === "350")).toBe(true);
    expect(entries.some((e) => e.direction === "CREDIT")).toBe(true);
  });

  it("findOne throws WALLET_NOT_FOUND for a nonexistent id", async () => {
    const { org, restaurant } = await seedOrgRestaurant("Not Found Test");
    const waiter = await seedMembership(org.id, restaurant.id, "Waiter");

    await expect(walletService.findOne(randomUUID(), asUser(waiter))).rejects.toMatchObject({
      code: "WALLET_NOT_FOUND",
    });
  });
});
