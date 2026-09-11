import { expect, test, type Page } from "@playwright/test";
import { API_BASE, registerUser } from "../fixtures/api";
import { seedMemberWithRole, seedOrgWideOwner } from "../fixtures/org";
import { seedOpenShift, seedTransaction } from "../fixtures/shift";
import { clickAndMeasureNavigation } from "../fixtures/navigation-measure";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * Transactions — the screen an owner opens when a Dashboard figure raised a question.
 *
 * ── One falsification this suite deliberately does NOT contain ─────────────────────────────────
 *
 * *"Rows belong to a shift, not a calendar day; an implementation reading the date must fail."*
 * **There is no such implementation to falsify, because the API cannot express it.** `Transaction`
 * has no `shiftId` and no relation to `Shift` (only `LedgerLine` does), and
 * `transactionListQuerySchema` accepts `restaurantId`, `status`, `membership`, `page` and `limit`
 * — no shift, no date. A test asserting shift-scoping here could only pass by asserting something
 * else, which is how a suite acquires a test that proves nothing.
 *
 * What is asserted instead is the true statement: the screen says out loud that it is not
 * shift-scoped, so nobody reads it as the open shift.
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

test("an owner reads the payments taken at their venue, in the venue's own money", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Busy — Vilnius");
  const shift = (await seedOpenShift(org.restaurantId)).shiftId;
  await seedTransaction({
    restaurantId: org.restaurantId,
    shiftId: shift,
    billMinorUnits: 4500n,
    tipMinorUnits: 500n,
    platformFeeMinorUnits: 45n,
  });

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}/transactions`);

  const rows = page.getByTestId("transaction-row");
  await expect(rows).toHaveCount(1);
  // lt-LT, from the venue's own locale and country — the one formatter (#174), not a second one.
  // The charge is bill + tip: 45,00 + 5,00.
  await expect(rows.first()).toContainText("50,00");
  await expect(rows.first()).toContainText("5,00");

  // Said plainly, because ADR-065 puts operational screens on shifts and this list cannot be one.
  await expect(page.getByTestId("transactions-scope")).toContainText("not only the open shift");
});

test("a quiet venue and a filter that matched nothing are different screens", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Quiet — Kaunas");

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}/transactions`);

  // Nothing has been sold. The screen explains rather than showing an empty list.
  await expect(page.getByTestId("transactions-empty")).toBeVisible();
  await expect(page.getByTestId("transactions-empty-filter")).toHaveCount(0);

  // Now give it a sale, and ask a question that excludes it. THE DISCRIMINATING PAIR: same zero
  // rows, opposite meanings — one says no money came in, the other says this question excluded it.
  const shift = (await seedOpenShift(org.restaurantId)).shiftId;
  await seedTransaction({
    restaurantId: org.restaurantId,
    shiftId: shift,
    billMinorUnits: 1000n,
    tipMinorUnits: 0n,
    platformFeeMinorUnits: 10n,
  });
  await page.reload();
  await page.getByTestId("transactions-status").selectOption("DISPUTED");

  const filtered = page.getByTestId("transactions-empty-filter");
  await expect(filtered).toBeVisible();
  await expect(filtered).toContainText("may well have taken payments");
  await expect(
    page.getByTestId("transactions-empty"),
    "a filter with no matches was shown as a venue with no sales",
  ).toHaveCount(0);

  // And it leads out of the dead end rather than leaving somebody in it.
  await page.getByTestId("transactions-clear-filter").click();
  await expect(page.getByTestId("transaction-row")).toHaveCount(1);
});

test("a Waiter is refused the list, and told why rather than shown a fault", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const waiter = await registerUser(request);
  const org = await seedMemberWithRole(waiter.email, "Waiter", "Staffed — Klaipėda");
  const shift = (await seedOpenShift(org.restaurantId)).shiftId;
  await seedTransaction({
    restaurantId: org.restaurantId,
    shiftId: shift,
    billMinorUnits: 2000n,
    tipMinorUnits: 200n,
    platformFeeMinorUnits: 20n,
  });

  await logIn(page, waiter.email, waiter.password);
  await page.goto(`/restaurants/${org.restaurantId}/transactions`);

  // A Waiter holds ZERO permissions, so `reports.view` refuses the whole list — they do not see
  // "only their own", they see none. The screen says so instead of offering a retry that cannot
  // work.
  await expect(page.getByTestId("transactions-error")).toContainText("owners and managers");
  await expect(page.getByTestId("transaction-row")).toHaveCount(0);

  // THE HALF THAT MATTERS: the refusal is the API's, not the screen's.
  const refused = await request.get(
    `${API_BASE}/api/v1/transactions?restaurantId=${org.restaurantId}`,
    { headers: { Authorization: `Bearer ${await accessToken(page)}` } },
  );
  expect(refused.status(), "a Waiter read the transaction list").toBe(403);
});

test("a manager sees their own restaurant's payments and not another's", async ({
  page,
  request,
}) => {
  await resetRateLimits();

  // Two venues in two organizations. The second exists only to stay invisible.
  const manager = await registerUser(request);
  const mine = await seedMemberWithRole(manager.email, "Manager", "Mine — Vilnius");
  const mineShift = (await seedOpenShift(mine.restaurantId)).shiftId;
  await seedTransaction({
    restaurantId: mine.restaurantId,
    shiftId: mineShift,
    billMinorUnits: 1100n,
    tipMinorUnits: 0n,
    platformFeeMinorUnits: 11n,
  });

  const stranger = await registerUser(request);
  const theirs = await seedOrgWideOwner(stranger.email, "Stranger — Kaunas");
  const theirShift = (await seedOpenShift(theirs.restaurantId)).shiftId;
  const strangersTransaction = await seedTransaction({
    restaurantId: theirs.restaurantId,
    shiftId: theirShift,
    billMinorUnits: 9900n,
    tipMinorUnits: 0n,
    platformFeeMinorUnits: 99n,
  });

  await logIn(page, manager.email, manager.password);
  await page.goto(`/restaurants/${mine.restaurantId}/transactions`);
  await expect(page.getByTestId("transaction-row")).toHaveCount(1);
  await expect(page.getByTestId("transactions")).toContainText("11,00");
  await expect(page.getByTestId("transactions")).not.toContainText("99,00");

  // Asked of the API directly, with an id the screen never showed: reachability is the server's
  // rule, and a screen filtering its own list would satisfy the assertions above without it.
  const refused = await request.get(`${API_BASE}/api/v1/transactions/${strangersTransaction}`, {
    headers: { Authorization: `Bearer ${await accessToken(page)}` },
  });
  expect(refused.status(), "a manager read another organization's transaction").toBe(404);
});

test("the card answers what the row cannot — where the money went", async ({ page, request }) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Breakdown — Vilnius");
  const shift = (await seedOpenShift(org.restaurantId)).shiftId;
  await seedTransaction({
    restaurantId: org.restaurantId,
    shiftId: shift,
    billMinorUnits: 10000n,
    tipMinorUnits: 1500n,
    platformFeeMinorUnits: 100n,
  });

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}/transactions`);
  // The navigation and the render are asserted separately, so a failure names which half of the
  // claim was wrong rather than only that the breakdown was missing.
  await clickAndMeasureNavigation(
    page,
    page.getByTestId("transaction-row").first(),
    "transaction-row",
    /\/transactions\/[0-9a-f-]{36}$/,
  );

  const breakdown = page.getByTestId("transaction-breakdown");
  await expect(breakdown).toBeVisible();
  await expect(breakdown, "the venue's share").toContainText("99,00");
  await expect(breakdown, "the tip").toContainText("15,00");
  await expect(breakdown, "our fee").toContainText("1,00");
  // ADR-025: unavailable is not zero, and in a money breakdown a blank reads as zero.
  await expect(breakdown, "an unavailable figure was shown as a number").toContainText(
    "Not available",
  );
});

test("the dashboard leads here, because that is where the question starts", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Linked — Vilnius");
  const shift = (await seedOpenShift(org.restaurantId)).shiftId;
  await seedTransaction({
    restaurantId: org.restaurantId,
    shiftId: shift,
    billMinorUnits: 3000n,
    tipMinorUnits: 0n,
    platformFeeMinorUnits: 30n,
  });

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}`);
  await clickAndMeasureNavigation(
    page,
    page.getByTestId("dashboard-transactions-link"),
    "dashboard-transactions-link",
    new RegExp(`/restaurants/${org.restaurantId}/transactions$`),
  );
  await expect(page.getByTestId("transactions")).toBeVisible();
});
