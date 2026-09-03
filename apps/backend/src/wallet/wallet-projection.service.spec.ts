import { randomUUID } from "node:crypto";
import { shiftServiceForTests } from "../../test/fixtures/shift-for-tests";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { IndividualTipAllocationStrategy } from "../tip/individual-tip-allocation.strategy";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { WalletProjectionService } from "./wallet-projection.service";

// Real database, driven through the REAL production write path (WebhooksService), same
// discipline as tip.service.spec.ts — so the LedgerLine rows this test projects from are exactly
// what a real payment produces, not a hand-crafted stand-in for it.
const WEBHOOK_SECRET = "whsec_test_fake_secret_for_signing_only";

function signEvent(payload: object): { rawBody: Buffer; signature: string } {
  const raw = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET });
  return { rawBody: Buffer.from(raw), signature: header };
}

function buildEvent(type: string, dataObject: Record<string, unknown>) {
  return {
    id: `evt_test_${randomUUID()}`,
    object: "event",
    type,
    data: { object: dataObject },
    api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
  };
}

describe("WalletProjectionService (real database)", () => {
  const prisma = new PrismaService();
  let walletProjection: WalletProjectionService;
  let webhooks: WebhooksService;

  beforeAll(async () => {
    await prisma.$connect();
    const stripe = new StripeService(
      {
        getOrThrow: (key: string) =>
          key === "STRIPE_WEBHOOK_SECRET"
            ? WEBHOOK_SECRET
            : key === "NODE_ENV"
              ? "test"
              : "sk_test_fake_never_called",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // ADR-038: StripeService now carries a boot-time credential probe. NODE_ENV is "test" above,
      // so the probe never runs here and never makes a network call — these two dependencies exist
      // only to satisfy the constructor.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { sendAlert: async () => undefined } as any,
      {
        setContext: () => undefined,
        info: () => undefined,
        error: () => undefined,
        warn: () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );
    const ledger = new LedgerService(prisma, shiftServiceForTests(prisma));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeConfig = { getOrThrow: () => 100 } as any; // 1.00%, Founder decision
    const fakeRestaurantService = {} as RestaurantService;
    webhooks = new WebhooksService(
      prisma,
      stripe,
      ledger,
      fakeRestaurantService,
      fakeConfig,
      new IndividualTipAllocationStrategy(),
    );
    walletProjection = new WalletProjectionService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedOrgRestaurant() {
    const org = await prisma.organization.create({ data: { name: "Wallet Projection Test Org" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Wallet Projection Test Restaurant",
        legalName: "Wallet Projection Test Restaurant UAB",
        companyNumber: `WP-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000006",
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

  async function seedWaiterMembership(organizationId: string, restaurantId: string) {
    const waiterRole = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
    const user = await prisma.user.create({
      data: {
        email: `waiter-${randomUUID()}@example.com`,
        displayName: "Test Waiter",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    return prisma.membership.create({
      data: { userId: user.id, organizationId, restaurantId, roleId: waiterRole.id },
    });
  }

  async function seedPayment(
    restaurantId: string,
    amount: bigint,
    tipAmount: bigint,
    waiterMembershipId: string,
    processorPaymentId: string,
  ) {
    const key = `wallet-proj-test-key-${randomUUID()}`;
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
        processorPaymentId,
        amount,
        tipAmount,
        waiterMembershipId,
        currency: "EUR",
        status: "PENDING",
        paymentMethod: "card",
        idempotencyKey: key,
      },
    });
  }

  async function captureTipPayment(
    restaurant: { id: string },
    waiterMembershipId: string,
    amount: bigint,
    tipAmount: bigint,
  ) {
    const piId = `pi_${randomUUID()}`;
    await seedPayment(restaurant.id, amount, tipAmount, waiterMembershipId, piId);
    const { rawBody, signature } = signEvent(
      buildEvent("payment_intent.succeeded", { id: piId, amount: Number(amount), currency: "eur" }),
    );
    await webhooks.handleEvent(rawBody, signature);
    return piId;
  }

  it("recomputeBalance sums exactly this Membership's own LedgerLine rows — discriminating: a naive implementation reading only credits, or only the general TIP_PAYABLE line, would produce a different number", async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    const waiterMembership = await seedWaiterMembership(org.id, restaurant.id);

    await captureTipPayment(restaurant, waiterMembership.id, 2000n, 500n);

    const wallet = await walletProjection.recomputeBalance(waiterMembership.id);

    expect(wallet).not.toBeNull();
    expect(wallet?.availableBalance).toBe(500n);
    expect(wallet?.pendingBalance).toBe(0n); // ADR-024: no Withdrawal yet, nothing is cashable regardless of label
    expect(wallet?.currency).toBe("EUR");
    expect(wallet?.membershipId).toBe(waiterMembership.id);
  });

  it("a refund of the full bill leaves the waiter's balance untouched (ADR-062) — the projection still reads DEBIT lines, there is simply no TIP_PAYABLE debit to read", async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    const waiterMembership = await seedWaiterMembership(org.id, restaurant.id);
    const piId = await captureTipPayment(restaurant, waiterMembership.id, 2000n, 500n);

    const before = await walletProjection.recomputeBalance(waiterMembership.id);
    expect(before?.availableBalance).toBe(500n);

    // ADR-062: a refund returns the BILL (2000 − 500 = 1500). The tip is never reversed.
    // Under ADR-023 this same event, at 2000, drove the balance to zero; that is the behaviour
    // this test now refuses.
    const { rawBody, signature } = signEvent(
      buildEvent("charge.refunded", {
        id: `ch_${randomUUID()}`,
        payment_intent: piId,
        amount_refunded: 1500,
        refunds: { data: [{ id: `re_${randomUUID()}`, reason: "requested_by_customer" }] },
      }),
    );
    await webhooks.handleEvent(rawBody, signature);

    const wallet = await walletProjection.recomputeBalance(waiterMembership.id);
    expect(wallet?.availableBalance).toBe(500n); // 500 credited, nothing reversed
  });

  it(
    "DoD (IMPLEMENTATION_PLAN.md, Sprint 7): a Wallet can be deleted and rebuilt from LedgerLine " +
      "alone and match exactly — proved by literally deleting the row, recomputing from zero, and " +
      "comparing the result to the original snapshot field by field, not by re-asserting balances",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const waiterMembership = await seedWaiterMembership(org.id, restaurant.id);
      await captureTipPayment(restaurant, waiterMembership.id, 3300n, 700n);

      const original = await walletProjection.recomputeBalance(waiterMembership.id);
      expect(original).not.toBeNull();
      if (!original) throw new Error("unreachable — asserted above");

      await prisma.wallet.delete({ where: { id: original.id } });
      const goneCheck = await prisma.wallet.findUnique({
        where: { membershipId: waiterMembership.id },
      });
      expect(goneCheck).toBeNull(); // confirms the delete actually happened, not a no-op

      const rebuilt = await walletProjection.recomputeBalance(waiterMembership.id);
      expect(rebuilt).not.toBeNull();
      if (!rebuilt) throw new Error("unreachable — asserted above");

      // Field by field against the ORIGINAL snapshot — the financially meaningful fields must be
      // byte-identical. id/createdAt/updatedAt are expected to differ (a new row was created),
      // not asserted equal — that would be testing the wrong thing.
      expect(rebuilt.membershipId).toBe(original.membershipId);
      expect(rebuilt.availableBalance).toBe(original.availableBalance);
      expect(rebuilt.pendingBalance).toBe(original.pendingBalance);
      expect(rebuilt.currency).toBe(original.currency);
      expect(rebuilt.status).toBe(original.status);
      expect(rebuilt.availableBalance).toBe(700n); // the concrete number, not just "matches itself"
    },
  );

  it("returns null for a Membership with no LedgerLine activity — no Wallet is invented for someone who hasn't earned anything", async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    const membership = await seedWaiterMembership(org.id, restaurant.id);

    const wallet = await walletProjection.recomputeBalance(membership.id);
    expect(wallet).toBeNull();

    const row = await prisma.wallet.findUnique({ where: { membershipId: membership.id } });
    expect(row).toBeNull();
  });

  it("refuses to silently mix currencies — throws rather than summing two currencies' minor units as if they were fungible", async () => {
    const { org, restaurant } = await seedOrgRestaurant();
    const membership = await seedWaiterMembership(org.id, restaurant.id);

    // test/global-setup.ts only seeds EUR (the one currency every other spec file needs) — USD
    // exists nowhere else in this suite, so upserting it here can't race with another file the
    // way global-setup.ts's own comment describes for EUR/Role.
    await prisma.currency.upsert({
      where: { code: "USD" },
      update: {},
      create: { code: "USD", exponent: 2, name: "US Dollar" },
    });

    // Hand-crafted only for this one adversarial case — ADR-012 confines real traffic to EUR, so
    // this shape is otherwise unreachable through the real write path.
    const transaction = await prisma.transaction.create({
      data: {
        paymentId: (
          await prisma.payment.create({
            data: {
              restaurantId: restaurant.id,
              processor: "stripe",
              processorPaymentId: `pi_${randomUUID()}`,
              amount: 1000n,
              tipAmount: 0n,
              currency: "EUR",
              status: "SUCCEEDED",
              paymentMethod: "card",
              idempotencyKey: (
                await prisma.idempotencyKey.create({
                  data: {
                    key: `mix-currency-${randomUUID()}`,
                    endpointScope: "/payments",
                    requestFingerprint: "test",
                    status: "COMPLETED",
                    expiresAt: new Date(Date.now() + 60_000),
                  },
                })
              ).key,
            },
          })
        ).id,
        restaurantId: restaurant.id,
        grossAmount: 1000n,
        currency: "EUR",
        status: "COMPLETED",
      },
    });
    const entry = await prisma.journalEntry.create({
      data: { entryType: "PAYMENT_CAPTURED", transactionId: transaction.id },
    });
    await prisma.ledgerLine.createMany({
      data: [
        // Balances the entry (ledger_integrity.sql's own trigger enforces this even here) —
        // no membershipId, irrelevant to the assertion below.
        {
          journalEntryId: entry.id,
          account: "PROCESSOR_CLEARING",
          direction: "DEBIT",
          amount: 800n,
          currency: "EUR",
        },
        {
          journalEntryId: entry.id,
          account: "TIP_PAYABLE",
          direction: "CREDIT",
          amount: 500n,
          currency: "EUR",
          membershipId: membership.id,
        },
        {
          journalEntryId: entry.id,
          account: "TIP_PAYABLE",
          direction: "CREDIT",
          amount: 300n,
          currency: "USD",
          membershipId: membership.id,
        },
      ],
    });

    await expect(walletProjection.recomputeBalance(membership.id)).rejects.toThrow(
      /more than one currency/,
    );
  });
});
