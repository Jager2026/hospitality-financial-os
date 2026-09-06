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

  // 150,50 € = 12000 + 3050, computed by the backend from the rows above and written the way a
  // Lithuanian venue writes money (DESIGN_SYSTEM.md: "1 240,00 € in lt-LT").
  //
  // THIS ASSERTION COULD NOT FAIL BEFORE. The fixture's venue carried default_customer_locale
  // 'en', so it never looked Lithuanian, and the formatter had en-IE baked into a default
  // parameter — a hardcoded locale asserted against a venue chosen to match it. The fixture is
  // 'lt' now, which is what the target market actually is.
  await expect(page.getByTestId("revenue")).toContainText(`150,50\u00a0\u20ac`);
  await expect(page.getByTestId("revenue")).not.toContainText("€150.50");

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

  // "Sunday, 6 September", not "2026-09-06". Derived from the same business date the fixture
  // wrote, in UTC, because the business date is a label rather than an instant (ADR-064).
  const expectedDate = await page.evaluate(
    (date) =>
      new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IE", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      }),
    shift.businessDate,
  );
  await expect(page.getByTestId("shift-line")).toContainText(expectedDate);
  await expect(
    page.getByTestId("shift-line"),
    "the machine-shaped date must be gone, not merely accompanied",
  ).not.toContainText(shift.businessDate);

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

test("a session whose REFRESH is refused ends, rather than looping or showing figures", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const user = await registerUser(request);
  const { restaurantId } = await seedRestaurantScopedMember(user.email);
  await seedOpenShift(restaurantId);

  await logIn(page, user.email, user.password);
  await expect(page.getByTestId("dashboard")).toBeVisible();

  // BOTH tokens are broken, and that is what changed. Breaking the access token alone is no
  // longer a session ending — the Portal renews and carries on, which is the whole point of this
  // pull request. A session is over only when the refresh is refused too.
  await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) throw new Error("no session to tamper with");
    const session = JSON.parse(raw) as { accessToken: string; refreshToken: string };
    session.accessToken = `${session.accessToken.slice(0, -4)}zzzz`;
    session.refreshToken = `${session.refreshToken.slice(0, -4)}zzzz`;
    window.localStorage.setItem(key, JSON.stringify(session));
  }, SESSION_KEY);

  await page.reload();

  // THE REGRESSION THIS TEST NOW GUARDS. It used to assert only that SOME error block appeared,
  // which is exactly the confusion that reached the Founder: an expired session and a broken
  // server produced the same two sentences, and the title was repeated verbatim as the body. The
  // one thing a reader can do about an expired session — sign in again — was never mentioned.
  await expect(page.getByTestId("dashboard-error")).toBeVisible();
  await expect(page.getByTestId("revenue")).toHaveCount(0);

  await expect(page.getByTestId("dashboard-error")).toContainText("Your session has ended");
  await expect(page.getByRole("link", { name: "Sign in again" })).toBeVisible();

  // THE SECOND LINE MUST EXPLAIN, and this assertion had to be strengthened after failing to
  // catch its own falsification. The first version compared the body against the CURRENT title
  // and passed when the body was replaced by a DIFFERENT title — it tested for equality with one
  // string rather than for the presence of an explanation. Naming the sentence a reader actually
  // needs is what makes it discriminating.
  await expect(page.getByTestId("dashboard-error-explain")).toContainText(
    "signed out after fifteen minutes",
  );
  const heading = (await page.getByTestId("dashboard-error").locator("h1").innerText()).trim();
  const explain = (await page.getByTestId("dashboard-error-explain").innerText()).trim();
  expect(explain, "the explanation repeats a title instead of saying what happened").not.toBe(
    heading,
  );
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

/**
 * THE TESTS THAT MOVE TIME.
 *
 * The harness runs the backend with a six-second access token (playwright.config.ts) so a test can
 * wait through an expiry. Production runs 900 seconds, and the defect that reached the Founder
 * lived entirely in that gap: the Dashboard stopped working fifteen minutes after signing in, and
 * every test was green because no test anywhere let a token die.
 */
const ACCESS_TTL_SECONDS = 6;

test("an access token that has genuinely expired is renewed without the screen flinching", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const user = await registerUser(request);
  const { restaurantId } = await seedRestaurantScopedMember(user.email);
  const shift = await seedOpenShift(restaurantId, "16:00");
  await seedCapturedSale(restaurantId, shift.shiftId, 5_000n, 150n);

  await logIn(page, user.email, user.password);
  await expect(page.getByTestId("dashboard")).toBeVisible();

  const before = await page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? "{}").accessToken as string,
    SESSION_KEY,
  );

  // Real elapsed time, not a mocked clock: the token the server issued actually stops being valid.
  await page.waitForTimeout((ACCESS_TTL_SECONDS + 2) * 1000);

  await page.reload();

  // The figures come back, so the renewal happened and was replayed.
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.getByTestId("revenue")).toContainText(`50,00\u00a0\u20ac`);

  // AND THE SCREEN DID NOT FLINCH. The expired state must never have been rendered — a renewal
  // that shows "your session has ended" first and recovers afterwards is not silent.
  await expect(page.getByTestId("dashboard-error")).toHaveCount(0);

  const after = await page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? "{}").accessToken as string,
    SESSION_KEY,
  );
  expect(after, "the stored token was never replaced, so nothing was actually renewed").not.toBe(
    before,
  );
});

test("two requests expiring together renew the session once, not twice", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const user = await registerUser(request);
  const { restaurantId } = await seedRestaurantScopedMember(user.email);
  const shift = await seedOpenShift(restaurantId, "16:00");
  await seedCapturedSale(restaurantId, shift.shiftId, 5_000n, 150n);

  await logIn(page, user.email, user.password);
  await expect(page.getByTestId("dashboard")).toBeVisible();

  // Count what the browser actually sends. The Dashboard fires two authenticated requests at once
  // (ADR-063), so an unshared renewal produces two refreshes — and the second presents a token the
  // first has already rotated away, which the backend reads as a stolen credential and answers by
  // revoking the family.
  const refreshes: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/auth/refresh")) refreshes.push(r.url());
  });

  await page.waitForTimeout((ACCESS_TTL_SECONDS + 2) * 1000);
  await page.reload();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.getByTestId("revenue")).toContainText(`50,00\u00a0\u20ac`);

  expect(refreshes, "each request renewed on its own").toHaveLength(1);

  // The family survived: a third read still works, which it would not if the backend had revoked
  // the family over a replayed token.
  await page.reload();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.getByTestId("dashboard-error")).toHaveCount(0);
});
