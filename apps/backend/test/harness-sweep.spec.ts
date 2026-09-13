import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepStuckTestPayments } from "./global-setup";

/**
 * ADR-086. The pre-run sweep deletes rows, so it gets the same scrutiny as anything else that does.
 *
 * **The discriminating pair is the second test, not the first.** A sweep that deletes every stuck
 * PENDING payment passes the first test trivially; what a sweep must never do is take a row with
 * financial history behind it, and only the second test rejects that implementation. The third
 * exists because the narrowing parameter (see `sweepStuckTestPayments`) cannot prove the
 * `status: "PENDING"` filter — a SUCCEEDED row of this spec's own proves it directly.
 */
describe("the harness sweep (ADR-086)", () => {
  const prisma = new PrismaClient();
  let restaurantId: string;

  beforeAll(async () => {
    await prisma.$connect();
    const org = await prisma.organization.create({ data: { name: "Harness Sweep Test Org" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Harness Sweep Test Restaurant",
        legalName: "Harness Sweep Test Restaurant UAB",
        companyNumber: `HS-${randomUUID()}`,
        vatNumber: `LTHS${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000010",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
        stripeAccountId: `acct_fake_${randomUUID()}`,
      },
    });
    restaurantId = restaurant.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedPayment(status: "PENDING" | "SUCCEEDED") {
    const key = `harness-sweep-${randomUUID()}`;
    await prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope: "/payments",
        requestFingerprint: "test",
        status: "COMPLETED",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return prisma.payment.create({
      data: {
        restaurantId,
        processor: "stripe",
        processorPaymentId: `pi_harness_sweep_${randomUUID()}`,
        amount: 1000n,
        tipAmount: 0n,
        currency: "EUR",
        status,
        paymentMethod: "card",
        idempotencyKey: key,
      },
    });
  }

  /** A Transaction over that Payment, with balanced Ledger lines when `withLedger` is set. */
  async function seedTransaction(paymentId: string, withLedger: boolean) {
    const transaction = await prisma.transaction.create({
      data: {
        paymentId,
        restaurantId,
        grossAmount: 1000n,
        currency: "EUR",
        status: "COMPLETED",
      },
    });
    if (withLedger) {
      // Balanced on purpose: `ledger_line_balanced` is a DEFERRED constraint, so an unbalanced pair
      // would not fail here — it would fail at COMMIT, after this helper had already returned.
      await prisma.journalEntry.create({
        data: {
          entryType: "PAYMENT_CAPTURED",
          transactionId: transaction.id,
          description: "harness sweep fixture",
          ledgerLines: {
            create: [
              { account: "PROCESSOR_CLEARING", direction: "DEBIT", amount: 1000n, currency: "EUR" },
              {
                account: "RESTAURANT_REVENUE_PAYABLE",
                direction: "CREDIT",
                amount: 1000n,
                currency: "EUR",
              },
            ],
          },
        },
      });
    }
    return transaction;
  }

  it("takes a stuck PENDING payment that has nothing behind it, and the Transaction shell of one that has no Ledger", async () => {
    const bare = await seedPayment("PENDING");
    const shell = await seedPayment("PENDING");
    const shellTransaction = await seedTransaction(shell.id, false);

    const result = await sweepStuckTestPayments(prisma, [bare.id, shell.id]);

    expect(result.swept).toBe(2);
    expect(result.kept).toBe(0);
    expect(await prisma.payment.findUnique({ where: { id: bare.id } })).toBeNull();
    expect(await prisma.payment.findUnique({ where: { id: shell.id } })).toBeNull();
    expect(
      await prisma.transaction.findUnique({ where: { id: shellTransaction.id } }),
      "the Transaction shell was orphaned rather than removed with its Payment",
    ).toBeNull();
  });

  it("REFUSES a stuck PENDING payment with a Ledger entry behind it — the half that rejects a sweep which simply deletes everything stuck", async () => {
    const withHistory = await seedPayment("PENDING");
    const transaction = await seedTransaction(withHistory.id, true);

    const result = await sweepStuckTestPayments(prisma, [withHistory.id]);

    expect(result.swept, "a payment with financial history behind it was deleted").toBe(0);
    expect(result.kept).toBe(1);
    expect(await prisma.payment.findUnique({ where: { id: withHistory.id } })).not.toBeNull();
    expect(await prisma.transaction.findUnique({ where: { id: transaction.id } })).not.toBeNull();
  });

  it("never considers a payment that is not PENDING — proves the status filter, which the narrowing parameter cannot", async () => {
    const succeeded = await seedPayment("SUCCEEDED");

    const result = await sweepStuckTestPayments(prisma, [succeeded.id]);

    expect(result.swept).toBe(0);
    expect(result.kept).toBe(0);
    expect(await prisma.payment.findUnique({ where: { id: succeeded.id } })).not.toBeNull();
  });
});
