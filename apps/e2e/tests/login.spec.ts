import { expect, test, type Page } from "@playwright/test";
import { API_BASE, registerUser, type SeededUser } from "../fixtures/api";
import { queryOne } from "../fixtures/db";
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

// BLOCKED, not deleted: `POST /restaurants` creates a real Stripe Connect account, so this
// branch cannot be reached in the browser without a working Stripe test key in CI. Confirmed by
// the error itself — StripeAuthenticationError from StripeService.createConnectAccount, not a
// guess. The fork LOGIC is proved at every branch by destination.spec.ts; what is missing is the
// browser path. Options are in the accompanying report; awaiting the Founder rather than working
// around it.
test.fixme("the three-way fork: an org-wide Membership lands on the Restaurants list", async ({
  page,
  request,
}) => {
  const owner = await registerUser(request);
  // Created through the real API, exactly as a real owner would: POST /restaurants creates the
  // Organization and the org-wide Membership together (ADR-005). Nothing is inserted directly.
  const session = await loginViaApi(request, owner);
  await createRestaurant(request, session.accessToken, "Fork Org-Wide");

  await resetRateLimits();
  await page.goto("/login");
  await fillAndSubmit(page, owner.email, owner.password);

  await expect(page).toHaveURL(/\/restaurants$/);
});

// BLOCKED for the same reason as above — needs a real Restaurant, which needs Stripe.
test.fixme("the three-way fork: a single restaurant-scoped Membership lands on that Restaurant’s Dashboard", async ({
  page,
  request,
}) => {
  // Built the way the product builds it: an owner creates a Restaurant, invites someone scoped to
  // it, and that person accepts. Every step is a real endpoint.
  const owner = await registerUser(request);
  const ownerSession = await loginViaApi(request, owner);
  const restaurant = await createRestaurant(request, ownerSession.accessToken, "Fork Scoped");

  const waiterEmail = `e2e-waiter-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const waiterPassword = `e2e-${Math.random().toString(36).slice(2)}-Aa1!`;
  const roleId = await waiterRoleId();

  const invited = await request.post(`${API_BASE}/api/v1/memberships`, {
    headers: { Authorization: `Bearer ${ownerSession.accessToken}` },
    data: { email: waiterEmail, restaurantId: restaurant.id, roleId },
  });
  expect(invited.ok(), await invited.text()).toBeTruthy();
  const invitation = (await invited.json()) as { data: { token: string } };

  await resetRateLimits();
  const accepted = await request.post(`${API_BASE}/api/v1/memberships/invitations/accept`, {
    data: {
      email: waiterEmail,
      token: invitation.data.token,
      password: waiterPassword,
      displayName: "Fork Waiter",
    },
  });
  expect(accepted.ok(), await accepted.text()).toBeTruthy();

  await resetRateLimits();
  await page.goto("/login");
  await fillAndSubmit(page, waiterEmail, waiterPassword);

  await expect(page).toHaveURL(new RegExp(`/restaurants/${restaurant.id}$`));
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

// ── helpers, all going through real endpoints ────────────────────────────────────────────────

async function loginViaApi(
  request: import("@playwright/test").APIRequestContext,
  who: SeededUser,
): Promise<{ accessToken: string }> {
  await resetRateLimits();
  const response = await request.post(`${API_BASE}/api/v1/auth/login`, {
    data: { email: who.email, password: who.password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { data: { accessToken: string } };
  return body.data;
}

async function createRestaurant(
  request: import("@playwright/test").APIRequestContext,
  accessToken: string,
  name: string,
): Promise<{ id: string }> {
  const response = await request.post(`${API_BASE}/api/v1/restaurants`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: {
      name,
      legalName: `${name} UAB`,
      companyNumber: "300000000",
      vatNumber: "LT100000000000",
      email: `contact-${Math.random().toString(36).slice(2)}@example.test`,
      phone: "+37060000000",
      country: "LT",
      currency: "EUR",
      timezone: "Europe/Vilnius",
      address: "Gedimino pr. 1, Vilnius",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { data: { id: string } };
  return body.data;
}

/**
 * Reads the Waiter Role id straight from the database, and that is a finding rather than a
 * shortcut.
 *
 * `POST /memberships` requires a `roleId` (`API_Contract.md`), and **there is no endpoint that
 * returns Role ids.** No `RoleController` exists; `GET /roles` is not implemented anywhere. So a
 * client is asked for an identifier it has no way to obtain — the same shape ADR-039 named when a
 * staff member's Wallet was permitted but unreachable: a required input with nothing addressable
 * behind it. The Invite Employee screen is unbuildable until that endpoint exists.
 *
 * `fixtures/README.md` allows going direct to the database only when there is no endpoint at all,
 * and requires saying so. This is that case, and it is reported rather than quietly absorbed.
 */
async function waiterRoleId(): Promise<string> {
  const role = await queryOne<{ id: string }>(
    "SELECT id FROM role WHERE LOWER(name) = $1 LIMIT 1",
    ["waiter"],
  );
  if (!role) throw new Error("the seeded Waiter role is missing from the e2e database");
  return role.id;
}
