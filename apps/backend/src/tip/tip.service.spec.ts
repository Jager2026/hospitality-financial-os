import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { LedgerService } from "../ledger/ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../stripe/stripe.service";
import { IndividualTipAllocationStrategy } from "./individual-tip-allocation.strategy";
import { TipService } from "./tip.service";
import type { RestaurantService } from "../restaurant/restaurant.service";
import { WebhooksService } from "../webhooks/webhooks.service";

// Real database, driven through the REAL production write path (WebhooksService), not
// hand-crafted LedgerLine fixtures — so this test reproduces the exact row shape the live bug
// was found in, not a simplified stand-in for it.
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

describe("TipService.findForRestaurant (real database)", () => {
  const prisma = new PrismaService();
  let tipService: TipService;
  let webhooks: WebhooksService;

  beforeAll(async () => {
    await prisma.$connect();
    const stripe = new StripeService({
      getOrThrow: (key: string) =>
        key === "STRIPE_WEBHOOK_SECRET" ? WEBHOOK_SECRET : "sk_test_fake_never_called",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const ledger = new LedgerService(prisma);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeConfig = { getOrThrow: () => 100 } as any; // 1.00%, Founder decision
    const fakeRestaurantService = {} as RestaurantService; // account.updated path unused here
    webhooks = new WebhooksService(
      prisma,
      stripe,
      ledger,
      fakeRestaurantService,
      fakeConfig,
      new IndividualTipAllocationStrategy(),
    );
    tipService = new TipService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedOrgRestaurant() {
    const org = await prisma.organization.create({ data: { name: "Tip Query Test Org" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: "Tip Query Test Restaurant",
        legalName: "Tip Query Test Restaurant UAB",
        companyNumber: `TQ-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000005",
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
    const key = `tip-query-test-key-${randomUUID()}`;
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

  function ownerUserReaching(organizationId: string): AuthenticatedUser {
    return {
      id: randomUUID(),
      email: "owner@example.com",
      locale: "en",
      memberships: [
        {
          id: randomUUID(),
          organizationId,
          restaurantId: null, // org-wide — reaches every Restaurant in this Organization
          role: { id: randomUUID(), name: "Owner", permissions: [] },
        },
      ],
    };
  }

  it(
    "returns exactly one entry per tip, not two — regression test for the general " +
      "PAYMENT_CAPTURED TIP_PAYABLE credit line (membershipId null) being counted alongside the " +
      "real TIP_ALLOCATED one. Fails on any implementation that queries account=TIP_PAYABLE, " +
      "direction=CREDIT for this Restaurant without excluding membershipId: null — the exact bug " +
      "shape live verification caught, which no test previously covered.",
    async () => {
      const { org, restaurant } = await seedOrgRestaurant();
      const waiterMembership = await seedWaiterMembership(org.id, restaurant.id);
      const piId = `pi_${randomUUID()}`;
      // amount=2000, tipAmount=500 -> real production write posts BOTH a general TIP_PAYABLE
      // credit (PAYMENT_CAPTURED's 4th line, membershipId null) and a person-attributed one
      // (TIP_ALLOCATED) for this same tip — the two rows a buggy query would both match.
      const payment = await seedPayment(restaurant.id, 2000n, 500n, waiterMembership.id, piId);

      const { rawBody, signature } = signEvent(
        buildEvent("payment_intent.succeeded", { id: piId, amount: 2000, currency: "eur" }),
      );
      await webhooks.handleEvent(rawBody, signature);

      const transaction = await prisma.transaction.findUnique({ where: { paymentId: payment.id } });
      const tip = await prisma.tip.findUnique({ where: { transactionId: transaction?.id } });
      expect(tip).not.toBeNull(); // sanity: the fixture actually produced a Tip row

      const results = await tipService.findForRestaurant(restaurant.id, ownerUserReaching(org.id));

      expect(results).toHaveLength(1); // NOT 2 — the general liability line must be excluded
      expect(results[0].tipId).toBe(tip?.id);
      expect(results[0].amount).toBe("500"); // the real, person-attributed credit — not the general one
    },
  );
});
