import { randomUUID } from "node:crypto";
import { execute, queryOne } from "./db";
import { deriveOnboardingStatus } from "../../backend/src/restaurant/onboarding-status.util";

/**
 * Creates an Organization, a Restaurant and a Membership **directly in the database**, because
 * `POST /restaurants` makes a live Stripe Connect call that this harness **must not** make.
 *
 * The distinction matters and the earlier wording ("cannot") got it wrong: the endpoint works —
 * measured on 2026-09-07, it returns 201 with a real connected account. What forbids it here is a
 * rule, not a breakage. ADR-041 permits replacing only a literal outbound third-party call, no
 * test in this codebase makes a live network call, and CI holds a generated placeholder key rather
 * than a real one. A comment that says "cannot" invites somebody to try it the day the thing is
 * fixed; one that says "must not" names the rule they would be breaking.
 *
 * ── The rule this is allowed under, stated narrowly on purpose ─────────────────────────────────
 *
 * **Direct insertion is permitted when the entity being created is not the subject of the check.**
 *
 * That is the whole licence, and it is deliberately narrow. Here the subject is the login routing
 * fork: which screen a person lands on after signing in. The Restaurant is scenery. What actually
 * decides the branch is the **Membership**, and that Membership is real — read back by the real
 * `POST /auth/login` from the real database, through the real query `toAuthResult` uses. Nothing
 * about the thing under test is simulated.
 *
 * The rule this is NOT: "inserting rows is fine when an endpoint is inconvenient." `registerUser`
 * still goes through `POST /auth/register`, because there the User *is* the subject — a
 * fixture-computed password hash would make a login test prove that our two helpers agree with
 * each other rather than that registration and login do. The distinction is which entity the
 * assertion is about, not which is easier to create.
 *
 * ── What this costs, said plainly ──────────────────────────────────────────────────────────────
 * The e2e suite no longer proves that `POST /restaurants` produces the Membership shape the fork
 * expects. That link is covered by the backend's own suite (`restaurant.service.spec.ts` and
 * `critical-flow.e2e.spec.ts`, which fake only the Stripe network boundary), not here. If the
 * endpoint's Membership shape ever changes, this fixture would keep passing while the product
 * broke — so the fixture mirrors that shape rather than inventing one.
 */

export interface SeededOrg {
  organizationId: string;
  restaurantId: string;
  membershipId: string;
}

/**
 * A seeded Role by name, and it is looked up rather than written.
 *
 * `CLAUDE.md`: a fixture's Role and Permissions come from the seed, never from a literal typed in
 * the spec. A test that says "Manager" must mean the Manager the product actually grants — the
 * one whose permission set decides whether the screen under test offers an action, and whose
 * permissions the login response then carries to the browser.
 */
async function roleIdByName(name: string): Promise<string> {
  const role = await queryOne<{ id: string }>(
    "SELECT id FROM role WHERE LOWER(name) = $1 LIMIT 1",
    [name.toLowerCase()],
  );
  if (!role) throw new Error(`the seeded ${name} role is missing from the e2e database`);
  return role.id;
}

async function userIdByEmail(email: string): Promise<string> {
  const user = await queryOne<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email]);
  if (!user) throw new Error(`no user for ${email} — register through the real API first`);
  return user.id;
}

/**
 * An Organization with one Restaurant, and an **org-wide** Membership for the given user — the
 * shape `POST /restaurants` produces for a first-time owner (ADR-005). Lands on the Restaurants
 * list after login.
 */
export async function seedOrgWideOwner(
  email: string,
  name = "Fixture Restaurant",
): Promise<SeededOrg> {
  return seed(email, name, { orgWide: true });
}

/** The same, but the Membership is scoped to the Restaurant rather than org-wide — the shape an
 * accepted invitation produces. Lands on that Restaurant's Dashboard after login. */
export async function seedRestaurantScopedMember(
  email: string,
  name = "Fixture Restaurant",
): Promise<SeededOrg> {
  return seed(email, name, { orgWide: false });
}

/**
 * A Membership at a seeded Restaurant holding a named Role — Manager and Waiter, not only Owner.
 *
 * Needed because a permission check can only be tested by somebody who fails it. Both of these
 * reach the venue perfectly well and neither holds `restaurant.create`, which is the whole point:
 * reach and permission are two questions, and a screen that conflates them offers a button that
 * the server will refuse.
 */
export async function seedMemberWithRole(
  email: string,
  roleName: string,
  name = "Fixture Restaurant",
): Promise<SeededOrg> {
  return seed(email, name, { orgWide: false, role: roleName });
}

async function seed(
  email: string,
  name: string,
  options: { orgWide: boolean; role?: string },
): Promise<SeededOrg> {
  const userId = await userIdByEmail(email);
  const roleId = await roleIdByName(options.role ?? "Owner");
  const organizationId = randomUUID();
  const restaurantId = randomUUID();
  const membershipId = randomUUID();

  await execute(
    `INSERT INTO organization (id, name, status, created_at, updated_at)
     VALUES ($1, $2, 'active', NOW(), NOW())`,
    [organizationId, `${name} Group`],
  );

  await execute(
    `INSERT INTO restaurant (
       id, organization_id, name, legal_name, company_number, vat_number, email, phone,
       country, currency, default_customer_locale, timezone, address, status,
       onboarding_status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, '300000000', 'LT100000000000', $5, '+37060000000',
       'LT', 'EUR', 'lt', 'Europe/Vilnius', 'Gedimino pr. 1, Vilnius', 'active',
       'not_started', NOW(), NOW())`,
    [restaurantId, organizationId, name, `${name} UAB`, `contact-${restaurantId}@example.test`],
  );

  await execute(
    `INSERT INTO membership (id, user_id, organization_id, restaurant_id, role_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())`,
    [membershipId, userId, organizationId, options.orgWide ? null : restaurantId, roleId],
  );

  return { organizationId, restaurantId, membershipId };
}

/**
 * The three Stripe states a venue can really be in, as the pair of capability statuses Stripe
 * reports plus the coarse status our own backend derives from that pair.
 *
 * **Written as whole triples, never as one column at a time**, because the pair is not free: the
 * backend computes `onboarding_status` from the two capabilities (`deriveOnboardingStatus`), so
 * `not_started` alongside a non-null capability is a row the system cannot produce. A fixture that
 * writes one anyway proves things about a system that does not exist — the class `CLAUDE.md`
 * records, and the exact bug that hid this Dashboard gap for a sprint (#177): the demo data said a
 * venue had not started Stripe *and* had a payouts status, so the list and the Dashboard
 * disagreed about the same restaurant and neither looked wrong on its own.
 *
 * **The derived status is now computed by the backend's own function rather than written out.**
 * The previous version of this comment said `apps/e2e` does not depend on `apps/backend` and that
 * importing it would be heavier coupling than the thing it protects. That was simply false, and
 * checkable in one line: `fixtures/api.ts` has imported `PLATFORM_TERMS_PLACEHOLDER` straight from
 * `apps/backend/src` since the harness was built. The dependency already existed; the mirrored
 * triple was a copy nobody needed. Corrected here rather than left standing, because a comment
 * that justifies a copy with a false constraint is how the copy survives its next review.
 */
export type StripeState = "not_started" | "payouts_held" | "live";

const STRIPE_CAPABILITIES: Record<StripeState, { card: string | null; payouts: string | null }> = {
  /** Stripe was never started: both capabilities null, which is the ONLY way to `NOT_STARTED`. */
  not_started: { card: null, payouts: null },
  /** Charges live, payouts held — nothing outstanding for the owner, so `RESTRICTED`. */
  payouts_held: { card: "active", payouts: "restricted" },
  /** Both capabilities live, which is the only way to `COMPLETE`. */
  live: { card: "active", payouts: "active" },
};

/** Puts a seeded Restaurant into one of those states. No `stripe_account_id` is set, so
 * `refreshStripeStatus` returns the row untouched and what is written here is what the API
 * returns — checked in the service, not assumed. */
export async function setStripeState(restaurantId: string, state: StripeState): Promise<void> {
  const { card, payouts } = STRIPE_CAPABILITIES[state];
  // Zero requirements: none of these three states has an outstanding item to describe, and that
  // is exactly what separates RESTRICTED from IN_PROGRESS in the real derivation.
  const onboarding = deriveOnboardingStatus(card, payouts, 0).toLowerCase();
  await execute(
    `UPDATE restaurant
        SET card_payments_status = $2, payouts_status = $3,
            onboarding_status = $4::"onboarding_status", updated_at = NOW()
      WHERE id = $1`,
    [restaurantId, card, payouts, onboarding],
  );
}

/**
 * Gives a seeded Restaurant a Stripe account id, so a refusal can be attributed.
 *
 * **This exists because of an assertion that could not fail.** `createOnboardingLink` answers 404
 * for a caller without `restaurant.create` AND for a venue with no Stripe account — one status,
 * one error code, two causes. A fixture venue has no account id, so a test asserting 404 for a
 * Manager passed whether or not the permission check existed: remove it and the request simply
 * falls through to the next 404.
 *
 * With an account id set, the permission check is the only thing between the caller and a live
 * Stripe call, so 404 means the permission refused it and nothing else can produce that answer.
 * The id is deliberately not a real one: if the check is ever removed, the request reaches Stripe
 * and fails loudly, which is exactly the signal the test needs.
 */
export async function setStripeAccountId(restaurantId: string, accountId: string): Promise<void> {
  await execute("UPDATE restaurant SET stripe_account_id = $2, updated_at = NOW() WHERE id = $1", [
    restaurantId,
    accountId,
  ]);
}
