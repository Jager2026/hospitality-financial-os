import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PinoLogger } from "nestjs-pino";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerService } from "../ledger/ledger.service";
import { DashboardService } from "../dashboard/dashboard.service";
import { AnalyticsService } from "../analytics/analytics.service";
import { ShiftService } from "./shift.service";
import { seededRole } from "../../test/fixtures/authenticated-user";

/**
 * ADR-065: operational screens read shifts, accounting exports stay calendar.
 *
 * **The two falsifications this file exists for are in the first and last tests.** A Dashboard
 * still counting calendar days fails the first; an accounting export switched to shifts fails the
 * last. Both are written so the wrong implementation cannot pass by coincidence — the fixture is
 * a shift that has crossed midnight, so the shift answer and the calendar answer are different
 * numbers rather than the same number reached two ways.
 */
describe("Shift-scoped reporting (real database)", () => {
  const prisma = new PrismaService();
  let dashboard: DashboardService;
  let analytics: AnalyticsService;
  let ledger: LedgerService;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ShiftService,
        LedgerService,
        DashboardService,
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: `PinoLogger:${ShiftService.name}`,
          useValue: { info: () => {}, warn: () => {}, error: () => {} } as unknown as PinoLogger,
        },
      ],
    }).compile();
    dashboard = moduleRef.get(DashboardService);
    analytics = moduleRef.get(AnalyticsService);
    ledger = moduleRef.get(LedgerService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedVenue() {
    const org = await prisma.organization.create({ data: { name: `Org ${randomUUID()}` } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: `R ${randomUUID()}`,
        legalName: "L",
        companyNumber: "1",
        vatNumber: "LT1",
        email: "r@example.invalid",
        phone: "+37060000000",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "lt",
        timezone: "Europe/Vilnius",
        address: "A",
      },
    });
    const ownerRole = await seededRole(prisma, "Owner");
    const user: AuthenticatedUser = {
      id: randomUUID(),
      email: "owner@example.invalid",
      locale: "en",
      memberships: [
        {
          id: randomUUID(),
          organizationId: org.id,
          restaurantId: null,
          role: ownerRole,
        },
      ],
    };
    return { org, restaurant, user };
  }

  /**
   * A balanced capture whose SHIFT and CALENDAR INSTANT are set independently.
   *
   * Both are written explicitly rather than derived from "now": an earlier version of this
   * fixture built its instants in UTC while the implementation measures midnight in the venue's
   * own timezone, so the fixture disagreed with the code about where midnight was and failed two
   * tests that were describing correct behaviour. Fixed dates, far from today, keep the offset
   * deterministic and the intent readable.
   */
  async function captureOnShift(restaurantId: string, shiftId: string, amount: bigint, at: Date) {
    const entry = await ledger.postJournalEntry({
      entryType: "PAYMENT_CAPTURED",
      lines: [
        {
          account: "PROCESSOR_CLEARING",
          direction: "DEBIT",
          amount,
          currency: "EUR",
          restaurantId,
        },
        {
          account: "RESTAURANT_REVENUE_PAYABLE",
          direction: "CREDIT",
          amount,
          currency: "EUR",
          restaurantId,
        },
      ],
    });
    await prisma.ledgerLine.updateMany({
      where: { journalEntryId: entry.id },
      data: { shiftId, createdAt: at },
    });
    return entry;
  }

  it(
    "FALSIFICATION — Dashboard on a shift that crossed midnight reports the WHOLE shift, " +
      "including the after-midnight takings, and names them: a calendar-day implementation " +
      "reports only what arrived after 00:00 and fails on shiftRevenue",
    async () => {
      const { restaurant, user } = await seedVenue();

      // Business date 2026-03-10, Europe/Vilnius (UTC+2 in March, before the DST switch), so the
      // midnight ENDING it is 2026-03-10T22:00Z. 2000 lands before it, 1400 after — the ADR's
      // own 01:00 case, with both instants chosen against the venue's clock rather than UTC's.
      const shift = await prisma.shift.create({
        data: {
          restaurantId: restaurant.id,
          openedAt: new Date("2026-03-10T16:00:00.000Z"),
          businessDate: new Date(Date.UTC(2026, 2, 10)),
        },
      });

      await captureOnShift(restaurant.id, shift.id, 2000n, new Date("2026-03-10T19:00:00.000Z"));
      await captureOnShift(restaurant.id, shift.id, 1400n, new Date("2026-03-10T23:00:00.000Z"));

      const summary = await dashboard.getSummary(restaurant.id, user);

      // The shift total is BOTH payments. A calendar "today" would report 1400 and a calendar
      // "yesterday" 2000 — neither is 3400, so this single assertion separates the two models.
      expect(summary.shiftRevenue).toBe("3400");
      expect(summary.shiftTransactions).toBe(2);
      expect(summary.shift?.id).toBe(shift.id);

      // And the after-midnight money is named rather than hidden (ADR-065).
      expect(summary.shift?.afterMidnightRevenue).toBe("1400");
    },
  );

  it("names a shift that closed after midnight, and reports 0 — not null — for one that did not", async () => {
    const { restaurant, user } = await seedVenue();

    // Business date 2026-03-12; midnight ending it is 2026-03-12T22:00Z. Closed two hours before.
    await prisma.shift.create({
      data: {
        restaurantId: restaurant.id,
        openedAt: new Date("2026-03-12T16:00:00.000Z"),
        closedAt: new Date("2026-03-12T20:00:00.000Z"),
        closeReason: "BUTTON",
        businessDate: new Date(Date.UTC(2026, 2, 12)),
      },
    });

    const summary = await dashboard.getSummary(restaurant.id, user);
    expect(summary.shift?.closedAfterMidnight).toBe(false);
    // A real zero, not absent data — the distinction ADR-025 draws for every figure like this.
    expect(summary.shift?.afterMidnightRevenue).toBe("0");
  });

  it("the revenue chart is the last SHIFTS, not the last calendar days — two shifts in one day appear twice", async () => {
    const { restaurant, user } = await seedVenue();
    const businessDate = new Date(Date.UTC(2026, 0, 15));

    // A venue that traded twice on one business date: a lunch shift and an evening shift.
    for (const [openedAt, amount] of [
      [new Date(Date.UTC(2026, 0, 15, 10)), 500n],
      [new Date(Date.UTC(2026, 0, 15, 18)), 900n],
    ] as const) {
      const shift = await prisma.shift.create({
        data: {
          restaurantId: restaurant.id,
          openedAt,
          closedAt: new Date(openedAt.getTime() + 4 * 60 * 60 * 1000),
          closeReason: "BUTTON",
          businessDate,
        },
      });
      const entry = await ledger.postJournalEntry({
        entryType: "PAYMENT_CAPTURED",
        lines: [
          {
            account: "PROCESSOR_CLEARING",
            direction: "DEBIT",
            amount,
            currency: "EUR",
            restaurantId: restaurant.id,
          },
          {
            account: "RESTAURANT_REVENUE_PAYABLE",
            direction: "CREDIT",
            amount,
            currency: "EUR",
            restaurantId: restaurant.id,
          },
        ],
      });
      await prisma.ledgerLine.updateMany({
        where: { journalEntryId: entry.id },
        data: { shiftId: shift.id },
      });
    }

    const summary = await dashboard.getSummary(restaurant.id, user);
    const onThatDate = summary.revenueChart.filter((p) => p.date === "2026-01-15");

    // A calendar chart would collapse these into one bucket of 1400. Shifts keep them apart —
    // which is the point: they were two working days, and the owner ran them separately.
    expect(onThatDate).toHaveLength(2);
    expect(onThatDate.map((p) => p.revenue).sort()).toEqual(["500", "900"]);
    // Distinguishable, so a screen can link to each.
    expect(new Set(onThatDate.map((p) => p.shiftId)).size).toBe(2);
  });

  it(
    "FALSIFICATION — the accounting CSV export stays CALENDAR: a shift crossing midnight is " +
      "split across two dated rows, and an export switched to shifts would report one row of 3400",
    async () => {
      const { restaurant, user } = await seedVenue();
      const businessDate = new Date(Date.UTC(2026, 1, 10));
      const shift = await prisma.shift.create({
        data: {
          restaurantId: restaurant.id,
          openedAt: new Date(Date.UTC(2026, 1, 10, 18)),
          closedAt: new Date(Date.UTC(2026, 1, 11, 3)),
          closeReason: "BUTTON",
          businessDate,
        },
      });

      // One shift, two calendar days: 2000 on the 10th, 1400 on the 11th.
      for (const [amount, at] of [
        [2000n, new Date(Date.UTC(2026, 1, 10, 20))],
        [1400n, new Date(Date.UTC(2026, 1, 11, 1))],
      ] as const) {
        const entry = await ledger.postJournalEntry({
          entryType: "PAYMENT_CAPTURED",
          lines: [
            {
              account: "PROCESSOR_CLEARING",
              direction: "DEBIT",
              amount,
              currency: "EUR",
              restaurantId: restaurant.id,
            },
            {
              account: "RESTAURANT_REVENUE_PAYABLE",
              direction: "CREDIT",
              amount,
              currency: "EUR",
              restaurantId: restaurant.id,
            },
          ],
        });
        await prisma.ledgerLine.updateMany({
          where: { journalEntryId: entry.id },
          data: { shiftId: shift.id, createdAt: at },
        });
      }

      const csv = await analytics.exportRevenueCsv(
        { restaurantId: restaurant.id, from: "2026-02-10", to: "2026-02-11" },
        user,
      );

      const rows = csv.split("\n").slice(1);
      // TWO dated rows, split at midnight — the accountant's calendar period, as ADR-065 requires.
      // A shift-scoped export would emit a single row for 2026-02-10 worth 3400 and fail here.
      expect(rows).toContain("2026-02-10,2000");
      expect(rows).toContain("2026-02-11,1400");
      expect(rows.some((r) => r.endsWith(",3400"))).toBe(false);
    },
  );

  it(
    "rows written before ADR-064 carry no shift and are therefore absent from every shift-scoped " +
      "figure — recorded as behaviour, not repaired: no backfill can invent when those venues " +
      "closed their days",
    async () => {
      const { restaurant, user } = await seedVenue();
      const shift = await prisma.shift.create({
        data: {
          restaurantId: restaurant.id,
          openedAt: new Date(),
          businessDate: new Date(),
        },
      });
      const entry = await ledger.postJournalEntry({
        entryType: "PAYMENT_CAPTURED",
        lines: [
          {
            account: "PROCESSOR_CLEARING",
            direction: "DEBIT",
            amount: 700n,
            currency: "EUR",
            restaurantId: restaurant.id,
          },
          {
            account: "RESTAURANT_REVENUE_PAYABLE",
            direction: "CREDIT",
            amount: 700n,
            currency: "EUR",
            restaurantId: restaurant.id,
          },
        ],
      });
      // Simulate a pre-migration row: real money, no shift label.
      await prisma.ledgerLine.updateMany({
        where: { journalEntryId: entry.id },
        data: { shiftId: null },
      });

      const summary = await dashboard.getSummary(restaurant.id, user);
      expect(summary.shift?.id).toBe(shift.id);
      // The 700 exists in the Ledger and is invisible here. This is what an owner sees for any
      // period before the migration, and it is why the calendar exports remain the complete record.
      expect(summary.shiftRevenue).toBe("0");
    },
  );
});
