/**
 * Seeds every Portal screen with something worth looking at, on the LOCAL development database
 * only.
 *
 * **Why this exists.** Nothing in the suite catches a visual regression: the end-to-end tests
 * assert content, the contrast spec asserts tokens, and neither has eyes. This puts real states in
 * front of one.
 *
 * **It began as three Dashboards and was renamed when it stopped being that.** The first version
 * wrote Ledger lines only, which is what the Dashboard computes from — so three screens had data
 * and five were empty, and the file was called `seed-dashboard-demo` truthfully. Covering the rest
 * meant writing what those screens actually read: `transaction` rows for the Transactions list and
 * card, six weeks of closed shifts for Analytics (Performance compares a period against the one
 * before it, and there is no period before today), a pending invitation for Staff, and tip presets
 * that are not the default so Settings is visibly reading the venue rather than rendering a
 * constant.
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
import { randomUUID } from "node:crypto";
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

    // Three venues, three Stripe states — and each state paired with the venue whose OWN FIGURES
    // agree with it, which is a second kind of coherence the first pass missed. It was invisible
    // until the Dashboard learned to speak about cards: the untouched venue was the one with 293 €
    // of sales, so the screen said no card can be taken here directly above the money that had
    // been taken. Same class as the impossible status pair this file already fixed — a fixture
    // describing something the world cannot produce — one layer up, between tables rather than
    // inside a row.
    //
    // So: the venue that cannot charge is the one that has sold nothing (Kaunas), and the money
    // held at Stripe is held for a venue that actually took it (Klaipėda). All three banner states
    // stay visible, which is what this demo exists for.
    const restaurants: Restaurants = {
      withSales: await restaurant(prisma, organization.id, "Vilnius — busy evening", STRIPE_LIVE),
      quiet: await restaurant(prisma, organization.id, "Kaunas — quiet morning", STRIPE_UNTOUCHED),
      acrossMidnight: await restaurant(
        prisma,
        organization.id,
        "Klaipėda — closed at 01:30",
        STRIPE_PAYOUTS_HELD,
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

    // The owner takes tips too. ADR-033's reasoning, made visible: Top Staff ranks whoever served
    // the table, which can be the person who owns the place — so the Staff screens have two names
    // rather than one, and a ranking with one row proves nothing about ranking.
    const ownerMembership = await prisma.membership.findFirstOrThrow({
      where: { userId: owner.id, organizationId: organization.id },
    });

    await stateWithSales(prisma, restaurants.withSales, waiterMembership.id);
    await stateQuiet(prisma, restaurants.quiet);
    await stateAcrossMidnight(prisma, restaurants.acrossMidnight);

    // Six weeks behind today, on the busy venue only. Analytics is the one screen a single day
    // cannot serve: Performance compares a period against the one before it, and there is no
    // period before today.
    await history(prisma, restaurants.withSales, waiterMembership.id, ownerMembership.id);

    // A pending invitation, which the Staff screen deliberately does NOT show — it lists people
    // who have accepted, and says so in as many words.
    //
    // **Seeding something invisible is the point here, not an oversight.** That sentence on the
    // screen is a claim about what is being withheld, and a claim about an absence cannot be
    // checked when there is nothing absent: with no pending invitation in the database, an empty
    // list is empty for the boring reason. With one, the screen is demonstrably choosing.
    //
    // The token itself is never stored, only its hash, so this row cannot be accepted by anyone.
    const accountantRole = await prisma.role.findFirstOrThrow({ where: { name: "Accountant" } });
    await prisma.membershipInvitation.create({
      data: {
        email: "buhalterija@local.invalid",
        organizationId: organization.id,
        restaurantId: restaurants.withSales,
        roleId: accountantRole.id,
        invitedBy: owner.id,
        tokenHash: "demo-invitation-never-acceptable",
        expiresAt: new Date(Date.now() + 6 * 86_400_000),
      },
    });

    // Settings shows these back. Not the default [10, 15, 20], so the screen is visibly reading
    // the venue rather than rendering a constant — the difference a default hides.
    await prisma.restaurant.update({
      where: { id: restaurants.withSales },
      data: { tipPresets: [5, 12, 18] },
    });

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

  // Order is the foreign keys read backwards, and the Payment/Transaction rows are why this list
  // grew: a Transaction points at a Payment, a JournalEntry points at a Transaction, and a
  // LedgerLine points at the JournalEntry. Deleting in any other order fails on a constraint —
  // which is the honest failure, but it fails on the SECOND run of the day, when somebody is
  // trying to look at a screen rather than read this file.
  const keys = (
    await prisma.payment.findMany({
      where: { restaurantId: { in: restaurantIds } },
      select: { idempotencyKey: true },
    })
  ).map((p) => p.idempotencyKey);

  await prisma.ledgerLine.deleteMany({ where: { restaurantId: { in: restaurantIds } } });
  await prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
  await prisma.transaction.deleteMany({ where: { restaurantId: { in: restaurantIds } } });
  await prisma.payment.deleteMany({ where: { restaurantId: { in: restaurantIds } } });
  await prisma.idempotencyKey.deleteMany({ where: { key: { in: keys } } });
  await prisma.membershipInvitation.deleteMany({ where: { organizationId } });
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

// `tipLines` used to live here — a tip posted as its own journal entry, separate from the sale.
// It is gone rather than kept for later: `sale()` now writes the tip as a TIP_PAYABLE line on the
// sale's OWN entry, which is where the Transactions card looks for it. Two ways to post a tip in
// one fixture is how the Dashboard and the Transactions screen came to disagree about the same
// evening in the first place.

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

  // The tip rides ON the sale rather than being posted as a separate entry, because that is how
  // the real payment path writes it and what the Transactions card reads. The earlier version
  // posted the two apart — correct for the Dashboard, whose figures come from the Ledger, and it
  // would have left every row on the Transactions screen showing a tip of zero.
  const sales: [bigint, bigint, bigint, number][] = [
    [4_250n, 0n, 128n, 17],
    [12_000n, 1_200n, 360n, 18],
    [3_050n, 0n, 92n, 19],
    [8_400n, 500n, 252n, 20],
    [6_150n, 900n, 185n, 21],
  ];
  for (const [bill, tip, fee, hour] of sales) {
    await sale(prisma, {
      restaurantId,
      shiftId: shift.id,
      bill,
      tip,
      fee,
      waiterMembershipId,
      at: todayAt(hour, 15),
    });
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

/**
 * A sale the TRANSACTIONS screens can read, not only the Dashboard.
 *
 * **The difference between this and `post()` above is the whole reason three screens were empty.**
 * `post()` writes Ledger lines, which is what the Dashboard's figures are computed from. But
 * `GET /transactions` reads `transaction` rows, and the card's breakdown reads the TIP_PAYABLE
 * lines of the journal entry attached to that transaction. A fixture with one and not the other
 * produces a Dashboard showing money beside a Transactions screen showing nothing — a state the
 * product itself cannot reach, which is the class of fixture defect this file has already fixed
 * once between two tables.
 *
 * One `$transaction`, because the Ledger's balance trigger is INITIALLY DEFERRED and sums debits
 * against credits at COMMIT: four separate writes fail on the first one, honestly and unhelpfully.
 */
async function sale(
  prisma: PrismaClient,
  args: {
    restaurantId: string;
    shiftId: string;
    bill: bigint;
    tip: bigint;
    fee: bigint;
    waiterMembershipId: string | null;
    at: Date;
    status?: "COMPLETED" | "REFUNDED" | "DISPUTED";
  },
): Promise<string> {
  const { restaurantId, shiftId, bill, tip, fee, waiterMembershipId, at } = args;
  const charged = bill + tip;
  const key = `demo-${randomUUID()}`;

  return await prisma.$transaction(async (tx) => {
    await tx.idempotencyKey.create({
      data: {
        key,
        endpointScope: "POST /payments",
        requestFingerprint: "dashboard-demo",
        status: "COMPLETED",
        createdAt: at,
        expiresAt: new Date(at.getTime() + 86_400_000),
      },
    });

    const payment = await tx.payment.create({
      data: {
        restaurantId,
        processor: "stripe",
        processorPaymentId: `pi_demo_${randomUUID().slice(0, 12)}`,
        amount: charged,
        tipAmount: tip,
        waiterMembershipId,
        currency: EUR,
        status: "SUCCEEDED",
        paymentMethod: "card",
        idempotencyKey: key,
        createdAt: at,
        updatedAt: at,
      },
    });

    const transaction = await tx.transaction.create({
      data: {
        paymentId: payment.id,
        restaurantId,
        grossAmount: charged,
        currency: EUR,
        status: args.status ?? "COMPLETED",
        createdAt: at,
      },
    });

    const entry = await tx.journalEntry.create({
      data: {
        entryType: "PAYMENT_CAPTURED",
        transactionId: transaction.id,
        description: "dashboard demo sale",
        createdAt: at,
      },
    });

    const lines: Prisma.LedgerLineCreateManyInput[] = [
      { ...line(restaurantId, shiftId, "PROCESSOR_CLEARING", "DEBIT", charged, at) },
      { ...line(restaurantId, shiftId, "RESTAURANT_REVENUE_PAYABLE", "CREDIT", bill - fee, at) },
      { ...line(restaurantId, shiftId, "PLATFORM_FEE_REVENUE", "CREDIT", fee, at) },
    ];
    if (tip > 0n) {
      lines.push({
        ...line(restaurantId, shiftId, "TIP_PAYABLE", "CREDIT", tip, at),
        membershipId: waiterMembershipId,
      });
    }
    await tx.ledgerLine.createMany({
      data: lines.map((l) => ({ ...l, journalEntryId: entry.id })),
    });

    return transaction.id;
  });
}

/**
 * Six weeks of closed shifts on the busy venue, so Analytics has something to be about.
 *
 * **Analytics is the screen a one-day fixture cannot serve.** Revenue and Tips draw a series over
 * shifts; Performance compares the chosen period against the one immediately before it, which does
 * not exist if all the money is today; Staff ranks people over a period; and the period-summary
 * report has no average to report from a single sale. So this seeds real history rather than more
 * of today.
 *
 * **One of these shifts crosses midnight deliberately.** ADR-065's distinction — a shift is not a
 * calendar day — is the one thing on that screen a person cannot check by arithmetic, and the
 * caption claiming it should have a shift behind it that actually ran to 01:20.
 */
async function history(
  prisma: PrismaClient,
  restaurantId: string,
  waiterMembershipId: string,
  ownerMembershipId: string,
): Promise<void> {
  for (let daysAgo = 42; daysAgo >= 1; daysAgo -= 1) {
    // Four days in seven, so the series has gaps a real venue has — a closed Monday reads as a
    // closed Monday, not as a hole in the data.
    if (daysAgo % 7 === 0 || daysAgo % 7 === 1 || daysAgo % 7 === 2) continue;

    const openedAt = todayAt(16, 0);
    openedAt.setDate(openedAt.getDate() - daysAgo);

    // Every sixth evening runs late. `businessDateOf` keeps it on the day it opened, which is the
    // whole point of the caption on the Analytics screen.
    const late = daysAgo % 6 === 0;
    const closedAt = new Date(openedAt);
    closedAt.setHours(late ? 25 : 23, late ? 20 : 40, 0, 0);

    const shift = await prisma.shift.create({
      data: {
        restaurantId,
        openedAt,
        closedAt,
        closeReason: "BUTTON",
        businessDate: businessDateOf(openedAt),
      },
    });

    // Amounts vary by weekday so Performance shows a real change rather than a flat line, and the
    // figures stay plausible for one evening in a Vilnius restaurant.
    const busy = daysAgo % 7 === 5 || daysAgo % 7 === 6;
    const covers = busy ? 6 : 4;
    for (let i = 0; i < covers; i += 1) {
      const at = new Date(openedAt);
      at.setHours(openedAt.getHours() + i, 25, 0, 0);
      const bill = BigInt(3_200 + ((daysAgo * 137 + i * 411) % 9_000));
      const tip = BigInt(((daysAgo * 53 + i * 97) % 12) * 50);
      await sale(prisma, {
        restaurantId,
        shiftId: shift.id,
        bill,
        tip,
        fee: bill / 33n,
        // Two people take tips, so the Staff area of Analytics has more than one row to rank.
        waiterMembershipId: i % 3 === 0 ? ownerMembershipId : waiterMembershipId,
        at,
      });
    }

    if (late) {
      const afterMidnight = new Date(openedAt);
      afterMidnight.setHours(24, 50, 0, 0);
      await sale(prisma, {
        restaurantId,
        shiftId: shift.id,
        bill: 5_400n,
        tip: 600n,
        fee: 162n,
        waiterMembershipId,
        at: afterMidnight,
      });
    }
  }
}

function print(r: Restaurants): void {
  const busy = `http://localhost:3000/restaurants/${r.withSales}`;
  console.log(`  Seeded. Sign in at http://localhost:3000/login

    email     ${DEMO_EMAIL}
    password  ${DEMO_PASSWORD}

  Signing in lands on the Restaurants list. Eight screens, and what each one is for:

  1. Restaurants        http://localhost:3000/restaurants
       Three venues in three Stripe states. The flags differ per row — that is the screen
       reading each venue rather than the account.

  2. Dashboard          ${busy}
       Tonight: five sales, two of them tipped. Compare with the other two venues — the quiet
       one explains itself instead of showing zeroes, and the third closed at 01:30 and says so.

  3. Transactions       ${busy}/transactions
       The list the Dashboard figure leads to. Money is written in the venue's own locale
       (lt-LT), so 50,00 rather than 50.00. The filter has its own empty state, separate from
       a venue that sold nothing.

  4. Transaction card   open any row from the list above
       Where the money went: the venue's share, the tip, our fee. A figure that is unavailable
       says so rather than showing a zero.

  5. Staff              ${busy}/staff
       Two people who have ACCEPTED. There is also an invitation pending in the database, and
       the screen deliberately does not show it — read the sentence at the top, which says so.
       The pending row exists precisely so that absence is a choice rather than an empty table.

  6. Settings           ${busy}/settings
       Tip presets read 5, 12, 18 — deliberately not the default, so you can see the screen is
       reading this venue. The shift auto-close time is shown and explained, not editable: no
       endpoint stores it.

  7. Analytics          ${busy}/analytics
       Six weeks of shifts. Switch areas with the buttons; the period stays. Revenue and Tips
       show a series BY SHIFT — one evening a week ran past midnight and is reported whole,
       against the day the venue calls it. Performance compares against the previous period.

  8. Connect payments   http://localhost:3000/restaurants/${r.quiet}/onboarding
       The venue Stripe has never heard of. This is where the Dashboard banner leads.

  Re-running the command resets everything above.
`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
