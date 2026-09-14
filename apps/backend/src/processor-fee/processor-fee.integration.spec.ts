import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermanentRejection } from "../common/errors/permanent-rejection";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";
import { IndividualTipAllocationStrategy } from "../tip/individual-tip-allocation.strategy";
import { TransactionService } from "../transaction/transaction.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { callerWithSeededRole } from "../../test/fixtures/authenticated-user";
import { shiftServiceForTests } from "../../test/fixtures/shift-for-tests";
import { processorFeeStatus } from "./processor-fee-status.util";
import {
  MAX_FEE_FETCH_ATTEMPTS,
  PROCESSOR_FEE_EVENT_TYPE,
  ProcessorFeeService,
} from "./processor-fee.service";

/**
 * ADR-094 — Stripe's processing fee enters the Ledger.
 *
 * **Each test names the implementation it rejects, and they are rejected in different words.** The
 * first fails if capture stops requesting the fee or the handler stops posting it; the second fails
 * if the claim is removed. A test whose two neutralisations produce the same message is a test of
 * their combination, not of either mechanism.
 *
 * Measured by actually removing each, not predicted:
 *
 * - **the fetch removed** (capture stops writing the request) — `capture did not request this
 *   payment's processing fee: expected [] to have a length of 1`, and **five of five tests fail**,
 *   the other four with `Cannot read properties of undefined` because there is no event to hand
 *   the handler at all;
 * - **the claim removed** (the conditional update made unconditional) — `the same fee was debited
 *   twice: expected 126n to be 63n`, and **exactly one test fails**.
 *
 * Neither message could be mistaken for the other, and the number of casualties differs too, which
 * is the second signal that the two mechanisms are being checked separately rather than together.
 *
 * The abandonment chain is covered in two halves rather than end to end: this file proves the
 * handler raises `PermanentRejection` at its attempt limit, and `outbox-poller.service.spec.ts`
 * already proves the poller abandons on exactly that (ADR-085). The third UI state is proved here
 * against a row in the state abandonment leaves behind.
 */
const SECRET = "whsec_test_fake_secret_for_signing_only";

const quiet = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function sign(payload: object): { rawBody: Buffer; signature: string } {
  const raw = JSON.stringify(payload);
  return {
    rawBody: Buffer.from(raw),
    signature: Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: SECRET }),
  };
}

function envelope(id: string, type: string, object: Record<string, unknown>) {
  return {
    id,
    object: "event",
    type,
    data: { object },
    api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
  };
}

type FeeReply = { balanceTransactionId: string; fee: bigint; currency: string } | null;

describe("the processing fee enters the Ledger (ADR-094)", { timeout: 30_000 }, () => {
  const prisma = new PrismaService();
  let webhooks: WebhooksService;
  let transactions: TransactionService;
  let restaurantId: string;
  let organizationId: string;
  let membershipId: string;
  let userId: string;
  let feeReply: FeeReply = null;
  // The caller comes from the SEED, never from a literal: a hand-written "Owner" carrying an
  // invented permission list is precisely the fixture class repo-invariants.spec.ts refuses — and
  // it refused this one, on its first full-suite run.
  let owner: Awaited<ReturnType<typeof callerWithSeededRole>>;

  /** Rebuilt per test so each one states the Stripe answer it is about. */
  function feeService(): ProcessorFeeService {
    return new ProcessorFeeService(
      prisma,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { retrieveProcessingFee: async () => feeReply } as any,
      new LedgerService(prisma, shiftServiceForTests(prisma)),
      quiet,
    );
  }

  beforeAll(async () => {
    await prisma.$connect();
    const stripe = new StripeService(
      {
        getOrThrow: (k: string) =>
          k === "STRIPE_WEBHOOK_SECRET" ? SECRET : k === "NODE_ENV" ? "test" : "sk_test_fake",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { sendAlert: async () => undefined } as any,
      quiet,
    );
    webhooks = new WebhooksService(
      prisma,
      stripe,
      new LedgerService(prisma, shiftServiceForTests(prisma)),
      {} as RestaurantService,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { getOrThrow: () => 100 } as any,
      new IndividualTipAllocationStrategy(),
    );
    transactions = new TransactionService(prisma);

    const org = await prisma.organization.create({ data: { name: "Processor Fee Test" } });
    organizationId = org.id;
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId,
        name: "Processor Fee Test",
        legalName: "Processor Fee Test UAB",
        companyNumber: `PF-${randomUUID()}`,
        vatNumber: `LTPF${randomUUID()}`,
        email: `pf-${randomUUID()}@example.invalid`,
        phone: "+37060000017",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
        stripeAccountId: `acct_fake_${randomUUID()}`,
      },
    });
    restaurantId = restaurant.id;
    const waiterRole = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
    const user = await prisma.user.create({
      data: {
        email: `pf-waiter-${randomUUID()}@example.invalid`,
        displayName: "Fee Test Waiter",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    userId = user.id;
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId, restaurantId, roleId: waiterRole.id },
    });
    membershipId = membership.id;

    owner = await callerWithSeededRole(prisma, {
      roleName: "Owner",
      organizationId,
      restaurantId,
      userId,
      membershipId,
    });
  });

  afterAll(async () => {
    const payments = await prisma.payment.findMany({
      where: { restaurantId },
      select: { id: true },
    });
    const paymentIds = payments.map((p) => p.id);
    const txns = await prisma.transaction.findMany({
      where: { paymentId: { in: paymentIds } },
      select: { id: true },
    });
    const txnIds = txns.map((t) => t.id);
    const entries = await prisma.journalEntry.findMany({
      where: { transactionId: { in: txnIds } },
      select: { id: true },
    });
    await prisma.$transaction([
      prisma.ledgerLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } }),
      prisma.journalEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } }),
      prisma.tip.deleteMany({ where: { transactionId: { in: txnIds } } }),
      prisma.transaction.deleteMany({ where: { id: { in: txnIds } } }),
      prisma.payment.deleteMany({ where: { id: { in: paymentIds } } }),
    ]);
    // ADR-086's lesson applied to this file's own rows — and the FIRST version of this teardown
    // got the verb wrong. These OutboxEvents refer to JournalEntry rows that no longer exist, so a
    // queued one takes a slot in the poller's batch forever (OC-10, measured). But **deleting** them
    // yanked rows out from under a poller that had already selected them in another worker:
    // `Record to update not found` in `OutboxPollerService.dispatch`, in the same run.
    //
    // Mark, never delete — the rule ADR-075 and ADR-086 already state, broken here by the session
    // that had just written it down. An abandoned row leaves the queue and stays readable, and a
    // concurrent poller that already holds it simply finds nothing to do.
    await prisma.outboxEvent.updateMany({
      where: {
        aggregateId: { in: [...paymentIds, ...entries.map((e) => e.id)] },
        publishedAt: null,
        abandonedAt: null,
      },
      data: {
        abandonedAt: new Date(),
        abandonedReason: "Left by processor-fee.integration.spec.ts — its Ledger rows are gone.",
      },
    });
    await prisma.shift.deleteMany({ where: { restaurantId } });
    // The Wallet is not written by this file: a poller in ANOTHER worker picks up the
    // `journal_entry.tip_allocated` event these captures produce and projects it (ADR-024). It
    // exists or it does not depending on timing, which is exactly why the teardown deletes by
    // membership rather than asserting anything about it.
    await prisma.wallet.deleteMany({ where: { membershipId } });
    await prisma.membership.delete({ where: { id: membershipId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.restaurant.delete({ where: { id: restaurantId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  /** A captured payment, through the real webhook path, so the fee request is produced the way
   *  production produces it rather than inserted by the test. */
  async function capturedPayment(): Promise<{ paymentId: string; transactionId: string }> {
    const key = `pf-${randomUUID()}`;
    await prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope: "/payments",
        requestFingerprint: "test",
        status: "COMPLETED",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const intentId = `pi_fee_${randomUUID()}`;
    const payment = await prisma.payment.create({
      data: {
        restaurantId,
        processor: "stripe",
        processorPaymentId: intentId,
        amount: 1200n,
        tipAmount: 200n,
        currency: "EUR",
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey: key,
        waiterMembershipId: membershipId,
      },
    });
    const captured = sign(
      envelope(`evt_fee_${randomUUID()}`, "payment_intent.succeeded", {
        id: intentId,
        object: "payment_intent",
      }),
    );
    await webhooks.handleEvent(captured.rawBody, captured.signature);
    const txn = await prisma.transaction.findUniqueOrThrow({ where: { paymentId: payment.id } });
    return { paymentId: payment.id, transactionId: txn.id };
  }

  async function feeEventFor(paymentId: string) {
    const rows = await prisma.outboxEvent.findMany({
      where: { eventType: PROCESSOR_FEE_EVENT_TYPE, aggregateId: paymentId },
    });
    return rows;
  }

  it(
    "capture asks for the fee, and the handler posts it as a second entry — the screen stops " +
      "saying 'not available' and says the number",
    async () => {
      const { paymentId, transactionId } = await capturedPayment();

      const events = await feeEventFor(paymentId);
      expect(events, "capture did not request this payment's processing fee").toHaveLength(1);

      feeReply = { balanceTransactionId: `txn_${randomUUID()}`, fee: 63n, currency: "EUR" };
      await feeService().handle(events[0]);

      const entries = await prisma.journalEntry.findMany({
        where: { transactionId, entryType: "PROCESSOR_FEE" },
        include: { ledgerLines: true },
      });
      expect(entries, "the processing fee was not posted to the Ledger").toHaveLength(1);
      const debit = entries[0].ledgerLines.find((l) => l.account === "PROCESSOR_FEE");
      const credit = entries[0].ledgerLines.find((l) => l.account === "PROCESSOR_CLEARING");
      expect(debit?.direction).toBe("DEBIT");
      expect(debit?.amount).toBe(63n);
      expect(credit?.direction).toBe("CREDIT");
      expect(credit?.amount).toBe(63n);

      // The capture entry is untouched: a second entry, never a correction of the first (ADR-002).
      const captureEntry = await prisma.journalEntry.findFirstOrThrow({
        where: { transactionId, entryType: "PAYMENT_CAPTURED" },
        include: { ledgerLines: true },
      });
      expect(
        captureEntry.ledgerLines.find((l) => l.account === "PROCESSOR_CLEARING")?.amount,
        "the capture entry was edited instead of a second entry being posted",
      ).toBe(1200n);

      const detail = await transactions.findOne(transactionId, owner);
      expect(detail.processingFee).toBe("63");
      expect(detail.processingFeeStatus).toBe("available");

      const published = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: events[0].id } });
      expect(published.publishedAt, "the fee request was left in the queue").not.toBeNull();
    },
  );

  it("the same fee request delivered twice debits the Ledger once — the claim, not the trigger", async () => {
    const { paymentId, transactionId } = await capturedPayment();
    const [event] = await feeEventFor(paymentId);

    feeReply = { balanceTransactionId: `txn_${randomUUID()}`, fee: 63n, currency: "EUR" };
    await feeService().handle(event);

    // A redelivery: the poller re-reads the row, so the second call sees it exactly as the first
    // did apart from publishedAt, which the poller's own claim step does not guarantee (ADR-090).
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: null } });
    await feeService().handle({ ...event, publishedAt: null });

    const lines = await prisma.ledgerLine.findMany({
      where: {
        journalEntry: { transactionId, entryType: "PROCESSOR_FEE" },
        account: "PROCESSOR_FEE",
      },
    });
    const total = lines.reduce((sum, l) => sum + l.amount, 0n);
    expect(
      total,
      "the same fee was debited twice — the balance trigger cannot see a duplicate",
    ).toBe(63n);
    expect(lines).toHaveLength(1);
  });

  it(
    "a BalanceTransaction that is not published yet is a RETRY, not a failure — nothing is " +
      "written and no zero is invented",
    async () => {
      const { paymentId, transactionId } = await capturedPayment();
      const [event] = await feeEventFor(paymentId);

      feeReply = null;
      await expect(
        feeService().handle({ ...event, attempts: 0 }),
        "'not yet' was concluded instead of retried",
      ).rejects.toThrow(/not published yet/);

      const entries = await prisma.journalEntry.count({
        where: { transactionId, entryType: "PROCESSOR_FEE" },
      });
      expect(entries, "an entry was posted for a fee nobody has read").toBe(0);

      const txn = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(txn.processorFeeBalanceTxnId, "the fee was claimed without being known").toBeNull();

      const stillQueued = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(stillQueued.publishedAt, "the request was marked done with nothing done").toBeNull();

      const detail = await transactions.findOne(transactionId, owner);
      expect(detail.processingFee, "a fee of 0 was invented for an unknown amount").toBeNull();
      expect(detail.processingFeeStatus).toBe("pending");
    },
  );

  it(
    "after the attempt limit it becomes a PermanentRejection, and the screen says 'never' rather " +
      "than 'not yet'",
    async () => {
      const { paymentId, transactionId } = await capturedPayment();
      const [event] = await feeEventFor(paymentId);

      feeReply = null;
      await expect(
        feeService().handle({ ...event, attempts: MAX_FEE_FETCH_ATTEMPTS - 1 }),
        "the limit was not reached, so this would retry forever",
      ).rejects.toBeInstanceOf(PermanentRejection);

      // The state the poller's abandonment leaves behind (ADR-085), asserted here rather than
      // re-proved: outbox-poller.service.spec.ts already covers abandon-on-PermanentRejection.
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { abandonedAt: new Date(), abandonedReason: "test" },
      });

      const txn = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      expect(await processorFeeStatus(prisma, txn)).toBe("unavailable");

      const detail = await transactions.findOne(transactionId, owner);
      expect(detail.processingFee).toBeNull();
      expect(
        detail.processingFeeStatus,
        "a fee that will never arrive looked exactly like one still on its way",
      ).toBe("unavailable");
    },
  );

  it("a settlement currency other than the payment's is refused rather than posted", async () => {
    const { paymentId, transactionId } = await capturedPayment();
    const [event] = await feeEventFor(paymentId);

    feeReply = { balanceTransactionId: `txn_${randomUUID()}`, fee: 55n, currency: "USD" };
    await expect(feeService().handle(event)).rejects.toBeInstanceOf(PermanentRejection);

    const entries = await prisma.journalEntry.count({
      where: { transactionId, entryType: "PROCESSOR_FEE" },
    });
    expect(entries, "a USD fee was posted against an EUR transaction").toBe(0);
  });
});
