import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { PLATFORM_TERMS_PLACEHOLDER } from "../../backend/src/common/agreements/agreement-versions";
import { queryOne } from "../fixtures/db";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * Register — through a real browser, against the real API, real Postgres, real bcrypt.
 *
 * The screen makes four independent claims, and each one is proved with a **pair** rather than a
 * single test, because every claim here has an implementation that would satisfy one half alone:
 *
 *   - the terms checkbox is required -> a screen that ignores it passes the "ticked" half, and a
 *     screen that always errors passes the "unticked" half. Only together do they say the
 *     checkbox is read.
 *   - the acceptance is recorded -> the row is read out of the database, because "the screen
 *     accepted my registration" is satisfied by an implementation that stores nothing.
 *   - the version is the server's -> the served value is intercepted and replaced, so the
 *     rejection path is exercised as the tab-left-open race it describes, not as a unit test.
 *   - the breach rejection explains itself -> asserted on the line people misread, and on the
 *     absence of the mechanism's name.
 */

const SESSION_KEY = "hos.session";

/** A password unlikely to be in a breach corpus. `registerUser` in `fixtures/api.ts` explains why
 * a memorable placeholder would fail here for a reason that has nothing to do with the test. */
function freshPassword(): string {
  return `e2e-${randomUUID()}-Aa1!`;
}

function freshEmail(): string {
  return `e2e-register-${randomUUID()}@example.test`;
}

/** The form's own error. Next.js App Router injects a route announcer that also carries
 * `role="alert"`, so a bare `getByRole("alert")` matches two elements — see `login.spec.ts`. */
function formError(page: Page) {
  return page.locator('form [role="alert"]');
}

async function fill(
  page: Page,
  email: string,
  password: string,
  name = "E2E Register",
): Promise<void> {
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="displayName"]', name);
  await page.fill('input[name="password"]', password);
}

async function storedSession(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY);
}

test.beforeEach(async () => {
  await resetRateLimits();
});

test("the screen says which product it is — every pre-authentication screen must", async ({
  page,
}) => {
  // Same reasoning as Log In, and it applies here more strongly rather than less: this is the
  // screen where a person hands over an email and chooses a password for the first time.
  await page.goto("/register");
  const wordmark = page.locator("[data-wordmark]");
  await expect(wordmark).toBeVisible();
  await expect(wordmark).toHaveText("PlainTabs");
});

test("the terms checkbox starts unticked, and it is the only checkbox on the screen", async ({
  page,
}) => {
  // Two structural claims from ADR-049, both of which a later edit could quietly undo.
  //
  // Unticked: a pre-ticked box is not an act, and the record this screen writes claims a person
  // did something about the terms.
  //
  // Only one: the Privacy Policy is linked and explained, never agreed to, because our basis for
  // processing is the contract with the person rather than consent. A second checkbox would be a
  // consent recorded against a basis that is not consent — and it would arrive as an innocuous
  // "be extra careful" edit, which is exactly why the objection belongs in a test rather than in
  // a reviewer's memory.
  await page.goto("/register");
  const checkboxes = page.locator('form input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(1);
  await expect(checkboxes.first()).not.toBeChecked();
});

test("without agreeing to the terms, nothing is created: the reason is shown and the URL does not move", async ({
  page,
}) => {
  const email = freshEmail();
  await page.goto("/register");
  await fill(page, email, freshPassword());
  await page.click('button[type="submit"]');

  await expect(formError(page)).toContainText("Terms of Service");
  await expect(page).toHaveURL(/\/register$/);
  expect(await storedSession(page)).toBeNull();

  // The half that makes this more than a UI assertion: no User row exists either. A screen that
  // showed the message and submitted anyway would pass every line above.
  const user = await queryOne<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
  expect(user).toBeUndefined();
});

test("agreeing to the terms creates the account, lands where the Memberships say, and RECORDS what was agreed to", async ({
  page,
}) => {
  const email = freshEmail();
  await page.goto("/register");
  await fill(page, email, freshPassword());
  await page.check('form input[type="checkbox"]');
  await page.click('button[type="submit"]');

  // A freshly registered User has zero Memberships (DATABASE.md), so the same fork Log In uses
  // sends them to Create Your Restaurant. Registration lands signed in — there is no email
  // confirmation step (UX_MAP.md).
  await expect(page).toHaveURL(/\/onboarding\/restaurant$/);
  expect(await storedSession(page)).not.toBeNull();

  // The substantive claim, and the reason this test reads the database rather than the screen:
  // "registration succeeded" is satisfied by an implementation that records no acceptance at all.
  const acceptance = await queryOne<{
    agreement: string;
    version: string;
    restaurant_id: string | null;
    ip_address: string | null;
  }>(
    `SELECT a.agreement, a.version, a.restaurant_id, a.ip_address
       FROM agreement_acceptance a
       JOIN "user" u ON u.id = a.user_id
      WHERE u.email = $1`,
    [email],
  );

  expect(acceptance).toBeDefined();
  expect(acceptance?.agreement).toBe("platform_terms");
  // The server's own constant, not a literal typed here — a fixture naming a version the server
  // does not know would fail for a reason unrelated to what is being tested.
  expect(acceptance?.version).toBe(PLATFORM_TERMS_PLACEHOLDER);
  // Platform terms are accepted by a person. The subject columns are exclusive by CHECK
  // constraint; this asserts the application picked the right one of the two.
  expect(acceptance?.restaurant_id).toBeNull();
  expect(acceptance?.ip_address).not.toBeNull();
});

test("a terms revision that changed while the page was open is refused, and says so — never resubmitted silently", async ({
  page,
}) => {
  // The version the page renders with is served by the API, so the race this describes is
  // reproducible: intercept the served value, hand the page a revision the server does not know,
  // and the submit carries it. That is the same shape as a tab left open across a deploy.
  //
  // Discriminating against the implementation most likely to be written instead: a screen that
  // silently retried under the server's current version would land on /onboarding/restaurant and
  // record an acceptance of a revision this person was never shown.
  const email = freshEmail();
  await page.route("**/api/v1/agreements/current", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          platformTerms: { version: "a-revision-this-server-does-not-serve" },
          stripeConnectedAccount: { version: "a-revision-this-server-does-not-serve" },
        },
      }),
    });
  });

  await page.goto("/register");
  await fill(page, email, freshPassword());
  await page.check('form input[type="checkbox"]');
  await page.click('button[type="submit"]');

  await expect(formError(page)).toContainText("changed while this page was open");
  await expect(page).toHaveURL(/\/register$/);

  const user = await queryOne<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
  expect(user).toBeUndefined();
});

test("a breached password is explained, and the explanation does not name the mechanism", async ({
  page,
}) => {
  // "password" is in every breach corpus. Same real fixture the backend's own HIBP test uses.
  const email = freshEmail();
  await page.goto("/register");
  await fill(page, email, "password");
  await page.check('form input[type="checkbox"]');
  await page.click('button[type="submit"]');

  const alert = formError(page);
  await expect(alert).toContainText("Choose a different password");

  // The line this test exists for. People read this rejection as "someone broke into my account",
  // and the wording that corrects them is the easiest to drop in a later tidy-up of four lines
  // into one.
  await expect(alert).toContainText("about the password itself");

  // The check is an implementation detail, and naming it invites the same misreading in a new
  // form ("who is HaveIBeenPwned and why do they have my password?").
  await expect(alert).not.toContainText(/pwned/i);
  await expect(alert).not.toContainText(/HIBP/i);

  const user = await queryOne<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
  expect(user).toBeUndefined();
});

test("both agreement links resolve to real pages", async ({ page }) => {
  // Neither document is written, and that is exactly why this is worth asserting: the links have
  // to be structurally real now, so that publishing the text later is a content change rather
  // than a screen change. A 404 behind "Read the Terms of Service" reads as a broken site.
  await page.goto("/register");
  await page.click("text=Read the Terms of Service");
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.locator("h1")).toHaveText("Terms of Service");

  await page.goBack();
  await page.click("text=Read the Privacy Policy");
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.locator("h1")).toHaveText("Privacy Policy");
});
