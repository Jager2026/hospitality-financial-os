import { expect, test, type Page } from "@playwright/test";
import { registerUser } from "../fixtures/api";
import { seedOrgWideOwner, seedRestaurantScopedMember } from "../fixtures/org";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * The Restaurants list — the first screen after login for an org-wide owner, and the only route to
 * a Dashboard for anyone who does not already know its id.
 *
 * Falsified in three places, one per claim the screen makes:
 *   - remove the reachability scope -> the "does not see another owner's venues" test must fail
 *   - point every row at the same id -> the "click reaches THIS one" test must fail
 *   - render an empty list instead of an invitation -> the new-owner test must fail
 */

async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');

  // WAIT FOR THE SESSION, not for a URL. Clicking submit returns before the response has been
  // stored, and a test that navigates immediately afterwards races it: RequireSession finds no
  // session and sends the browser back to Log In, which looks exactly like a broken screen. The
  // stored session is the actual precondition every following step depends on, so it is the thing
  // to wait for.
  await page.waitForFunction(() => window.localStorage.getItem("hos.session") !== null);
}

test("an owner sees their own restaurants and not another owner's", async ({ page, request }) => {
  await resetRateLimits();

  // Two owners, two organizations. The second exists only to be invisible.
  const mine = await registerUser(request);
  await seedOrgWideOwner(mine.email, "Mine — Vilnius");

  const stranger = await registerUser(request);
  await seedOrgWideOwner(stranger.email, "Stranger — Kaunas");

  await logIn(page, mine.email, mine.password);
  await expect(page).toHaveURL(/\/restaurants$/);

  const list = page.getByTestId("restaurants");
  await expect(list).toBeVisible();
  await expect(list).toContainText("Mine — Vilnius");

  // THE DISCRIMINATING HALF. A list that showed every restaurant on the platform would pass a
  // "my restaurant is here" assertion perfectly well. ADR-005: an org-wide Membership reaches its
  // own Organization, and nothing beyond it.
  await expect(list, "another owner's restaurant is on this screen").not.toContainText(
    "Stranger — Kaunas",
  );
  await expect(page.getByTestId("restaurant-row")).toHaveCount(1);
});

test("a restaurant-scoped member sees only the one restaurant they are scoped to", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Head office — Vilnius");

  // A second venue in the SAME organization, and a member scoped to it alone. This is the case the
  // reachability predicate has already shipped wrong once (CLAUDE.md): a restaurant-scoped
  // Membership must not inherit the whole Organization.
  const scoped = await registerUser(request);
  await seedRestaurantScopedMember(scoped.email, "Branch — Kaunas");

  await logIn(page, scoped.email, scoped.password);

  // A single restaurant-scoped Membership lands straight on its Dashboard (destination.ts), so the
  // list is reached deliberately rather than by the login fork.
  await page.goto("/restaurants");

  const list = page.getByTestId("restaurants");
  await expect(list).toBeVisible();
  await expect(list).toContainText("Branch — Kaunas");
  await expect(
    list,
    "a scoped member reached a restaurant they hold no Membership at",
  ).not.toContainText("Head office — Vilnius");
  expect(org.restaurantId, "the fixture built two distinct restaurants").not.toBe("");
});

test("clicking a restaurant opens that restaurant's dashboard", async ({ page, request }) => {
  await resetRateLimits();
  const user = await registerUser(request);
  const first = await seedOrgWideOwner(user.email, "First — Vilnius");
  const second = await seedRestaurantScopedMember(user.email, "Second — Kaunas");

  await logIn(page, user.email, user.password);
  await page.goto("/restaurants");
  await expect(page.getByTestId("restaurants")).toBeVisible();

  // Two rows, and the click must reach the SECOND one. With one row a broken link that always went
  // to the first restaurant would pass — which is why the fixture builds two.
  await page.getByRole("link", { name: /Second — Kaunas/ }).click();

  await expect(page).toHaveURL(new RegExp(`/restaurants/${second.restaurantId}$`));
  await expect(page.getByTestId("dashboard")).toBeVisible();
  expect(second.restaurantId).not.toBe(first.restaurantId);
});

test("a brand-new owner is led to creating a restaurant, not shown an empty list", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  // Registered and nothing else — no Organization, no Membership. This is the first screen of the
  // product for that person.
  const user = await registerUser(request);

  await logIn(page, user.email, user.password);
  await page.goto("/restaurants");

  const empty = page.getByTestId("restaurants-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("first restaurant");

  // THE DISCRIMINATING HALF. A screen that rendered the list heading with nothing under it would
  // satisfy "the page loaded" — the requirement is that it leads somewhere.
  const action = page.getByTestId("create-first-restaurant");
  await expect(action).toBeVisible();
  await expect(action).toHaveAttribute("href", "/onboarding/restaurant");
  await expect(page.getByTestId("restaurant-row")).toHaveCount(0);
});

test("a restaurant that cannot take cards says so on the list, before it is opened", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const user = await registerUser(request);
  await seedOrgWideOwner(user.email, "Not onboarded — Vilnius");

  await logIn(page, user.email, user.password);

  // The fixture creates restaurants with onboarding_status 'not_started', which is exactly the
  // state this flag exists for: the owner learns it here rather than one click later.
  await expect(page.getByTestId("restaurant-cannot-take-cards")).toBeVisible();
});
