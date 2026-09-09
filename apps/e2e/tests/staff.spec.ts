import { expect, test, type Page } from "@playwright/test";
import { registerUser } from "../fixtures/api";
import { queryOne } from "../fixtures/db";
import { readInvitationLink } from "../fixtures/invitation";
import { seedMemberWithRole, seedOrgWideOwner } from "../fixtures/org";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * Staff, invitations, and the acceptance screen — the path by which a waiter gets an account.
 *
 * The acceptance page is the reason this file matters more than a list screen usually would.
 * Invitations have been sending real email since ADR-070, the link has been correct, and it landed
 * on a 404 — so the whole mail path was useless for want of one page. The test that proves it is
 * the loop: invite, read the link out of the queued message the way the recipient would, follow
 * it, accept, and sign in with the account that produces.
 */

async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.localStorage.getItem("hos.session") !== null);
}

test("an owner sees who works here, and is told what the list cannot show", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Staff — Vilnius");

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}/staff`);

  await expect(page.getByTestId("staff-list")).toBeVisible();
  await expect(page.getByTestId("staff-row")).toHaveCount(1);
  await expect(page.getByTestId("staff-list")).toContainText(owner.email);

  // The limit stated on the screen rather than left to be discovered. Without it, "I invited
  // somebody yesterday and they are not here" reads as a fault.
  await expect(page.getByTestId("staff-pending-note")).toContainText("not yet accepted");
});

test("a Waiter is not offered the invite form — reach is not permission", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const waiter = await registerUser(request);
  const org = await seedMemberWithRole(waiter.email, "Waiter", "Staff — Waiter view");

  await logIn(page, waiter.email, waiter.password);
  await page.goto(`/restaurants/${org.restaurantId}/staff`);

  // The Waiter reaches the venue perfectly well — the list renders — and holds no
  // `membership.invite`, so the form is not offered. The server would refuse it anyway; this is
  // about not teaching somebody that the product is broken.
  await expect(page.getByTestId("staff")).toBeVisible();
  await expect(page.getByTestId("staff-invite")).toHaveCount(0);
});

test("the whole path: invite, open the emailed link, accept, and sign in", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Staff — Onboarding");
  const invitee = `invited-${Date.now()}@example.com`;

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}/staff`);

  await page.getByTestId("staff-invite-email").fill(invitee);
  await page.getByTestId("staff-invite-role").selectOption({ label: "Waiter" });
  await page.getByTestId("staff-invite-submit").click();
  await expect(page.getByTestId("staff-invite-sent")).toBeVisible();

  // Still one row. The invited person does not appear until they accept, and asserting it here is
  // what makes the note on the screen a true statement rather than a hedge.
  await expect(page.getByTestId("staff-row")).toHaveCount(1);

  // Read the way the recipient reads it: out of the queued email, never out of the API response,
  // which deliberately carries no token.
  const { acceptPath } = await readInvitationLink(invitee);
  expect(acceptPath).toContain("/invitations/accept");

  await page.evaluate(() => window.localStorage.removeItem("hos.session"));
  await page.goto(acceptPath);

  await expect(page.getByTestId("accept-email")).toContainText(invitee);
  await page.getByTestId("accept-display-name").fill("Invited Waiter");
  await page.getByTestId("accept-password").fill("AcceptedByEmail!2026");
  await page.getByTestId("accept-terms").check();
  await page.getByTestId("accept-submit").click();

  await expect(page.getByTestId("accept-done")).toBeVisible();

  // THE CONSENT, asserted in the database rather than inferred from the screen. This is the gap
  // that had been open since August: accepting an invitation is the second path that creates a
  // User, and it wrote no acceptance. A row written later could never have repaired it, because it
  // would claim the person agreed on a day nobody asked them.
  const acceptance = await queryOne<{ agreement: string; version: string }>(
    `SELECT aa.agreement, aa.version
       FROM agreement_acceptance aa
       JOIN "user" u ON u.id = aa.user_id
      WHERE u.email = $1`,
    [invitee],
  );
  expect(acceptance, "accepting an invitation must record what was agreed to").toBeTruthy();
  expect(acceptance?.agreement).toBe("platform_terms");

  // And the account works — the acceptance issues no session on purpose, so logging in is what
  // proves the password that was just chosen is real.
  await logIn(page, invitee, "AcceptedByEmail!2026");
  await expect(page).toHaveURL(/\/restaurants/);
});

test("the terms checkbox is unticked, and nothing is created without it", async ({
  page,
  request,
}) => {
  await resetRateLimits();
  const owner = await registerUser(request);
  const org = await seedOrgWideOwner(owner.email, "Staff — Consent");
  const invitee = `unconsenting-${Date.now()}@example.com`;

  await logIn(page, owner.email, owner.password);
  await page.goto(`/restaurants/${org.restaurantId}/staff`);
  await page.getByTestId("staff-invite-email").fill(invitee);
  await page.getByTestId("staff-invite-role").selectOption({ label: "Waiter" });
  await page.getByTestId("staff-invite-submit").click();
  await expect(page.getByTestId("staff-invite-sent")).toBeVisible();

  const { acceptPath } = await readInvitationLink(invitee);
  await page.evaluate(() => window.localStorage.removeItem("hos.session"));
  await page.goto(acceptPath);

  // Never pre-ticked. The row this writes claims a person accepted revision X at time T, and that
  // is only honest if they did something about the terms rather than about joining a workplace.
  await expect(page.getByTestId("accept-terms")).not.toBeChecked();

  await page.getByTestId("accept-display-name").fill("No Consent");
  await page.getByTestId("accept-password").fill("NoConsentGiven!2026");
  await page.getByTestId("accept-submit").click();

  await expect(page.getByTestId("accept-error")).toBeVisible();
  await expect(page.getByTestId("accept-done")).toHaveCount(0);

  // Asserted on the database, not only on the message: refusing while creating the User anyway
  // would be the same defect in a quieter form.
  const user = await queryOne<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [invitee]);
  expect(user, "no account may exist for somebody who did not accept the terms").toBeFalsy();
});

test("a link with no token explains which link to use rather than failing", async ({ page }) => {
  await page.goto("/invitations/accept");
  await expect(page.getByTestId("accept-missing-link")).toBeVisible();
  await expect(page.getByTestId("accept-form")).toHaveCount(0);
});
