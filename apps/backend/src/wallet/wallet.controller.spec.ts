import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import type { AppException } from "../common/exceptions/app.exception";
import { PrismaService } from "../prisma/prisma.service";
import { WalletController } from "./wallet.controller";
import { WalletProjectionService } from "./wallet-projection.service";
import { WalletService } from "./wallet.service";
import { seededRole } from "../../test/fixtures/authenticated-user";

// IMPLEMENTATION_PLAN.md Sprint 7: "Future Withdrawals Placeholder" — the two branches that live
// in the controller itself (own-wallet-only, then the honest "not built yet" response), not
// exercised by wallet.service.spec.ts.
describe("WalletController.requestWithdrawal (real database)", () => {
  const prisma = new PrismaService();
  let controller: WalletController;
  let walletProjection: WalletProjectionService;

  let waiterRole: Awaited<ReturnType<typeof seededRole>>;

  beforeAll(async () => {
    // The seeded Waiter really does hold no Permissions, so the literal this replaces was
    // correct — but correct by coincidence. Read from the seed, it cannot drift.
    waiterRole = await seededRole(prisma, "Waiter");
    await prisma.$connect();
    controller = new WalletController(new WalletService(prisma));
    walletProjection = new WalletProjectionService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedEarningWaiter(): Promise<{
    waiter: { id: string; organizationId: string; restaurantId: string | null };
    manager: { id: string; organizationId: string; restaurantId: string | null };
    walletId: string;
  }> {
    const org = await prisma.organization.create({
      data: { name: `Withdrawal Test Org ${randomUUID()}` },
    });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Withdrawal Test Restaurant",
        legalName: "Withdrawal Test Restaurant UAB",
        companyNumber: `WD-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000009",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
        stripeAccountId: `acct_fake_${randomUUID()}`,
      },
    });
    const waiterRole = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
    const managerRole = await prisma.role.findUniqueOrThrow({ where: { name: "Manager" } });
    const waiterUser = await prisma.user.create({
      data: {
        email: `waiter-${randomUUID()}@example.com`,
        displayName: "Test Waiter",
        passwordHash: "x",
        locale: "en",
      },
    });
    const managerUser = await prisma.user.create({
      data: {
        email: `manager-${randomUUID()}@example.com`,
        displayName: "Test Manager",
        passwordHash: "x",
        locale: "en",
      },
    });
    const waiter = await prisma.membership.create({
      data: {
        userId: waiterUser.id,
        organizationId: org.id,
        restaurantId: restaurant.id,
        roleId: waiterRole.id,
      },
    });
    const manager = await prisma.membership.create({
      data: {
        userId: managerUser.id,
        organizationId: org.id,
        restaurantId: restaurant.id,
        roleId: managerRole.id,
      },
    });

    const key = `withdrawal-test-key-${randomUUID()}`;
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
        restaurantId: restaurant.id,
        processor: "stripe",
        processorPaymentId: `pi_${randomUUID()}`,
        amount: 500n,
        tipAmount: 500n,
        waiterMembershipId: waiter.id,
        currency: "EUR",
        status: "SUCCEEDED",
        paymentMethod: "card",
        idempotencyKey: key,
      },
    });
    const transaction = await prisma.transaction.create({
      data: {
        paymentId: payment.id,
        restaurantId: restaurant.id,
        grossAmount: 500n,
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
          amount: 500n,
          currency: "EUR",
        },
        {
          journalEntryId: entry.id,
          account: "TIP_PAYABLE",
          direction: "CREDIT",
          amount: 500n,
          currency: "EUR",
          membershipId: waiter.id,
        },
      ],
    });
    const wallet = await walletProjection.recomputeBalance(waiter.id);
    return { waiter, manager, walletId: wallet!.id };
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
          role: waiterRole,
        },
      ],
    };
  }

  it("returns WITHDRAWAL_NOT_AVAILABLE (501) for the Wallet's own holder", async () => {
    const { waiter, walletId } = await seedEarningWaiter();

    let caught: unknown;
    try {
      await controller.requestWithdrawal(walletId, asUser(waiter));
    } catch (err) {
      caught = err;
    }
    expect((caught as AppException).code).toBe("WITHDRAWAL_NOT_AVAILABLE");
    expect((caught as AppException).getStatus()).toBe(501);
  });

  it("returns PERMISSION_DENIED for a Manager who can view but doesn't own the Wallet — reachability to view is not reachability to withdraw", async () => {
    const { manager, walletId } = await seedEarningWaiter();

    await expect(controller.requestWithdrawal(walletId, asUser(manager))).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });
});
