import { expect, test, type Page } from "@playwright/test";
import { registerUser } from "../fixtures/api";
import { seedRestaurantScopedMember } from "../fixtures/org";
import { restaurantCurrency, seedCapturedSale, seedOpenShift } from "../fixtures/shift";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * The Dashboard — the first authenticated screen, through a real browser against the real API.
 *
 * **What makes this a vertical slice rather than a rendered mock:** every figure asserted below is
 * one the backend computed from Ledger rows this test wrote, fetched over HTTP with a real token
 * minted by a real login. Nothing on the screen is stubbed.
 *
 * Falsified in three places, because the screen makes three independent claims:
 *   - remove the Authorization header -> the figures test must fail
 *   - remove the session guard        -> the redirect test must fail
 *   - show zeros instead of words     -> the empty-shift test must fail
 */

const SESSION_KEY = "hos.session";

async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
}

test("an owner logs in, lands on the dashboard, and reads figures the API computed", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const user = await registerUser(request);
  const { restaurantId } = await seedRestaurantScopedMember(user.email);
  const shift = await seedOpenShift(restaurantId, "16:00");

  // €120.00 taken, €3.60 of it the platform fee. The Dashboard's revenue figure is the BILL —
  // both credit lines — which is what "before platform fee deduction" means on screen.
  await seedCapturedSale(restaurantId, shift.shiftId, 12_000n, 360n);
  await seedCapturedSale(restaurantId, shift.shiftId, 3_050n, 92n);
  const currency = await restaurantCurrency(restaurantId);
  expect(currency, "the fixture assumes a euro venue").toBe("EUR");

  await logIn(page, user.email, user.password);

  // The login fork sends a restaurant-scoped Membership straight here (destination.ts).
  await expect(page).toHaveURL(new RegExp(`/restaurants/${restaurantId}$`));

  const dashboard = page.getByTestId("dashboard");
  await expect(dashboard).toBeVisible();

  // €150.50 = 12000 + 3050. Computed by the backend from the rows above, not by this test.
  await expect(page.getByTestId("revenue")).toContainText("€150.50");

  // The shift, not "today" (ADR-065): the screen must name the working day and when it opened.
  //
  // The expected clock time is derived from the instant the fixture wrote, IN THE BROWSER OWN
  // TIMEZONE, rather than compared against the literal passed to the fixture. The first version of
  // this test asserted "16:00" and failed against a correct screen showing 19:00 — the fixture
  // writes UTC and the reader sees local time. Asserting the literal would have been asserting the
  // machine timezone.
  const expectedClock = await page.evaluate(
    (iso) => new Date(iso).toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" }),
    shift.openedAtIso,
  );
  await expect(page.getByTestId("shift-line")).toContainText(expectedClock);
  await expect(page.getByTestId("shift-line")).toContainText(shift.businessDate);

  // And the empty-state explanation must NOT be showing — a screen that says "nothing sold yet"
  // over €150.50 would pass a naive "is there text" assertion.
  await expect(page.getByTestId("dashboard-empty")).toHaveCount(0);
});

test("without a session, the dashboard is not shown and the browser ends up on Log In", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const user = await registerUser(request);
  const { restaurantId } = await seedRestaurantScopedMember(user.email);
  await seedOpenShift(restaurantId);

  // No login, and nothing in storage.
  await page.goto(`/restaurants/${restaurantId}`);

  await expect(page).toHaveURL(/\/login$/);
  // Not merely redirected afterwards: the Dashboard must never have been on screen.
  await expect(page.getByTestId("dashboard")).toHaveCount(0);
});

test("a session that the API rejects does not leave a dashboard on display", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const user = await registerUser(request);
  const { restaurantId } = await seedRestaurantScopedMember(user.email);
  await seedOpenShift(restaurantId);

  await logIn(page, user.email, user.password);
  await expect(page.getByTestId("dashboard")).toBeVisible();

  // A token the server will refuse — the shape of an expired one, which is the case the Portal
  // does not yet handle (options recorded in the pull request, none chosen).
  await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) throw new Error("no session to tamper with");
    const session = JSON.parse(raw) as { accessToken: string };
    session.accessToken = `${session.accessToken.slice(0, -4)}zzzz`;
    window.localStorage.setItem(key, JSON.stringify(session));
  }, SESSION_KEY);

  await page.reload();

  // The screen says it could not load, rather than showing a figure it cannot stand behind.
  await expect(page.getByTestId("dashboard-error")).toBeVisible();
  await expect(page.getByTestId("revenue")).toHaveCount(0);
});

test("an open shift with no sales explains itself in words instead of showing zeros", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const user = await registerUser(request);
  const { restaurantId } = await seedRestaurantScopedMember(user.email);
  await seedOpenShift(restaurantId, "08:00");

  await logIn(page, user.email, user.password);

  const empty = page.getByTestId("dashboard-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("Nothing has been sold yet");

  // THE DISCRIMINATING HALF. MASTERPLAN: calm comes from explanation, never from omission — a
  // screen of zeros makes a quiet morning and a broken terminal identical. So the figure block
  // must be absent, not merely accompanied by a sentence.
  await expect(page.getByTestId("revenue")).toHaveCount(0);
  await expect(page.getByTestId("dashboard")).not.toContainText("€0.00");
});
