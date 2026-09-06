/**
 * Seeds three Dashboards a person can look at, on the LOCAL development database only.
 *
 * **Why this exists.** Nothing in the suite catches a visual regression: the end-to-end tests
 * assert content, the contrast spec asserts tokens, and neither has eyes. The screen had never
 * been looked at. This puts three real states in front of one.
 *
 * **It refuses to run anywhere but locally, and the check asks the database rather than the URL.**
 * A connection string can be read wrong; `inet_server_addr()` is the server's own answer about
 * where it is. Production is reached only through Railway's own tooling, and this script has no
 * way to get there — but a guard that depends on nobody making a mistake is not a guard.
 *
 * **It is destructive to its own data and to nothing else.** Every run deletes the demo
 * Organization and rebuilds it, so re-running is how a state gets reset. It touches no row it did
 * not create: the demo's Organization id is fixed and everything hangs from it.
 *
 * Usage:  pnpm --filter backend run demo:dashboard
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { hashPassword } from "../src/auth/password.util";
import { deriveOnboardingStatus } from "../src/restaurant/onboarding-status.util";

const DEMO_ORG_NAME = "Dashboard Demo (local only)";
const DEMO_EMAIL = "demo-owner@local.invalid";
/** Deliberately unmistakable, and `.invalid` above can never be a routable address. This account
 * exists only in a developer's docker Postgres — production registration is refused outright while
 * the terms are unpublished (ADR-055), so there is nothing of this shape to collide with. */
const DEMO_PASSWORD = "LocalDemo!2026-not-a-real-secret";

const EUR = "EUR";

async function assertLocal(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("NODE_ENV is production. This script seeds demo data and will not run here.");
  }

  const [row] = await prisma.$queryRaw<{ host: string | null; db: string }[]>`
    SELECT inet_server_addr()::text AS host, current_database() AS db
  `;
  const host = row?.host ?? null;

  // null means a unix socket — the server is on this machine. Otherwise it must be loopback or a
  // private range: 10/8, 172.16/12, 192.168/16, or IPv6 loopback.
  const local =
    host === null ||
    host.startsWith("127.") ||
    host === "::1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (!local) {
    throw new Error(
      `REFUSING: the database at ${host} (${row?.db}) is not on this machine or a private ` +
        `network. This script only ever seeds a local development database.`,
    );
  }
  console.log(`  database: ${row?.db} at ${host ?? "unix socket"} — local, proceeding\n`);
}

interface Restaurants {
  withSales: string;
  quiet: string;
  acrossMidnight: string;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await assertLocal(prisma);

    const ownerRole = await prisma.role.findFirstOrThrow({ where: { name: "Owner" } });
    const waiterRole = await prisma.role.findFirstOrThrow({ where: { name: "Waiter" } });

    // Rebuild from scratch every run: that is what makes "run it again" the way to reset a state.
    const existing = await prisma.organization.findFirst({ where: { name: DEMO_ORG_NAME } });
    if (existing) await wipe(prisma, existing.id);

    const organization = await prisma.organization.create({
      data: { name: DEMO_ORG_NAME, status: "ACTIVE" },
    });

    const owner = await prisma.user.upsert({
      where: { email: DEMO_EMAIL },
      update: { passwordHash: await hashPassword(DEMO_PASSWORD), status: "ACTIVE" },
      create: {
        email: DEMO_EMAIL,
        displayName: "Demo Owner",
        passwordHash: await hashPassword(DEMO_PASSWORD),
        locale: "en",
      },
    });
    const waiter = await prisma.user.upsert({
      where: { email: "demo-waiter@local.invalid" },
      update: {},
      create: {
        email: "demo-waiter@local.invalid",
        displayName: "Rasa Petraitienė",
        passwordHash: await hashPassword(DEMO_PASSWORD),
        locale: "en",
      },
    });

    // ORG-WIDE, so one login reaches all three Dashboards (ADR-005) — and, since #176, lands on
    // the Restaurants list, which is how a person moves between them.
    await prisma.membership.create({
      data: { userId: owner.id, organizationId: organization.id, roleId: ownerRole.id },
    });

    // Three venues, three Stripe states that can actually coexist with their own onboarding
    // status — so the payout banner is still visible on one screen (Kaunas), and the Restaurants
    // list's "card setup not started" flag on another (Klaipėda), without either screen being
    // shown data the system could never produce.
    const restaurants: Restaurants = {
      withSales: await restaurant(prisma, organization.id, "Vilnius — busy evening", STRIPE_LIVE),
      quiet: await restaurant(
        prisma,
        organization.id,
        "Kaunas — quiet morning",
        STRIPE_PAYOUTS_HELD,
      ),
      acrossMidnight: await restaurant(
        prisma,
        organization.id,
        "Klaipėda — closed at 01:30",
        STRIPE_UNTOUCHED,
      ),
    };

    const waiterMembership = await prisma.membership.create({
      data: {
        userId: waiter.id,
        organizationId: organization.id,
        restaurantId: restaurants.withSales,
        roleId: waiterRole.id,
      },
    });

    await stateWithSales(prisma, restaurants.withSales, waiterMembership.id);
    await stateQuiet(prisma, restaurants.quiet);
    await stateAcrossMidnight(prisma, restaurants.acrossMidnight);

    print(restaurants);
  } finally {
    await prisma.$disconnect();
  }
}

async function wipe(prisma: PrismaClient, organizationId: string): Promise<void> {
  const restaurantIds = (
    await prisma.restaurant.findMany({ where: { organizationId }, select: { id: true } })
  ).map((r) => r.id);

  const entryIds = (
    await prisma.ledgerLine.findMany({
      where: { restaurantId: { in: restaurantIds } },
      select: { journalEntryId: true },
      distinct: ["journalEntryId"],
    })
  ).map((l) => l.journalEntryId);

  await prisma.ledgerLine.deleteMany({ where: { restaurantId: { in: restaurantIds } } });
  await prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
  await prisma.shift.deleteMany({ where: { restaurantId: { in: restaurantIds } } });
  await prisma.membership.deleteMany({ where: { organizationId } });
  await prisma.restaurant.deleteMany({ where: { organizationId } });
  await prisma.organization.delete({ where: { id: organizationId } });
}

/**
 * A venue's Stripe state, as the two capability statuses Stripe actually reports.
 *
 * **`onboardingStatus` is not a third, independent field, and treating it as one produced a
 * fixture describing a state the system cannot reach.** The backend derives it from these two
 * (`deriveOnboardingStatus`), so only certain pairs exist. This file used to write
 * `NOT_STARTED` alongside `payoutsStatus: "restricted"` — impossible, because `NOT_STARTED` means
 * Stripe has told us nothing yet, which is both capabilities null. The visible consequence was two
 * screens contradicting each other about the same venue: the Restaurants list said card setup had
 * not started while the Dashboard banner said card payments could be taken. The list was reading
 * the data correctly; the data could not occur.
 *
 * So the status is no longer written here. It is computed by the same function the API calls —
 * the rule `CLAUDE.md` already states for Roles and Permissions, applied to the field that has the
 * same shape: **a fixture's value comes from the real code, never from a literal typed beside it.**
 * A literal cannot be wrong at the moment it is written, and cannot stay right afterwards.
 */
interface StripeState {
  cardPaymentsStatus: string | null;
  payoutsStatus: string | null;
}

/** Charges and payouts both live. Derives to COMPLETE — no banner, no flag anywhere. */
const STRIPE_LIVE: StripeState = { cardPaymentsStatus: "active", payoutsStatus: "active" };

/**
 * Can charge, cannot yet be paid out. Derives to RESTRICTED, and this is the state the Dashboard's
 * payout banner exists for — its wording ("card payments can be taken, but money cannot reach your
 * bank") is true here and was not true of the pair this file used to write.
 */
const STRIPE_PAYOUTS_HELD: StripeState = {
  cardPaymentsStatus: "active",
  payoutsStatus: "restricted",
};

/** Stripe has told us nothing: the venue cannot take a card at all. Derives to NOT_STARTED. */
const STRIPE_UNTOUCHED: StripeState = { cardPaymentsStatus: null, payoutsStatus: null };

async function restaurant(
  prisma: PrismaClient,
  organizationId: string,
  name: string,
  stripe: StripeState,
): Promise<string> {
  const created = await prisma.restaurant.create({
    data: {
      organizationId,
      name,
      legalName: `${name} UAB`,
      companyNumber: "300000000",
      vatNumber: "LT100000000000",
      email: "demo@local.invalid",
      phone: "+37060000000",
      country: "LT",
      currency: EUR,
      defaultCustomerLocale: "lt",
      timezone: "Europe/Vilnius",
      address: "Gedimino pr. 1, Vilnius",
      cardPaymentsStatus: stripe.cardPaymentsStatus,
      payoutsStatus: stripe.payoutsStatus,
      // Derived, never asserted — see StripeState above. Zero requirements, because this demo has
      // no outstanding Stripe requirement to describe: that is precisely what makes the middle
      // venue RESTRICTED rather than IN_PROGRESS.
      onboardingStatus: deriveOnboardingStatus(stripe.cardPaymentsStatus, stripe.payoutsStatus, 0),
    },
  });
  return created.id;
}

/** A captured sale: the bill split between the venue's payable and the platform fee. */
function saleLines(
  restaurantId: string,
  shiftId: string,
  bill: bigint,
  fee: bigint,
  at: Date,
): Prisma.LedgerLineCreateManyInput[] {
  return [
    line(restaurantId, shiftId, "PROCESSOR_CLEARING", "DEBIT", bill, at),
    line(restaurantId, shiftId, "RESTAURANT_REVENUE_PAYABLE", "CREDIT", bill - fee, at),
    line(restaurantId, shiftId, "PLATFORM_FEE_REVENUE", "CREDIT", fee, at),
  ];
}

/** A tip allocated to one person. Its own journal entry, as the real path posts it. */
function tipLines(
  restaurantId: string,
  shiftId: string,
  membershipId: string,
  amount: bigint,
  at: Date,
): Prisma.LedgerLineCreateManyInput[] {
  return [
    line(restaurantId, shiftId, "PROCESSOR_CLEARING", "DEBIT", amount, at),
    { ...line(restaurantId, shiftId, "TIP_PAYABLE", "CREDIT", amount, at), membershipId },
  ];
}

function line(
  restaurantId: string,
  shiftId: string,
  account: Prisma.LedgerLineCreateManyInput["account"],
  direction: Prisma.LedgerLineCreateManyInput["direction"],
  amount: bigint,
  createdAt: Date,
): Prisma.LedgerLineCreateManyInput {
  return {
    journalEntryId: "",
    account,
    direction,
    amount,
    currency: EUR,
    restaurantId,
    shiftId,
    createdAt,
  };
}

/** One journal entry and its lines, in ONE transaction — the balance trigger sums at COMMIT. */
async function post(
  prisma: PrismaClient,
  entryType: "PAYMENT_CAPTURED" | "TIP_ALLOCATED",
  lines: Prisma.LedgerLineCreateManyInput[],
  at: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: { entryType, description: "dashboard demo", createdAt: at },
    });
    await tx.ledgerLine.createMany({
      data: lines.map((l) => ({ ...l, journalEntryId: entry.id })),
    });
  });
}

function todayAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

function businessDateOf(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

/** STATE 1 — an open shift with sales, tips, and a named person to show. */
async function stateWithSales(
  prisma: PrismaClient,
  restaurantId: string,
  waiterMembershipId: string,
): Promise<void> {
  const openedAt = todayAt(16, 0);
  const shift = await prisma.shift.create({
    data: { restaurantId, openedAt, businessDate: businessDateOf(openedAt) },
  });

  const sales: [bigint, bigint, number][] = [
    [4_250n, 128n, 17],
    [12_000n, 360n, 18],
    [3_050n, 92n, 19],
    [8_400n, 252n, 20],
    [6_150n, 185n, 21],
  ];
  for (const [bill, fee, hour] of sales) {
    const at = todayAt(hour, 15);
    await post(prisma, "PAYMENT_CAPTURED", saleLines(restaurantId, shift.id, bill, fee, at), at);
  }

  for (const [amount, hour] of [
    [500n, 18],
    [1_200n, 20],
  ] as [bigint, number][]) {
    const at = todayAt(hour, 20);
    await post(
      prisma,
      "TIP_ALLOCATED",
      tipLines(restaurantId, shift.id, waiterMembershipId, amount, at),
      at,
    );
  }
}

/** STATE 2 — an open shift and nothing sold. A normal morning. */
async function stateQuiet(prisma: PrismaClient, restaurantId: string): Promise<void> {
  const openedAt = todayAt(8, 0);
  await prisma.shift.create({
    data: { restaurantId, openedAt, businessDate: businessDateOf(openedAt) },
  });
}

/** STATE 3 — yesterday's shift, closed at 01:30, with money on both sides of midnight. */
async function stateAcrossMidnight(prisma: PrismaClient, restaurantId: string): Promise<void> {
  const openedAt = todayAt(16, 0);
  openedAt.setDate(openedAt.getDate() - 1);
  const closedAt = todayAt(1, 30);

  const shift = await prisma.shift.create({
    data: {
      restaurantId,
      openedAt,
      closedAt,
      closeReason: "BUTTON",
      businessDate: businessDateOf(openedAt),
    },
  });

  const beforeMidnight = todayAt(22, 10);
  beforeMidnight.setDate(beforeMidnight.getDate() - 1);
  await post(
    prisma,
    "PAYMENT_CAPTURED",
    saleLines(restaurantId, shift.id, 21_500n, 645n, beforeMidnight),
    beforeMidnight,
  );

  const afterMidnight = todayAt(0, 40);
  await post(
    prisma,
    "PAYMENT_CAPTURED",
    saleLines(restaurantId, shift.id, 7_800n, 234n, afterMidnight),
    afterMidnight,
  );
}

function print(r: Restaurants): void {
  const url = (id: string) => `http://localhost:3000/restaurants/${id}`;
  console.log(`  Seeded. Sign in at http://localhost:3000/login

    email     ${DEMO_EMAIL}
    password  ${DEMO_PASSWORD}

  Signing in lands on the Restaurants list, which links to all three. The direct addresses:

    1. sales, tips, a named person   ${url(r.withSales)}       (Stripe live)
    2. open shift, nothing sold      ${url(r.quiet)}       (payouts held — banner)
    3. closed 01:30, after-midnight  ${url(r.acrossMidnight)}       (Stripe untouched)

  Re-running this command resets all three.
`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
