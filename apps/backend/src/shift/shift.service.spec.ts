import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PinoLogger } from "nestjs-pino";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerService } from "../ledger/ledger.service";
import { ShiftService } from "./shift.service";

/**
 * ADR-064. The claim under test is the one the whole entity exists for: **a payment made at 01:30
 * on a shift nobody has closed belongs to that shift AND to today's calendar date, at the same
 * time.** An implementation that opens a new shift at midnight — which is what any
 * calendar-derived model does — fails the first assertion; one that back-dates the LedgerLine to
 * the shift's business date fails the second.
 */
describe("ShiftService (real database)", () => {
  const prisma = new PrismaService();
  let shifts: ShiftService;
  let ledger: LedgerService;

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ShiftService,
        LedgerService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: `PinoLogger:${ShiftService.name}`,
          useValue: { info: () => {}, warn: () => {}, error: () => {} } as unknown as PinoLogger,
        },
      ],
    }).compile();
    shifts = moduleRef.get(ShiftService);
    ledger = moduleRef.get(LedgerService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedRestaurant(timezone = "Europe/Vilnius", shiftAutoCloseMinutes = 300) {
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
        timezone,
        address: "A",
        shiftAutoCloseMinutes,
      },
    });
    return { org, restaurant };
  }

  /** Posts a balanced two-line entry — the smallest thing that exercises the Ledger's own
   * shift-stamping path, rather than a hand-written LedgerLine that would bypass it. */
  async function postCapture(restaurantId: string, amount: bigint) {
    return ledger.postJournalEntry({
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
  }

  it(
    "a payment posted while yesterday's shift is still open carries THAT shift and TODAY's " +
      "calendar timestamp — the 01:30 case, and the discriminating one: an implementation " +
      "deriving the shift from the calendar date would open a new one and fail the first " +
      "assertion, one back-dating the line to the business date would fail the second",
    async () => {
      const { restaurant } = await seedRestaurant();

      // The venue opened yesterday morning and has not pressed the button. Written directly, so
      // the shift genuinely predates the payment rather than being created by it.
      const yesterday = new Date(Date.now() - 15 * 60 * 60 * 1000); // ~15h ago
      const openShift = await prisma.shift.create({
        data: {
          restaurantId: restaurant.id,
          openedAt: yesterday,
          businessDate: new Date(
            Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate()),
          ),
        },
      });

      const before = new Date();
      const entry = await postCapture(restaurant.id, 2000n);
      const after = new Date();

      const lines = await prisma.ledgerLine.findMany({
        where: { journalEntry: { id: entry.id } },
      });
      expect(lines).toHaveLength(2);

      // Label one: the SHIFT. Every line belongs to the shift that was already open — not to a
      // new one, and not to none.
      expect(lines.every((l) => l.shiftId === openShift.id)).toBe(true);

      // Label two: the CALENDAR INSTANT, which is now — not the shift's business date. Both
      // labels on the same row, neither derived from the other.
      for (const line of lines) {
        expect(line.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
        expect(line.createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
      }

      // And the shift is still the one from yesterday, by its own name.
      const reread = await prisma.shift.findUniqueOrThrow({ where: { id: openShift.id } });
      expect(reread.closedAt).toBeNull();
      expect(reread.businessDate.getTime()).toBeLessThan(before.getTime());
    },
  );

  it("opens a shift lazily when the venue has none, so no operation is ever shift-less", async () => {
    const { restaurant } = await seedRestaurant();
    expect(await prisma.shift.count({ where: { restaurantId: restaurant.id } })).toBe(0);

    const entry = await postCapture(restaurant.id, 500n);

    const lines = await prisma.ledgerLine.findMany({ where: { journalEntry: { id: entry.id } } });
    expect(lines.every((l) => l.shiftId !== null)).toBe(true);
    const open = await prisma.shift.findFirstOrThrow({
      where: { restaurantId: restaurant.id, closedAt: null },
    });
    expect(lines.every((l) => l.shiftId === open.id)).toBe(true);
  });

  it(
    "the button beats the schedule: closing at 03:00 with the setting at 05:00 records BUTTON " +
      "and the sweep does not touch it afterwards — discriminating against an implementation " +
      "that compares the two times instead of letting the closed state win",
    async () => {
      // Setting at 05:00, shift opened ~15h ago, so the scheduled deadline has already passed —
      // the sweep WOULD close this shift if the button had not.
      const { org, restaurant } = await seedRestaurant("Europe/Vilnius", 300);
      const user = await prisma.user.create({
        data: {
          email: `u-${randomUUID()}@example.invalid`,
          displayName: "Closer",
          passwordHash: "x",
        },
      });
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          restaurantId: restaurant.id,
          roleId: (await prisma.role.findUniqueOrThrow({ where: { name: "Owner" } })).id,
          status: "ACTIVE",
        },
      });
      await prisma.shift.create({
        data: {
          restaurantId: restaurant.id,
          openedAt: new Date(Date.now() - 15 * 60 * 60 * 1000),
          businessDate: new Date(),
        },
      });

      const closed = await shifts.closeByButton(restaurant.id, user.id);
      expect(closed.closeReason).toBe("BUTTON");
      expect(closed.closedBy).toBe(user.id);

      const closedAtAfterButton = closed.closedAt;
      await shifts.autoCloseDueShifts();

      const reread = await prisma.shift.findUniqueOrThrow({ where: { id: closed.id } });
      // Unchanged by the sweep: still BUTTON, still the same instant.
      expect(reread.closeReason).toBe("BUTTON");
      expect(reread.closedAt?.getTime()).toBe(closedAtAfterButton?.getTime());
    },
  );

  it("the safety net closes a shift nobody closed, and records SCHEDULED with no actor", async () => {
    const { restaurant } = await seedRestaurant("Europe/Vilnius", 300);
    const shift = await prisma.shift.create({
      data: {
        restaurantId: restaurant.id,
        openedAt: new Date(Date.now() - 40 * 60 * 60 * 1000), // well past any 05:00 since
        businessDate: new Date(),
      },
    });

    await shifts.autoCloseDueShifts();

    const reread = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(reread.closedAt).not.toBeNull();
    expect(reread.closeReason).toBe("SCHEDULED");
    // No invented "system user": an actor that is not a person is absent, not a placeholder.
    expect(reread.closedBy).toBeNull();
  });

  it("does not close a shift whose configured time has not arrived yet", async () => {
    // Opened a minute ago; the next 05:00 local is hours away.
    const { restaurant } = await seedRestaurant("Europe/Vilnius", 300);
    const shift = await prisma.shift.create({
      data: {
        restaurantId: restaurant.id,
        openedAt: new Date(Date.now() - 60 * 1000),
        businessDate: new Date(),
      },
    });

    await shifts.autoCloseDueShifts();

    const reread = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(reread.closedAt).toBeNull();
    expect(reread.closeReason).toBeNull();
  });

  it("the database refuses a second open shift at one restaurant (partial unique index)", async () => {
    const { restaurant } = await seedRestaurant();
    await prisma.shift.create({
      data: { restaurantId: restaurant.id, openedAt: new Date(), businessDate: new Date() },
    });

    await expect(
      prisma.shift.create({
        data: { restaurantId: restaurant.id, openedAt: new Date(), businessDate: new Date() },
      }),
    ).rejects.toThrow();
  });
});
