import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  ProcessorFeeService,
  PROCESSOR_FEE_EVENT_TYPE,
} from "../processor-fee/processor-fee.service";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { StripeService } from "../stripe/stripe.service";
import { IndividualTipAllocationStrategy } from "../tip/individual-tip-allocation.strategy";
import { WebhooksService } from "../webhooks/webhooks.service";
import { shiftServiceForTests } from "../../test/fixtures/shift-for-tests";
import { ShiftCloseSummaryService } from "./shift-close-summary.service";

/**
 * ADR-096 — the shift close answers the money question.
 *
 * **The discriminating pair, and the two halves fail in different words.**
 *
 * Measured by actually removing each, not predicted:
 *
 * - *stop storing the date* (drop `fundsAvailableOn` from the claim) — `the date list is empty:
 *   expected [] to have a length of 1`, and **three of three tests fail**, because every
 *   transaction falls into `unresolved` and no row can be grouped;
 * - *report an unknown fee as a number* — `a fee nobody has read was reported as a number:
 *   expected '195' to be null`, and **exactly one test fails**.
 *
 * Different words and different casualty counts: one neutralisation is about a missing date, the
 * other about a number invented for an unknown.
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

type FeeReply = {
  balanceTransactionId: string;
  fee: bigint;
  currency: string;
  availableOn: Date;
} | null;

describe("what a shift close answers (ADR-096)", { timeout: 30_000 }, () => {
  const prisma = new PrismaService();
  let webhooks: WebhooksService;
  let summaries: ShiftCloseSummaryService;
  let restaurantId: string;
  let organizationId: string;
  let membershipId: string;
  let userId: string;
  let feeReply: FeeReply = null;

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
    summaries = new ShiftCloseSummaryService(prisma);

    const org = await prisma.organization.create({ data: { name: "Shift Close Summary Test" } });
    organizationId = org.id;
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId,
        name: "Shift Close Summary Test",
        legalName: "Shift Close Summary UAB",
        companyNumber: `SC-${randomUUID()}`,
        vatNumber: `LTSC${randomUUID()}`,
        email: `sc-${randomUUID()}@example.invalid`,
        phone: "+37060000018",
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
        email: `sc-waiter-${randomUUID()}@example.invalid`,
        displayName: "Summary Test Waiter",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    userId = user.id;
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId, restaurantId, roleId: waiterRole.id },
    });
    membershipId = membership.id;
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
    // Marked, never deleted — a poller in another worker may already hold one of these rows.
    await prisma.outboxEvent.updateMany({
      where: {
        aggregateId: { in: [...paymentIds, ...entries.map((e) => e.id)] },
        publishedAt: null,
        abandonedAt: null,
      },
      data: {
        abandonedAt: new Date(),
        abandonedReason:
          "Left by shift-close-summary.integration.spec.ts — its Ledger rows are gone.",
      },
    });
    await prisma.wallet.deleteMany({ where: { membershipId } });
    await prisma.shift.deleteMany({ where: { restaurantId } });
    await prisma.membership.delete({ where: { id: membershipId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.restaurant.delete({ where: { id: restaurantId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  async function capture(
    bill: bigint,
    tip: bigint,
  ): Promise<{ paymentId: string; transactionId: string }> {
    const key = `sc-${randomUUID()}`;
    await prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope: "/payments",
        requestFingerprint: "test",
        status: "COMPLETED",
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const intentId = `pi_sc_${randomUUID()}`;
    const payment = await prisma.payment.create({
      data: {
        restaurantId,
        processor: "stripe",
        processorPaymentId: intentId,
        amount: bill + tip,
        tipAmount: tip,
        currency: "EUR",
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey: key,
        waiterMembershipId: membershipId,
      },
    });
    const captured = sign(
      envelope(`evt_sc_${randomUUID()}`, "payment_intent.succeeded", {
        id: intentId,
        object: "payment_intent",
      }),
    );
    await webhooks.handleEvent(captured.rawBody, captured.signature);
    const txn = await prisma.transaction.findUniqueOrThrow({ where: { paymentId: payment.id } });
    return { paymentId: payment.id, transactionId: txn.id };
  }

  async function postFee(paymentId: string, fee: bigint, availableOn: Date): Promise<void> {
    const [event] = await prisma.outboxEvent.findMany({
      where: { eventType: PROCESSOR_FEE_EVENT_TYPE, aggregateId: paymentId },
    });
    feeReply = {
      balanceTransactionId: `txn_${randomUUID()}`,
      fee,
      currency: "EUR",
      availableOn,
    };
    await feeService().handle(event);
  }

  /** The Shift every posting of this file landed in — resolved the way the Ledger resolves it. */
  async function currentShiftId(): Promise<string> {
    const shift = await prisma.shift.findFirstOrThrow({
      where: { restaurantId },
      orderBy: { openedAt: "desc" },
    });
    return shift.id;
  }

  it("answers gross, tips, both deductions, net and a DATED list — the whole question in one object", async () => {
    const availableOn = new Date(Date.UTC(2026, 8, 22, 0, 0, 0));
    const a = await capture(1000n, 200n);
    const b = await capture(2000n, 0n);
    await postFee(a.paymentId, 57n, availableOn);
    await postFee(b.paymentId, 88n, availableOn);

    const summary = await summaries.summarise(await currentShiftId());

    expect(summary.grossRevenue, "the bill, before any deduction").toEqual({
      amount: "3000",
      state: "available",
    });
    expect(summary.tips, "a tip is the staff's, not the venue's").toEqual({
      amount: "200",
      state: "available",
    });

    const stripeFee = summary.deductions.find((d) => d.kind === "stripe_processing");
    const platformFee = summary.deductions.find((d) => d.kind === "platform_fee");
    expect(stripeFee, "Stripe's own fee, from the Ledger rather than a rate of ours").toEqual({
      kind: "stripe_processing",
      amount: "145",
      state: "available",
    });
    expect(platformFee?.amount, "1% of the 3000 bill").toBe("30");

    expect(summary.netToVenue, "gross less both deductions").toEqual({
      amount: "2825",
      state: "available",
    });

    expect(
      summary.availability.rows,
      "the date list is empty — nothing stored available_on",
    ).toHaveLength(1);
    expect(summary.availability.rows[0].availableOn).toBe(availableOn.toISOString());
    // 1200 + 2000 charged, less 57 + 88 of Stripe's fee.
    expect(summary.availability.rows[0].amount).toBe("3055");
    expect(summary.availability.rows[0].transactions).toBe(2);
    expect(summary.availability.unresolved).toBe(0);
    expect(summary.availability.state).toBe("available");
  });

  it(
    "a payment whose fee has not arrived leaves the amount NULL and the state pending — a zero " +
      "would be a number nobody has read",
    async () => {
      const availableOn = new Date(Date.UTC(2026, 8, 23, 0, 0, 0));
      const settled = await capture(1000n, 0n);
      await postFee(settled.paymentId, 50n, availableOn);
      // The second payment's fetch is still queued: captured, never handled.
      await capture(500n, 0n);

      const summary = await summaries.summarise(await currentShiftId());

      const stripeFee = summary.deductions.find((d) => d.kind === "stripe_processing");
      expect(stripeFee?.state, "one transaction is still waiting on Stripe").toBe("pending");
      expect(stripeFee?.amount, "a fee nobody has read was reported as a number").toBeNull();
      expect(summary.netToVenue.amount, "a net built on an unknown deduction").toBeNull();
      expect(summary.netToVenue.state).toBe("pending");
      expect(summary.availability.unresolved, "the unread transaction is counted, not hidden").toBe(
        1,
      );
      expect(summary.availability.state).toBe("pending");

      // And the half that IS known stays known: gross and tips never depended on Stripe.
      expect(summary.grossRevenue.state).toBe("available");
      expect(summary.tips.state).toBe("available");
    },
  );

  it(
    "two dates stay two rows — a venue trading past 03:00 Vilnius splits its shift across them, " +
      "and collapsing them would state a date the money does not arrive on",
    async () => {
      const first = new Date(Date.UTC(2026, 8, 24, 0, 0, 0));
      const second = new Date(Date.UTC(2026, 8, 25, 0, 0, 0));
      const a = await capture(700n, 0n);
      const b = await capture(900n, 0n);
      await postFee(a.paymentId, 20n, first);
      await postFee(b.paymentId, 25n, second);

      const summary = await summaries.summarise(await currentShiftId());
      const rows = summary.availability.rows.filter(
        (r) => r.availableOn === first.toISOString() || r.availableOn === second.toISOString(),
      );

      expect(rows, "two availability dates were collapsed into one").toHaveLength(2);
      expect(rows[0].availableOn).toBe(first.toISOString());
      expect(rows[1].availableOn).toBe(second.toISOString());
    },
  );
});
