import { expect, test, type Page } from "@playwright/test";
import { registerUser } from "../fixtures/api";
import { seedMemberWithRole, seedOrgWideOwner } from "../fixtures/org";
import { seedCapturedSale, seedOpenShift } from "../fixtures/shift";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * Analytics — the screen where the same money has two legitimate readings, and the screen must say
 * which one it is showing.
 *
 * ── The one assertion this file exists for ────────────────────────────────────────────────────
 *
 * A shift that opens at 22:00 and takes money again at 00:30 belongs to ONE working day. A
 * shift-scoped figure reports all of it against that day; a calendar-scoped figure splits it at
 * midnight. **The two disagree only in that arrangement**, which is why the fixture has to build
 * it deliberately — a test seeding both sales at the same instant passes against either
 * implementation and proves nothing (CLAUDE.md, on the discriminating pair).
 *
 * ── What is NOT asserted here, and why ────────────────────────────────────────────────────────
 *
 * *"A person holding `reports.view` but not `data.export` sees the screen without an export
 * button."* **That person cannot be constructed.** Roles are reference data — nothing in this
 * repository creates one outside `prisma/seed.ts` — and all four roles that hold `reports.view`
 * (Owner, Administrator, Manager, Accountant) also hold `data.export`, while Waiter holds neither.
 * Building a Membership here with a hand-made Role would be the fixture drift `CLAUDE.md` records
 * twice: a test describing a user the seed cannot produce.
 *
 * The behaviour is still worth protecting, so it is asserted at the layer that actually holds the
 * rule. The screen reads permissions from the **session in the browser**, not from the database, so
 * the last test here strips `data.export` out of that session and asserts the screen degrades into
 * absence rather than into an error. The per-area table behind it is covered separately and purely,
 * in `apps/frontend/src/lib/api/analytics.spec.ts`.
 *
 * A component test would have been the third option and was not taken: the frontend has no DOM test
 * harness at all — no jsdom, no testing-library — and introducing one for a single case is a larger
 * decision than this screen should make on its own.
 */

async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.localStorage.getItem("hos.session") !== null);
}

/** Yesterday, so the shift's own after-midnight half is still in the past. */
function yesterdayIso(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

test("a shift that ran past midnight is reported whole, against the day the venue calls it", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Late — Vilnius");

  const businessDate = yesterdayIso();
  const shift = (await seedOpenShift(org.restaurantId, "22:00", businessDate)).shiftId;

  // 9,00 before midnight and 4,50 after it, on ONE shift. A shift-scoped figure says 13,50
  // against yesterday; a calendar-scoped one says 9,00 and files the rest under today.
  await seedCapturedSale(org.restaurantId, shift, 900n, 9n, "EUR", `${businessDate}T22:30:00.000Z`);
  await seedCapturedSale(org.restaurantId, shift, 450n, 5n, "EUR", `${todayIso()}T00:30:00.000Z`);

  await logIn(page, owner.email, owner.password);
  await page.goto(
    `/restaurants/${org.restaurantId}/analytics?area=revenue&from=${businessDate}&to=${businessDate}`,
  );

  const total = page.getByTestId("analytics-revenue-total");
  await expect(total).toBeVisible();

  // THE DISCRIMINATING ASSERTION. Both halves are named: the right answer must be present and the
  // calendar answer must be absent, because "contains 13,50" alone would still pass a screen that
  // showed both figures somewhere.
  await expect(total, "the after-midnight half of the shift was dropped").toContainText("13,50");
  await expect(
    total,
    "the figure was cut at midnight, which is the calendar cut",
  ).not.toContainText("9,00");

  // And the screen says which cut it is, because the figure alone cannot.
  await expect(page.getByTestId("analytics-scope")).toContainText("not calendar days");
});

test("an accountant reads the figures and can take them out of the building", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const accountant = await registerUser(request);
  const org = await seedMemberWithRole(accountant.email, "Accountant", "Booked — Kaunas");
  const shift = (await seedOpenShift(org.restaurantId)).shiftId;
  await seedCapturedSale(org.restaurantId, shift, 2000n, 20n);

  await logIn(page, accountant.email, accountant.password);
  await page.goto(`/restaurants/${org.restaurantId}/analytics`);

  await expect(page.getByTestId("analytics")).toBeVisible();
  await expect(page.getByTestId("analytics-revenue-total")).toContainText("20,00");

  // ADR-066: the accountant's two permissions are exactly "read the figures" and "take them out".
  // Revenue is one of the three areas that offers both cuts (ADR-067), so both buttons are here.
  await expect(page.getByTestId("analytics-export-calendar")).toBeVisible();
  await expect(page.getByTestId("analytics-export-by-shift")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByTestId("analytics-export-by-shift").click();
  const file = await download;
  expect(file.suggestedFilename()).toContain("revenue-by-shift");

  // The export produced a file rather than an error on the screen — the half that would fail if
  // the CSV were read through the JSON envelope reader.
  await expect(page.getByTestId("analytics-export-error")).toHaveCount(0);
});

test("a waiter is refused the figures, and told why rather than shown a fault", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const waiter = await registerUser(request);
  const org = await seedMemberWithRole(waiter.email, "Waiter", "Staffed — Klaipėda");
  const shift = (await seedOpenShift(org.restaurantId)).shiftId;
  await seedCapturedSale(org.restaurantId, shift, 3000n, 30n);

  await logIn(page, waiter.email, waiter.password);
  await page.goto(`/restaurants/${org.restaurantId}/analytics`);

  // A Waiter holds ZERO permissions, so `reports.view` refuses the whole screen. It says so
  // instead of offering a retry that cannot work.
  await expect(page.getByTestId("analytics-error")).toContainText(
    "owners, managers and accountants",
  );
  await expect(page.getByTestId("analytics-revenue-total")).toHaveCount(0);
  await expect(page.getByTestId("analytics-exports")).toHaveCount(0);
});

test("a period with no sales and a venue with no history are different screens", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Brand new — Šiauliai");

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}/analytics`);

  // Nothing has ever been sold: the screen says so, and says nothing is missing.
  await expect(page.getByTestId("analytics-empty-ever")).toBeVisible();
  await expect(page.getByTestId("analytics-empty-period")).toHaveCount(0);

  // Now give the venue a history, and ask about a period that excludes it. THE DISCRIMINATING
  // PAIR: the same zero, opposite meanings — one says the venue has never traded, the other says
  // these dates did not catch it.
  const shift = (await seedOpenShift(org.restaurantId)).shiftId;
  await seedCapturedSale(org.restaurantId, shift, 5000n, 50n);

  const longAgo = "2025-01-01";
  await page.goto(
    `/restaurants/${org.restaurantId}/analytics?area=revenue&from=${longAgo}&to=${longAgo}`,
  );

  await expect(page.getByTestId("analytics-empty-period")).toBeVisible();
  await expect(
    page.getByTestId("analytics-empty-ever"),
    "a venue that has traded was described as one that never has",
  ).toHaveCount(0);
});

test("a session that cannot export sees the screen without the buttons, not a broken screen", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Read only — Panevėžys");
  const shift = (await seedOpenShift(org.restaurantId)).shiftId;
  await seedCapturedSale(org.restaurantId, shift, 7000n, 70n);

  await logIn(page, owner.email, owner.password);

  // The person this describes cannot be built from a Role — see this file's header. What CAN be
  // built, and is what the screen actually reads, is a session whose memberships do not carry the
  // permission. Stripping it here tests the screen's own rule at the layer that holds it, rather
  // than inventing a Role the seed cannot produce.
  //
  // This is presentation, never protection: the server's answer does not change: it would still
  // allow this owner to export. That is the point — the button is a claim about what is worth
  // offering, and a wrong claim must degrade into absence rather than into an error.
  await page.evaluate(() => {
    const raw = window.localStorage.getItem("hos.session");
    if (raw === null) throw new Error("no session to edit");
    const session = JSON.parse(raw) as {
      memberships: { role?: { permissions: string[] } }[];
    };
    for (const membership of session.memberships) {
      if (membership.role) {
        membership.role.permissions = membership.role.permissions.filter(
          (p) => p !== "data.export",
        );
      }
    }
    window.localStorage.setItem("hos.session", JSON.stringify(session));
  });

  await page.goto(`/restaurants/${org.restaurantId}/analytics`);

  // The screen works: the figure is there, read with the permission it does still hold.
  await expect(page.getByTestId("analytics")).toBeVisible();
  await expect(page.getByTestId("analytics-revenue-total")).toContainText("70,00");
  await expect(page.getByTestId("analytics-scope")).toBeVisible();

  // And the export is simply absent — no button, no error, nothing to explain.
  await expect(page.getByTestId("analytics-exports")).toHaveCount(0);
  await expect(page.getByTestId("analytics-export-error")).toHaveCount(0);
  await expect(page.getByTestId("analytics-error")).toHaveCount(0);

  // Switching areas still works, which is the half that would fail if the missing permission had
  // thrown rather than rendered nothing.
  await page.getByTestId("analytics-area-tips").click();
  await expect(page.getByTestId("analytics-tips-total")).toBeVisible();
  await expect(page.getByTestId("analytics-exports")).toHaveCount(0);
});
