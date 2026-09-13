import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concludeUndeliverableEmails, sweepStuckTestPayments } from "./global-setup";

/** This file owns every row created under this name — see the teardown. */
const FIXTURE_RESTAURANT = "Harness Sweep Test Restaurant";

/**
 * ADR-086. The pre-run sweep deletes rows, so it gets the same scrutiny as anything else that does.
 *
 * Six tests, and **two of them are the ones that matter** — each is the half that rejects a lazier
 * implementation of its own mechanism:
 *
 *   - *REFUSES a PENDING payment with a Ledger entry behind it.* A sweep that simply deletes
 *     everything stuck passes the first test and fails this one.
 *   - *REFUSES a money event of the same age.* A conclusion rule written as "abandon what has not
 *     published" passes the email test and fails this one — and the damage would be a Wallet left
 *     permanently wrong rather than an email not sent, which is ADR-075's own asymmetry.
 *
 * The `SUCCEEDED` case exists because the narrowing parameter (see `sweepStuckTestPayments`) cannot
 * prove the `status: "PENDING"` filter; a SUCCEEDED row of this spec's own proves it directly.
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
        name: FIXTURE_RESTAURANT,
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

  // The one thing this spec MUST clean up itself, and the reason is the sweep working correctly.
  //
  // Its second test seeds a PENDING payment with a JournalEntry behind it precisely so the sweep
  // refuses to take it — which means the next run's sweep will refuse it too, and the run after
  // that. Left alone it would add exactly one un-sweepable row per run: the accumulation ADR-086
  // was written to end, reintroduced by ADR-086's own test. Caught by reading the line the sweep
  // prints ("kept 1 with a Ledger entry ..."), not by a failure.
  //
  // So the division is: the harness owns every row it can recognise as litter, and the one row it
  // is right to refuse belongs to whoever deliberately made it un-refusable.
  //
  // Scoped to this fixture's own restaurant NAME rather than to this run's id, deliberately: a run
  // that was killed before reaching here left rows nothing else can ever remove, and matching the
  // name lets the next run clear them. It is not a global matcher — the name belongs to this file
  // and nothing else creates it.
  afterAll(async () => {
    const mine = await prisma.payment.findMany({
      where: { restaurant: { name: FIXTURE_RESTAURANT } },
      select: { id: true, idempotencyKey: true, transaction: { select: { id: true } } },
    });
    const transactionIds = mine
      .map((p) => p.transaction?.id)
      .filter((id): id is string => id !== undefined);
    const entries = await prisma.journalEntry.findMany({
      where: { transactionId: { in: transactionIds } },
      select: { id: true },
    });

    // Innermost first, the foreign keys decide the order: LedgerLine -> JournalEntry ->
    // Transaction -> Payment -> IdempotencyKey. Removing every line of an entry leaves it balanced
    // at zero, so the deferred `ledger_line_balanced` constraint has nothing to object to.
    await prisma.$transaction([
      prisma.ledgerLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } }),
      prisma.journalEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } }),
      prisma.transaction.deleteMany({ where: { id: { in: transactionIds } } }),
      prisma.payment.deleteMany({ where: { id: { in: mine.map((p) => p.id) } } }),
      prisma.idempotencyKey.deleteMany({
        where: { key: { in: mine.map((p) => p.idempotencyKey) } },
      }),
    ]);

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

  async function seedOutboxEvent(eventType: string) {
    return prisma.outboxEvent.create({
      data: {
        aggregateType: "HarnessSweepFixture",
        aggregateId: randomUUID(),
        eventType,
        payload: { to: "nobody@example.invalid", subject: "s", text: "t" },
      },
    });
  }

  it("concludes an unpublished email event, keeping the row and recording why — it is marked, never deleted, because the row is the trace of a send that was decided on (ADR-075)", async () => {
    const email = await seedOutboxEvent("email.send_requested");

    const concluded = await concludeUndeliverableEmails(prisma, [email.id]);

    expect(concluded).toBe(1);
    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: email.id } });
    expect(after.abandonedAt, "an undeliverable email event was left in the queue").not.toBeNull();
    expect(after.abandonedReason).toContain("outside production");
    expect(
      after.publishedAt,
      "an abandoned event must never be marked published — it was not sent",
    ).toBeNull();
  });

  it("REFUSES a money event of the same age — the discriminating pair: the rule is about what THIS ENVIRONMENT can send, and a journal-entry projection has nothing to do with an email provider", async () => {
    const money = await seedOutboxEvent("journal_entry.payment_captured");

    const concluded = await concludeUndeliverableEmails(prisma, [money.id]);

    expect(concluded, "a money projection was concluded by a rule about email").toBe(0);
    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: money.id } });
    expect(after.abandonedAt).toBeNull();
    await prisma.outboxEvent.delete({ where: { id: money.id } });
  });

  it("redacts the body of every email event it concludes, and leaves the recipient alone — the conclusion takes the event out of the poller for good, so this is the last chance ADR-075 gets", async () => {
    const live = await prisma.outboxEvent.create({
      data: {
        aggregateType: "HarnessSweepFixture",
        aggregateId: randomUUID(),
        eventType: "email.send_requested",
        payload: {
          to: "someone@example.invalid",
          subject: "You have been invited",
          text: "https://app.example/accept?token=a-real-looking-credential",
        },
      },
    });

    await concludeUndeliverableEmails(prisma, [live.id]);

    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: live.id } });
    const payload = after.payload as { to: string; text: string };
    expect(
      payload.text,
      "an invitation body — address and a live token — was kept forever by a cleanup meant to tidy up",
    ).not.toContain("token=");
    expect(
      payload.to,
      "the redaction rewrote the recipient, which would undo an erasure that had already tombstoned it",
    ).toBe("someone@example.invalid");
    await prisma.outboxEvent.delete({ where: { id: live.id } });
  });
});
