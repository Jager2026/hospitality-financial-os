import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { registerUser } from "../fixtures/api";
import { seedOrgWideOwner, setStripeState, type StripeState } from "../fixtures/org";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * What the Dashboard says about Stripe — one message per state, in a real browser.
 *
 * **The unit spec (`stripe-state.spec.ts`) proves the rule; this proves the screen asks it.** Those
 * are different claims, and only the second would have caught the defect that produced this file:
 * the rule was never wrong, because there was no rule — the component tested one field inline. A
 * correct pure function sitting beside a component that never calls it looks identical to this
 * from the outside.
 *
 * Falsified by restoring the old condition (`payoutsStatus != null && !== "active"`): the
 * not-started test must fail, and today it would have passed, because the old rule renders nothing
 * and nothing is what a test asserting "no banner" happily accepts.
 */

async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  // The stored session, not a URL: clicking submit returns before the response has been stored,
  // and navigating straight afterwards races it into a redirect back to Log In.
  await page.waitForFunction(() => window.localStorage.getItem("hos.session") !== null);
}

/** A venue in a given Stripe state, opened on its own Dashboard. */
async function openDashboardInState(
  page: Page,
  request: APIRequestContext,
  state: StripeState,
  name: string,
): Promise<void> {
  await resetRateLimits();
  const user = await registerUser(request);
  const org = await seedOrgWideOwner(user.email, name);
  await setStripeState(org.restaurantId, state);

  await logIn(page, user.email, user.password);
  await page.goto(`/restaurants/${org.restaurantId}`);
  await expect(page.getByTestId("dashboard")).toBeVisible();
}

test("a venue that never started Stripe is told cards cannot be taken", async ({
  page,
  request,
}) => {
  await openDashboardInState(page, request, "not_started", "Never onboarded — Vilnius");

  // THE CASE THE OLD CONDITION MISSED. Both capabilities are null, so `payoutsStatus !== "active"`
  // was true and `payoutsStatus != null` was false: the venue least able to take money was the one
  // the Dashboard said nothing about, while the Restaurants list said it plainly.
  const banner = page.getByTestId("stripe-banner-cards");
  await expect(banner, "the worst-prepared venue got no banner at all").toBeVisible();
  await expect(banner).toContainText("Card payments are not switched on here yet");
  // Not a warning — an explanation with the thing that changes it.
  await expect(banner).toContainText("payment setup");

  await expect(
    page.getByTestId("stripe-banner-payouts"),
    "a venue that cannot charge was told about payouts, which is the second question",
  ).toHaveCount(0);
});

test("a venue that can charge but cannot be paid out is told about payouts", async ({
  page,
  request,
}) => {
  await openDashboardInState(page, request, "payouts_held", "Payouts held — Kaunas");

  const banner = page.getByTestId("stripe-banner-payouts");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Payouts are not switched on yet");
  await expect(banner, "the money sounds lost rather than held").toContainText("held at Stripe");

  await expect(
    page.getByTestId("stripe-banner-cards"),
    "a venue that takes cards was told it cannot",
  ).toHaveCount(0);
});

test("a fully live venue is told nothing about Stripe", async ({ page, request }) => {
  await openDashboardInState(page, request, "live", "Fully live — Klaipėda");

  // The third state is the absence of the other two, so it is asserted as both being absent
  // rather than as "no banner" — a single shared testid would have made this test unable to see
  // the wrong banner appearing.
  await expect(page.getByTestId("stripe-banner-cards")).toHaveCount(0);
  await expect(page.getByTestId("stripe-banner-payouts")).toHaveCount(0);
});
