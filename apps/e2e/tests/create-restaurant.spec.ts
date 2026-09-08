import { expect, test, type Page } from "@playwright/test";
import { API_BASE, registerUser } from "../fixtures/api";
import { seedMemberWithRole, seedOrgWideOwner } from "../fixtures/org";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * Create Your Restaurant — the screen that closes the gap between registering and a Dashboard.
 *
 * ── What this suite cannot prove, said first ───────────────────────────────────────────────────
 *
 * **The success path is unreachable here, and deterministically so.** `POST /restaurants` creates a
 * real Stripe Connect account before it writes anything, and the harness runs the backend with a
 * placeholder key (`playwright.config.ts`) — locally and in CI alike. So every create in this file
 * fails at the Stripe call and answers 500. That is a limitation and also the thing that makes the
 * failure half of this screen testable with a **real** backend failure rather than a faked one:
 * nothing here intercepts or stubs a request.
 *
 * "Success leads to payment setup rather than the Dashboard" was therefore verified by hand,
 * locally, against real Stripe — and the account that verification created was closed afterwards.
 */

async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.localStorage.getItem("hos.session") !== null);
}

async function accessToken(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const raw = window.localStorage.getItem("hos.session");
    return raw === null ? "" : (JSON.parse(raw) as { accessToken: string }).accessToken;
  });
}

async function fillTheForm(page: Page, name: string): Promise<void> {
  await page.fill("#name", name);
  await page.fill("#legalName", `${name} UAB`);
  await page.fill("#companyNumber", "300000000");
  await page.fill("#vatNumber", "LT100000000000");
  await page.fill("#email", "owner@example.test");
  await page.fill("#phone", "+37060000000");
  await page.fill("#address", "Gedimino pr. 1, Vilnius");
}

test("a just-registered person is shown the form, with every field the API requires", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const user = await registerUser(request);

  await logIn(page, user.email, user.password);
  await expect(page).toHaveURL(/\/onboarding\/restaurant$/);

  await expect(page.getByTestId("create-restaurant-form")).toBeVisible();
  for (const field of [
    "name",
    "legalName",
    "companyNumber",
    "vatNumber",
    "email",
    "phone",
    "address",
    "timezone",
  ]) {
    await expect(page.locator(`#${field}`), `the form is missing ${field}`).toBeVisible();
  }

  // Country and currency are settled rather than offered (ADR-012), and the screen says why —
  // they are fixed at Stripe account creation and a change means a different restaurant.
  await expect(page.getByTestId("create-restaurant-fixed")).toContainText("cannot be changed");
});

test("a Manager cannot add a restaurant to the organization they work in", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const manager = await registerUser(request);
  const org = await seedMemberWithRole(manager.email, "Manager", "Employer — Vilnius");

  await logIn(page, manager.email, manager.password);

  // THE REAL CHECK, and it is at the API. `restaurant.create` is what the org-scoped route
  // demands, and a Manager does not hold it — remove that check on the server and this fails.
  const refused = await request.post(
    `${API_BASE}/api/v1/organizations/${org.organizationId}/restaurants`,
    {
      headers: { Authorization: `Bearer ${await accessToken(page)}` },
      data: {
        name: "Sneaked In",
        legalName: "Sneaked In UAB",
        companyNumber: "300000000",
        vatNumber: "LT100000000000",
        email: "sneak@example.test",
        phone: "+37060000000",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Gedimino pr. 1, Vilnius",
      },
    },
  );
  expect(refused.status(), "a Manager added a venue to their employer's organization").toBe(403);
});

test("a Waiter cannot either", async ({ page, request }) => {
  await resetRateLimits();
  const waiter = await registerUser(request);
  const org = await seedMemberWithRole(waiter.email, "Waiter", "Employer — Kaunas");

  await logIn(page, waiter.email, waiter.password);

  const refused = await request.post(
    `${API_BASE}/api/v1/organizations/${org.organizationId}/restaurants`,
    {
      headers: { Authorization: `Bearer ${await accessToken(page)}` },
      data: {
        name: "Sneaked In",
        legalName: "Sneaked In UAB",
        companyNumber: "300000000",
        vatNumber: "LT100000000000",
        email: "sneak@example.test",
        phone: "+37060000000",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Gedimino pr. 1, Vilnius",
      },
    },
  );
  expect(refused.status(), "a Waiter added a venue to their employer's organization").toBe(403);
});

test("a failure whose outcome is unknown offers a check, never a second attempt", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const user = await registerUser(request);

  await logIn(page, user.email, user.password);
  await fillTheForm(page, "Ambiguous Failure Venue");
  await page.getByTestId("create-restaurant-submit").click();

  // A real 500 from a real backend: the Stripe call fails against the harness's placeholder key.
  // The screen cannot tell that from a transaction that failed *after* an account was created, and
  // must not guess — the API's own message on this status is "please try again", and trying again
  // is what mints a second Stripe account.
  const unknown = page.getByTestId("create-restaurant-unknown");
  await expect(unknown).toBeVisible();
  await expect(unknown).toContainText("cannot tell");

  // THE DISCRIMINATING ASSERTION. Not "the button is disabled" — the button is GONE. A disabled
  // button that comes back is exactly the state this screen exists to avoid.
  await expect(
    page.getByTestId("create-restaurant-submit"),
    "a second attempt was offered after an unattributable failure",
  ).toHaveCount(0);
  await expect(page.getByTestId("create-restaurant-verify")).toBeVisible();

  // And the check is real: it asks what exists, finds nothing, and only then offers another go.
  await page.getByTestId("create-restaurant-verify").click();
  await expect(page.getByTestId("create-restaurant-error")).toContainText(
    "no restaurant was created",
  );
  await expect(page.getByTestId("create-restaurant-submit")).toBeVisible();

  // Nothing was created by any of that, asked of the API rather than assumed from the screen.
  const list = await request.get(`${API_BASE}/api/v1/restaurants`, {
    headers: { Authorization: `Bearer ${await accessToken(page)}` },
  });
  const body = (await list.json()) as { data: unknown[] };
  expect(body.data, "the failed attempt left a restaurant behind").toHaveLength(0);
});

test("somebody with two businesses is not guessed at", async ({ page, request }) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  await seedOrgWideOwner(owner.email, "First chain — Vilnius");
  await seedOrgWideOwner(owner.email, "Second chain — Kaunas");

  await logIn(page, owner.email, owner.password);
  await page.goto("/onboarding/restaurant");

  // Two org-wide Memberships, no organization picker anywhere in the Portal. Writing the venue
  // into the wrong business is not an edit anybody can undo, so the screen stops instead.
  await expect(page.getByTestId("create-restaurant-ambiguous")).toBeVisible();
  await expect(page.getByTestId("create-restaurant-submit")).toHaveCount(0);
});
