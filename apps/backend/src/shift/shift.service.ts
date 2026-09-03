import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PinoLogger, InjectPinoLogger } from "nestjs-pino";
import type { Prisma, Shift } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AppException } from "../common/exceptions/app.exception";
import { getLocalDateParts } from "../common/timezone-day.util";

type TransactionClient = Prisma.TransactionClient;

/** How often the safety net looks for shifts that should have closed. One minute: the setting is
 * a minute of the day, so a coarser sweep would make the configured time a lower bound rather
 * than the time. Same `@Interval` pattern as `OutboxPollerService` (ADR-003). */
const AUTO_CLOSE_SWEEP_MS = 60_000;

@Injectable()
export class ShiftService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(ShiftService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * The Shift a money operation posted right now belongs to — opening one if the venue has none.
   *
   * **This is the whole point of ADR-064 in one method.** It asks "is there an open shift here",
   * not "what is today's date". A payment at 01:30 on a shift opened yesterday at 10:00 and never
   * closed resolves to THAT shift, while its own `LedgerLine.createdAt` records the real instant.
   * Both labels, neither derived from the other.
   *
   * **Called inside the posting transaction** (`postJournalEntry` passes its `tx`), so a shift
   * closing concurrently cannot land half of one entry in each. The partial unique index
   * `shift_one_open_per_restaurant` is what makes the read-then-create safe under concurrency:
   * the loser of a race fails the insert rather than creating a second open shift, and retries
   * into the winner's.
   */
  async resolveOpenShift(restaurantId: string, client: TransactionClient): Promise<Shift> {
    const open = await client.shift.findFirst({
      where: { restaurantId, closedAt: null },
    });
    if (open) return open;

    const restaurant = await client.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { timezone: true },
    });
    const now = new Date();
    const parts = getLocalDateParts(restaurant.timezone, now);

    try {
      return await client.shift.create({
        data: {
          restaurantId,
          openedAt: now,
          // The venue's own local date at the moment of opening — the name a human gives this
          // working day, not a window. A shift that runs past midnight keeps it.
          businessDate: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)),
        },
      });
    } catch (err) {
      // Lost the race against a concurrent first operation at the same venue. The other one won
      // and its shift is the right answer — read it rather than failing the payment.
      const winner = await client.shift.findFirst({ where: { restaurantId, closedAt: null } });
      if (winner) return winner;
      throw err;
    }
  }

  /**
   * The Shift an operational screen means by "now" (ADR-065): the open one, or — if the venue has
   * none open — the one most recently closed.
   *
   * **The fallback is the whole reason this is not just `findFirst({ closedAt: null })`.** At
   * 06:00, after the safety net has closed last night, there is no open shift and there will not
   * be one until the first sale of the day. A Dashboard that showed nothing until then would be
   * blank exactly when an owner opens it to see how last night went.
   *
   * Returns null only for a venue that has never traded.
   */
  async currentShift(restaurantId: string): Promise<Shift | null> {
    const open = await this.prisma.shift.findFirst({
      where: { restaurantId, closedAt: null },
    });
    if (open) return open;

    return this.prisma.shift.findFirst({
      where: { restaurantId },
      orderBy: { openedAt: "desc" },
    });
  }

  /** The last `count` Shifts, oldest first — the shift-scoped replacement for Dashboard's
   * "last 7 calendar days" chart. Fewer than `count` for a venue that has not traded that long,
   * which the chart renders as it is rather than padding with empty calendar days that never
   * existed as working days. */
  async recentShifts(restaurantId: string, count: number): Promise<Shift[]> {
    const shifts = await this.prisma.shift.findMany({
      where: { restaurantId },
      orderBy: { openedAt: "desc" },
      take: count,
    });
    return shifts.reverse();
  }

  /**
   * Shifts whose **business date** falls inside a calendar range, oldest first.
   *
   * **This is the join between the two vocabularies, and it is deliberately by business date.**
   * An owner asking for "1–7 September" means the seven working days the venue calls by those
   * names — so a shift opened on the 7th and closed at 02:00 on the 8th belongs to the range, in
   * full, including its after-midnight takings. Selecting by `openedAt` instead would give the
   * same answer here but a different one for a shift opened before midnight of the 1st, and
   * selecting by `closedAt` would push every late-closing night into the following day — which
   * is the calendar behaviour this replaces.
   */
  async shiftsForBusinessDateRange(
    restaurantId: string,
    from: string,
    to: string,
  ): Promise<Shift[]> {
    return this.prisma.shift.findMany({
      where: {
        restaurantId,
        businessDate: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T00:00:00.000Z`),
        },
      },
      orderBy: { businessDate: "asc" },
    });
  }

  /**
   * The UTC instant of the local midnight that ENDS a shift's business date — the boundary
   * ADR-065's after-midnight figure is measured from.
   *
   * Public because both Dashboard and Analytics need it and neither should re-derive a timezone
   * calculation; `localMinuteUtc` stays private because it is the mechanism, not the concept.
   */
  midnightEndingBusinessDate(businessDate: Date, timezone: string): Date {
    const next = new Date(businessDate.getTime() + 24 * 60 * 60 * 1000);
    return this.localMinuteUtc(
      timezone,
      { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
      0,
    );
  }

  /** True when the shift was still open past the midnight ending its own business date — the
   * fact ADR-065 requires the owner to be told, alongside the amount. A shift still open has not
   * closed after midnight yet; it may. */
  closedAfterMidnight(shift: Shift, timezone: string): boolean {
    if (!shift.closedAt) return false;
    return shift.closedAt >= this.midnightEndingBusinessDate(shift.businessDate, timezone);
  }

  /**
   * **The main path (ADR-064 §2): a person pressed the button.**
   *
   * Takes precedence over the schedule by construction rather than by comparison — once
   * `closedAt` is set the sweep below no longer sees the shift at all. A button press at 03:00
   * with the setting at 05:00 closes at 03:00, and nothing fires later.
   */
  async closeByButton(restaurantId: string, userId: string): Promise<Shift> {
    const open = await this.prisma.shift.findFirst({
      where: { restaurantId, closedAt: null },
    });
    if (!open) {
      throw new AppException(
        "SHIFT_NOT_OPEN",
        "There is no open shift at this restaurant to close.",
        404,
      );
    }

    return this.prisma.shift.update({
      where: { id: open.id },
      data: { closedAt: new Date(), closeReason: "BUTTON", closedBy: userId },
    });
  }

  /**
   * **The safety net (ADR-064 §2): nobody pressed the button.**
   *
   * Closes every open shift whose configured local close-time has passed since it opened. Never
   * competes with the button — a shift closed by a person is not open, so it is not selected.
   *
   * Deliberately not a per-restaurant cron: the setting is per restaurant and its timezone is
   * too, so one sweep evaluating each open shift against its own venue's clock is both simpler
   * and correct across timezones, where a single cron expression could not be.
   */
  @Interval(AUTO_CLOSE_SWEEP_MS)
  async autoCloseDueShifts(): Promise<void> {
    const open = await this.prisma.shift.findMany({
      where: { closedAt: null },
      include: { restaurant: { select: { timezone: true, shiftAutoCloseMinutes: true } } },
    });

    const now = new Date();
    for (const shift of open) {
      const due = this.autoCloseDeadline(
        shift.openedAt,
        shift.restaurant.timezone,
        shift.restaurant.shiftAutoCloseMinutes,
      );
      if (now < due) continue;

      // `updateMany` with the open-guard in the WHERE, not `update` by id: between the read above
      // and this write a person may have pressed the button, and the button must win. A matched
      // count of 0 means exactly that, and is not an error.
      const result = await this.prisma.shift.updateMany({
        where: { id: shift.id, closedAt: null },
        data: { closedAt: due, closeReason: "SCHEDULED" },
      });
      if (result.count > 0) {
        this.logger.info(
          { shiftId: shift.id, restaurantId: shift.restaurantId, closedAt: due.toISOString() },
          "Shift closed automatically — nobody pressed the button before the configured time",
        );
      }
    }
  }

  /**
   * The first occurrence of the venue's local close-time strictly after `openedAt`.
   *
   * A shift opened at 10:00 with the setting at 05:00 is due at 05:00 the NEXT local day, not at
   * 05:00 the same one — the setting names a moment in the small hours that ends the working day
   * that began the evening before. A shift opened at 02:00 with the setting at 05:00 is due at
   * 05:00 the SAME local day, three hours later, which is also correct: it opened after the
   * previous day's close-time had already passed.
   */
  private autoCloseDeadline(openedAt: Date, timezone: string, closeMinutes: number): Date {
    const parts = getLocalDateParts(timezone, openedAt);
    const sameDay = this.localMinuteUtc(timezone, parts, closeMinutes);
    if (sameDay > openedAt) return sameDay;

    const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    return this.localMinuteUtc(
      timezone,
      {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
      },
      closeMinutes,
    );
  }

  /** The UTC instant of `minutes` past local midnight on a given local date. Same Intl-only
   * approach as `timezone-day.util.ts`, and the same accepted DST limitation it documents. */
  private localMinuteUtc(
    timezone: string,
    date: { year: number; month: number; day: number },
    minutes: number,
  ): Date {
    const utcGuess = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
    const offset = this.offsetMs(timezone, new Date(utcGuess));
    return new Date(utcGuess - offset);
  }

  private offsetMs(timezone: string, at: Date): number {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p = Object.fromEntries(
      formatter.formatToParts(at).map((part) => [part.type, part.value]),
    ) as Record<string, string>;
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    return asUtc - at.getTime();
  }
}
