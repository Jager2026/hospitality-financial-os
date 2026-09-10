import { expect, test, type Page } from "@playwright/test";
import { API_BASE, registerUser } from "../fixtures/api";
import { queryOne } from "../fixtures/db";
import { seedMemberWithRole, seedOrgWideOwner } from "../fixtures/org";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * Venue settings — what an owner can change, who may change it, and the one setting no endpoint
 * can store.
 *
 * The tip presets looked like a second such setting and are not: they have their own route and
 * their own permission, which reading the venue DTO alone would have missed.
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

test("an owner changes a venue detail and it is stored", async ({ page, request }) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Settings — Vilnius");

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}/settings`);

  await expect(page.getByTestId("settings")).toBeVisible();
  await page.getByTestId("settings-phone").fill("+37069999999");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toBeVisible();

  // Asserted in the database, not on the screen: a form that reports success and stores nothing is
  // exactly the failure this screen exists to avoid — it is what the API does with the shift value.
  const row = await queryOne<{ phone: string }>(`SELECT phone FROM restaurant WHERE id = $1`, [
    org.restaurantId,
  ]);
  expect(row?.phone).toBe("+37069999999");
});

test("the shift setting is worded as a backstop, not as the end of the day", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Settings — Wording");

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}/settings`);

  // The model, in the product's own words. A shift lasts until somebody closes it; this value is
  // only what happens if nobody does (ADR-064). The wrong version — "the day ends at 05:00" —
  // would teach an owner to read every shift-scoped figure on the Dashboard incorrectly.
  const shift = page.getByTestId("settings-shift");
  await expect(shift).toContainText("lasts until someone closes it");
  await expect(shift).toContainText("backstop");
  await expect(page.getByTestId("settings-shift-time")).toHaveText("05:00");

  // And it says it cannot be changed here, rather than offering a control that would be ignored.
  await expect(page.getByTestId("settings-shift-not-editable")).toBeVisible();
});

test("a Waiter cannot change settings, and an Accountant cannot either", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const waiter = await registerUser(request);
  const org = await seedMemberWithRole(waiter.email, "Waiter", "Settings — Waiter");

  await logIn(page, waiter.email, waiter.password);
  await page.goto(`/restaurants/${org.restaurantId}/settings`);

  // Reachable — the Waiter works here — and not editable. Both halves matter: a screen that simply
  // 404ed would prove nothing about the permission.
  await expect(page.getByTestId("settings")).toBeVisible();
  await expect(page.getByTestId("settings-readonly")).toBeVisible();
  await expect(page.getByTestId("settings-save")).toHaveCount(0);

  // The server is the real check, and it is asked directly with an id the screen never offered.
  const refused = await request.patch(`${API_BASE}/api/v1/restaurants/${org.restaurantId}`, {
    headers: { Authorization: `Bearer ${await accessToken(page)}` },
    data: { phone: "+37060000001" },
  });
  expect(refused.status(), "a Waiter changed a venue's settings").toBe(403);
});

test("a Manager CAN change settings — the half that proves the refusal above is about permission", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const manager = await registerUser(request);
  const org = await seedMemberWithRole(manager.email, "Manager", "Settings — Manager");

  await logIn(page, manager.email, manager.password);
  await page.goto(`/restaurants/${org.restaurantId}/settings`);

  // Measured rather than assumed: `restaurant.edit` is in the seeded Manager's permissions, so a
  // Manager edits venue settings. Without this case the Waiter test above would pass equally
  // against a screen that refused everybody.
  await expect(page.getByTestId("settings-save")).toBeVisible();
  await page.getByTestId("settings-name").fill("Renamed By Manager");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-saved")).toBeVisible();

  const row = await queryOne<{ name: string }>(`SELECT name FROM restaurant WHERE id = $1`, [
    org.restaurantId,
  ]);
  expect(row?.name).toBe("Renamed By Manager");
});

test("the API ignores a shift value rather than refusing it — measured, and why the screen shows it read-only", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Settings — Ignored");
  await logIn(page, owner.email, owner.password);

  const before = await queryOne<{ shift_auto_close_minutes: number }>(
    `SELECT shift_auto_close_minutes FROM restaurant WHERE id = $1`,
    [org.restaurantId],
  );

  // The DTO is a plain z.object, which STRIPS unknown keys — so this is 200 and nothing changes.
  // Out of range makes no difference either: the database CHECK (0..1439) is never reached,
  // because the value never leaves the validation pipe. This test is the reason the screen offers
  // no control for it: a control reporting success while changing nothing is the worst option.
  const res = await request.patch(`${API_BASE}/api/v1/restaurants/${org.restaurantId}`, {
    headers: { Authorization: `Bearer ${await accessToken(page)}` },
    data: { shiftAutoCloseMinutes: 9999 },
  });
  expect(res.status(), "an unknown field is stripped, not refused").toBe(200);

  const after = await queryOne<{ shift_auto_close_minutes: number }>(
    `SELECT shift_auto_close_minutes FROM restaurant WHERE id = $1`,
    [org.restaurantId],
  );
  expect(after?.shift_auto_close_minutes).toBe(before?.shift_auto_close_minutes);
});

test("tip presets are editable — through their own endpoint and their own permission", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Settings — Tips");

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}/settings`);

  // The stored default, which is what UX_MAP says and what the mockups do not.
  await expect(page.getByTestId("settings-tip-presets")).toHaveText("10% · 15% · 20%");

  await page.getByTestId("settings-tips-input").fill("5, 10, 15");
  await page.getByTestId("settings-tips-save").click();
  await expect(page.getByTestId("settings-tips-saved")).toBeVisible();

  // In the database, because this endpoint is a different one from the form above and "it said
  // saved" is exactly the claim that was false for the shift value.
  const row = await queryOne<{ tip_presets: number[] }>(
    `SELECT tip_presets FROM restaurant WHERE id = $1`,
    [org.restaurantId],
  );
  expect(row?.tip_presets).toEqual([5, 10, 15]);
});
