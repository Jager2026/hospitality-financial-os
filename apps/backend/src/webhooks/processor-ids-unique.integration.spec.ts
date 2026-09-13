import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";
import { IndividualTipAllocationStrategy } from "../tip/individual-tip-allocation.strategy";
import { WebhooksService } from "./webhooks.service";
import { shiftServiceForTests } from "../../test/fixtures/shift-for-tests";

/**
 * ADR-089 — an identifier issued by Stripe names one thing.
 *
 * **The first test is a reproduced defect; the other two are assertions, and the file says which is
 * which.** Before the index, one `charge.dispute.created` delivered twice under two different event
 * ids produced two Chargeback rows and two CHARGEBACK journal entries — the same dispute debited
 * twice. Nothing caught it: the event-id claim sees two different ids, the refund path's
 * cumulative-amount guard has no counterpart here, the balance trigger checks that each entry
 * balances and knows nothing about whether another describes the same dispute, and reconciliation
 * selects `status = PENDING` while a disputed payment is SUCCEEDED.
 */
const SECRET = "whsec_test_fake_secret_for_signing_only";

const quietLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
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

describe("processor ids are unique (ADR-089)", { timeout: 30_000 }, () => {
  const prisma = new PrismaService();
  let webhooks: WebhooksService;
  let restaurantId: string;
  let organizationId: string;

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
      quietLogger,
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

    const org = await prisma.organization.create({ data: { name: "Processor Ids Unique Test" } });
    organizationId = org.id;
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId,
        name: "Processor Ids Unique Test",
        legalName: "Processor Ids Unique Test UAB",
        companyNumber: `PI-${randomUUID()}`,
        vatNumber: `LTPI${randomUUID()}`,
        email: `pi-${randomUUID()}@example.invalid`,
        phone: "+37060000014",
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

  // This block writes into the Ledger, so the teardown runs from the innermost row outwards.
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
      prisma.chargeback.deleteMany({ where: { transactionId: { in: txnIds } } }),
      prisma.refund.deleteMany({ where: { transactionId: { in: txnIds } } }),
      prisma.tip.deleteMany({ where: { transactionId: { in: txnIds } } }),
      prisma.transaction.deleteMany({ where: { id: { in: txnIds } } }),
      prisma.payment.deleteMany({ where: { id: { in: paymentIds } } }),
    ]);
    await prisma.shift.deleteMany({ where: { restaurantId } });
    await prisma.restaurant.delete({ where: { id: restaurantId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  /** A captured payment, so a dispute has something to land on. */
  async function capturedPayment(): Promise<{ paymentId: string; intentId: string }> {
    const key = `pi-unique-${randomUUID()}`;
    await prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope: "/payments",
        requestFingerprint: "test",
        status: "COMPLETED",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const intentId = `pi_unique_${randomUUID()}`;
    const payment = await prisma.payment.create({
      data: {
        restaurantId,
        processor: "stripe",
        processorPaymentId: intentId,
        amount: 1000n,
        tipAmount: 0n,
        currency: "EUR",
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey: key,
      },
    });
    const captured = sign(
      envelope(`evt_cap_${randomUUID()}`, "payment_intent.succeeded", {
        id: intentId,
        object: "payment_intent",
      }),
    );
    await webhooks.handleEvent(captured.rawBody, captured.signature);
    return { paymentId: payment.id, intentId };
  }

  it(
    "one dispute delivered twice is ACKNOWLEDGED the second time, leaving one Chargeback and one " +
      "entry — the handler recognises a dispute it already holds (ADR-090). Until then the second " +
      "delivery answered with an error, which stopped the duplicate and started a retry loop",
    async () => {
      const { paymentId, intentId } = await capturedPayment();
      const disputeId = `dp_unique_${randomUUID()}`;
      const secondEventId = `evt_dp_${randomUUID()}`;
      const dispute = (eventId: string) =>
        envelope(eventId, "charge.dispute.created", {
          id: disputeId,
          object: "dispute",
          payment_intent: intentId,
          amount: 600,
          reason: "fraudulent",
          evidence_details: { due_by: Math.floor(Date.now() / 1000) + 86_400 },
        });

      const first = sign(dispute(`evt_dp_${randomUUID()}`));
      await webhooks.handleEvent(first.rawBody, first.signature);

      const second = sign(dispute(secondEventId));
      await expect(
        webhooks.handleEvent(second.rawBody, second.signature),
        "the second delivery answered with an error, which is what Stripe retries for three days",
      ).resolves.toEqual({ received: true });

      const txn = await prisma.transaction.findUniqueOrThrow({ where: { paymentId } });
      expect(
        await prisma.chargeback.count({ where: { transactionId: txn.id } }),
        "one dispute produced two Chargeback rows",
      ).toBe(1);
      expect(
        await prisma.journalEntry.count({
          where: { transactionId: txn.id, entryType: "CHARGEBACK" },
        }),
        "one dispute was debited from the Ledger twice",
      ).toBe(1);

      // The claim of the second delivery is what actually ends the retry. `handleEvent` DELETES the
      // claim when dispatch throws — measured — so an erroring handler is re-claimed and re-run on
      // every retry. A COMPLETED claim is the difference between converging and looping.
      const claim = await prisma.idempotencyKey.findUnique({ where: { key: secondEventId } });
      expect(claim?.status, "the failed delivery's claim was deleted, so Stripe retries it").toBe(
        "COMPLETED",
      );
    },
  );

  it("refuses a second Payment carrying the same Stripe PaymentIntent id", async () => {
    const { intentId } = await capturedPayment();
    const key = `pi-unique-dup-${randomUUID()}`;
    await prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope: "/payments",
        requestFingerprint: "test",
        status: "COMPLETED",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    await expect(
      prisma.payment.create({
        data: {
          restaurantId,
          processor: "stripe",
          processorPaymentId: intentId,
          amount: 1000n,
          tipAmount: 0n,
          currency: "EUR",
          status: "PENDING",
          paymentMethod: "card",
          idempotencyKey: key,
        },
      }),
      "two Payment rows for one Stripe intent — `findFirst` in the capture path would pick one of them",
    ).rejects.toThrow(/processor_payment_id|Unique constraint/i);
  });

  it("refuses a second Refund carrying the same Stripe refund id", async () => {
    const { paymentId } = await capturedPayment();
    const txn = await prisma.transaction.findUniqueOrThrow({ where: { paymentId } });
    const refundId = `re_unique_${randomUUID()}`;
    const row = {
      transactionId: txn.id,
      processorRefundId: refundId,
      amount: 100n,
      currency: "EUR",
      reason: "requested_by_customer",
      tipRefunded: false,
    };
    await prisma.refund.create({ data: row });

    await expect(prisma.refund.create({ data: row })).rejects.toThrow(
      /processor_refund_id|Unique constraint/i,
    );
  });
});
