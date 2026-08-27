import { expect, test, type Page } from "@playwright/test";
import { API_BASE, registerUser, type SeededUser } from "../fixtures/api";
import { seedOrgWideOwner, seedRestaurantScopedMember } from "../fixtures/org";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * Log In — the first real screen, through a real browser.
 *
 * Real typing, real navigation, real API, real Postgres, real bcrypt. Nothing is faked: Stripe is
 * not involved and the breached-password check runs at registration, never at login
 * (`API_Contract.md`).
 *
 * Falsified in two places rather than one, because the screen makes two independent claims:
 *   - break the password comparison so it always succeeds -> the wrong-password half must fail
 *   - break the routing fork so it always goes to a dashboard -> the "no Memberships" case must
 *     fail. The fork is inherited by every screen in the Portal, so it earns its own proof.
 */

const SESSION_KEY = "hos.session";

async function fillAndSubmit(page: Page, email: string, password: string): Promise<void> {
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
}

async function storedSession(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY);
}

/**
 * The form's own error, not any element with `role="alert"`.
 *
 * Next.js App Router injects a route announcer that also carries `role="alert"`, so a bare
 * `getByRole("alert")` matches two elements and fails on strict mode. Scoping to the form is the
 * right fix rather than loosening the query: `role="alert"` on the message is correct for a screen
 * reader and should stay.
 */
function formError(page: Page) {
  return page.locator('form [role="alert"]');
}

let user: SeededUser;

test.beforeAll(async ({ request }) => {
  await resetRateLimits();
  user = await registerUser(request);
});

test.beforeEach(async () => {
  await resetRateLimits();
});

test("the screen says which product it is — every pre-authentication screen must", async ({
  page,
}) => {
  // DESIGN_SYSTEM.md, Product Identity On Screen. Not a brand nicety: Log In is the only screen a
  // person sees before they know where they are, and a credential form with no identifying marks
  // is the standard appearance of a phishing capture page. Teaching people that our real login
  // looks anonymous teaches them to trust anonymous credential forms.
  //
  // Asserted as a test rather than left to review because it was MISSED in review — the first
  // version of this screen shipped without it, and nothing here or in the design system objected.
  await page.goto("/login");
  const wordmark = page.locator("[data-wordmark]");
  await expect(wordmark).toBeVisible();
  await expect(wordmark).toHaveText("PlainTabs");

  // Never the accent: accent marks actions and status, and a wordmark is neither. This is also
  // what stops a restaurant's own accent (MASTERPLAN.md's branding candidate) from ever
  // recolouring our name.
  const [wordmarkColour, inkColour, accentColour] = await page.evaluate(() => {
    const el = document.querySelector("[data-wordmark]") as HTMLElement;
    const root = getComputedStyle(document.documentElement);
    return [
      getComputedStyle(el).color,
      root.getPropertyValue("--text").trim(),
      root.getPropertyValue("--accent").trim(),
    ];
  });
  expect(wordmarkColour).not.toBe(accentColour);
  expect(inkColour).not.toBe("");
});

test("the wrong password is rejected: the error is shown, the URL does not move, nothing is stored", async ({
  page,
}) => {
  await page.goto("/login");
  await fillAndSubmit(page, user.email, `${user.password}-wrong`);

  // Asserted through the role a person actually perceives, not a CSS class.
  await expect(formError(page)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(await storedSession(page)).toBeNull();
});

test("the right password is accepted, and lands where this user's Memberships say", async ({
  page,
}) => {
  // The other half of the pair. Either alone proves nothing: the test above passes against a
  // screen that rejects everything, and this one passes against a screen that accepts everything.
  // Only together do they say the password is actually being checked.
  await page.goto("/login");
  await fillAndSubmit(page, user.email, user.password);

  // A freshly registered User has zero Memberships (DATABASE.md), so the fork sends them to
  // Create Your Restaurant.
  await expect(page).toHaveURL(/\/onboarding\/restaurant$/);
  expect(await storedSession(page)).not.toBeNull();
});

test("the three-way fork: an org-wide Membership lands on the Restaurants list", async ({
  page,
  request,
}) => {
  const owner = await registerUser(request);
  // The Restaurant is seeded directly, under the narrow rule in fixtures/org.ts: the entity being
  // created is not the subject of the check. What decides this branch is the Membership, and the
  // login endpoint reads that back from the real database through its own real query.
  await seedOrgWideOwner(owner.email, `Fork Org-Wide ${Date.now()}`);

  await resetRateLimits();
  await page.goto("/login");
  await fillAndSubmit(page, owner.email, owner.password);

  await expect(page).toHaveURL(/\/restaurants$/);
});

test("the three-way fork: a single restaurant-scoped Membership lands on that Restaurant's Dashboard", async ({
  page,
  request,
}) => {
  const waiter = await registerUser(request);
  const { restaurantId } = await seedRestaurantScopedMember(
    waiter.email,
    `Fork Scoped ${Date.now()}`,
  );

  await resetRateLimits();
  await page.goto("/login");
  await fillAndSubmit(page, waiter.email, waiter.password);

  // The discriminating half of this branch: it must reach THAT restaurant, not merely some
  // /restaurants/... path. A fork that built the URL from the organization id would pass a looser
  // assertion and send every scoped member to the wrong place.
  await expect(page).toHaveURL(new RegExp(`/restaurants/${restaurantId}$`));
});

test("rate limiting is explained, not disguised as a wrong password", async ({ page, request }) => {
  // UX_MAP.md is explicit about this one: a person told "wrong password" ten times will change a
  // password that was never wrong. The screen must say what actually happened.
  const victim = await registerUser(request);
  await resetRateLimits();
  for (let i = 0; i < 11; i += 1) {
    await request.post(`${API_BASE}/api/v1/auth/login`, {
      data: { email: victim.email, password: `${victim.password}-wrong-${i}` },
    });
  }

  await page.goto("/login");
  await fillAndSubmit(page, victim.email, victim.password);

  const alert = formError(page);
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Too many attempts");
  await expect(alert).not.toContainText("don’t match");
});
