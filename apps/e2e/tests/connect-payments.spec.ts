import { expect, test, type Page } from "@playwright/test";
import { API_BASE, registerUser } from "../fixtures/api";
import {
  seedMemberWithRole,
  setStripeAccountId,
  seedOrgWideOwner,
  setStripeState,
  type StripeState,
} from "../fixtures/org";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * Connect Payments — the screen that finally calls `POST /restaurants/:id/onboarding-link`.
 *
 * ── What this suite CANNOT prove, said before what it can ──────────────────────────────────────
 *
 * **The success path is not exercised anywhere, and cannot be from here.** Minting a real Account
 * Link is a live Stripe call, and ADR-041 permits replacing only a literal outbound third-party
 * call — which the harness does not do, because it runs the real backend. Every request below is
 * therefore refused before Stripe is reached: by the permission check, by the missing Stripe
 * account on a fixture-inserted venue, or by the throttle. That is enough to prove the three
 * things this screen must get right about refusals, and it is not evidence that a real link
 * works.
 */

async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.localStorage.getItem("hos.session") !== null);
}

async function openConnect(page: Page, restaurantId: string): Promise<void> {
  await page.goto(`/restaurants/${restaurantId}/onboarding`);
}

/** The access token the browser is holding, so a test can ask the API the same question directly. */
async function accessToken(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const raw = window.localStorage.getItem("hos.session");
    return raw === null ? "" : (JSON.parse(raw) as { accessToken: string }).accessToken;
  });
}

test("a Manager is not offered payment setup, and the API refuses them as well", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const manager = await registerUser(request);
  const org = await seedMemberWithRole(manager.email, "Manager", "Managed — Vilnius");

  await logIn(page, manager.email, manager.password);
  await openConnect(page, org.restaurantId);

  // The screen loaded — a Manager reaches this venue. What they do not hold is `restaurant.create`.
  await expect(page.getByTestId("connect-payments")).toBeVisible();
  await expect(page.getByTestId("connect-not-allowed")).toBeVisible();
  await expect(
    page.getByTestId("connect-continue"),
    "a Manager was offered a button the server would refuse",
  ).toHaveCount(0);

  // The account id goes on NOW, not at seeding time, and the order is the whole point: with one
  // set, GET /restaurants/:id calls Stripe on every read (refreshStripeStatus) and the screen above
  // could not load at all. It is needed only for the POST below, where it removes the second cause
  // of a 404 so the refusal can be attributed to the permission and nothing else.
  await setStripeAccountId(org.restaurantId, `acct_e2e_${org.restaurantId.slice(0, 8)}`);

  // THE HALF THAT MATTERS. Hiding a button is presentation; the refusal has to be real. Asked
  // directly, with the Manager's own token, the API must still say no — an implementation whose
  // only check is the browser's would pass the assertions above and fail this one.
  const refused = await request.post(
    `${API_BASE}/api/v1/restaurants/${org.restaurantId}/onboarding-link`,
    { headers: { Authorization: `Bearer ${await accessToken(page)}` } },
  );
  expect(refused.status(), "the API let a Manager mint a Stripe onboarding link").toBe(404);
});

test("a Waiter is not offered payment setup either", async ({ page, request }) => {
  await resetRateLimits();
  const waiter = await registerUser(request);
  const org = await seedMemberWithRole(waiter.email, "Waiter", "Staffed — Kaunas");

  await logIn(page, waiter.email, waiter.password);
  await openConnect(page, org.restaurantId);

  await expect(page.getByTestId("connect-not-allowed")).toBeVisible();
  await expect(page.getByTestId("connect-continue")).toHaveCount(0);

  // Same ordering as above: set after the screen has loaded, needed only for the POST.
  await setStripeAccountId(org.restaurantId, `acct_e2e_${org.restaurantId.slice(0, 8)}`);

  const refused = await request.post(
    `${API_BASE}/api/v1/restaurants/${org.restaurantId}/onboarding-link`,
    { headers: { Authorization: `Bearer ${await accessToken(page)}` } },
  );
  expect(refused.status(), "the API let a Waiter mint a Stripe onboarding link").toBe(404);
});

test("an exhausted rate limit is explained in words, not shown as a breakage", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Rate limited — Vilnius");

  await logIn(page, owner.email, owner.password);
  const token = await accessToken(page);

  // Ten per hour, per address (#125). The throttle counts requests, not successes, so spending the
  // budget does not need Stripe to be reachable — which is the only reason this is testable here.
  for (let i = 0; i < 10; i++) {
    await request.post(`${API_BASE}/api/v1/restaurants/${org.restaurantId}/onboarding-link`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  await openConnect(page, org.restaurantId);
  await page.getByTestId("connect-continue").click();

  const explained = page.getByTestId("connect-rate-limited");
  await expect(explained, "a 429 was rendered as a failure rather than a wait").toBeVisible();
  await expect(explained).toContainText("last hour");
  await expect(explained).toContainText("Wait");

  // Still on the screen: a rate limit is a pause, not a dead end, and the person must be able to
  // read where the venue stands while they wait.
  await expect(page.getByTestId("connect-payments")).toBeVisible();
});

test("a restaurant whose onboarding is complete is not invited to start again", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Already live — Klaipėda");
  await setStripeState(org.restaurantId, "live" satisfies StripeState);

  await logIn(page, owner.email, owner.password);
  await openConnect(page, org.restaurantId);

  await expect(page.getByTestId("connect-complete")).toBeVisible();
  await expect(
    page.getByTestId("connect-continue"),
    "a finished restaurant was offered its onboarding again",
  ).toHaveCount(0);
  await expect(page.getByTestId("connect-payments")).toHaveCount(0);
});

test("Stripe's own return URL lands on a real screen, and the expired one says so", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Returning — Vilnius");

  await logIn(page, owner.email, owner.password);

  // Both of these are addresses the BACKEND gives Stripe (`restaurant.service.ts`), and neither
  // existed in the Portal: finishing onboarding used to end on a 404.
  await page.goto(`/restaurants/${org.restaurantId}/onboarding/complete`);
  await expect(page.getByTestId("connect-returned")).toBeVisible();

  await page.goto(`/restaurants/${org.restaurantId}/onboarding/refresh`);
  const expired = page.getByTestId("connect-link-expired");
  await expect(expired, "an expired link was shown as though it still worked").toBeVisible();
  await expect(expired).toContainText("expired");
});

test("the dashboard banner now leads somewhere", async ({ page, request }) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Not onboarded — Vilnius");

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}`);

  // #178 left the banner naming an action with nothing to press, because this screen did not
  // exist. The words are a route now.
  await page.getByTestId("stripe-banner-action").click();
  await expect(page).toHaveURL(new RegExp(`/restaurants/${org.restaurantId}/onboarding$`));
  await expect(page.getByTestId("connect-payments")).toBeVisible();
});
