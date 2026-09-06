import { randomUUID } from "node:crypto";
import { execute, queryOne } from "./db";

/**
 * Creates an Organization, a Restaurant and a Membership **directly in the database**, because
 * `POST /restaurants` makes a live Stripe Connect call that this harness cannot make.
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

async function ownerRoleId(): Promise<string> {
  const role = await queryOne<{ id: string }>(
    "SELECT id FROM role WHERE LOWER(name) = $1 LIMIT 1",
    ["owner"],
  );
  if (!role) throw new Error("the seeded Owner role is missing from the e2e database");
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

async function seed(
  email: string,
  name: string,
  options: { orgWide: boolean },
): Promise<SeededOrg> {
  const userId = await userIdByEmail(email);
  const roleId = await ownerRoleId();
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
 * The derivation is mirrored here rather than imported: `apps/e2e` does not depend on
 * `apps/backend`, and adding that dependency to share three constants would be a heavier coupling
 * than the thing it protects. `onboarding-status.util.ts` is the source; if it changes, this
 * changes with it.
 */
export type StripeState = "not_started" | "payouts_held" | "live";

const STRIPE_STATES: Record<
  StripeState,
  { card: string | null; payouts: string | null; onboarding: string }
> = {
  /** Stripe was never started: both capabilities null, which is the ONLY way to `not_started`. */
  not_started: { card: null, payouts: null, onboarding: "not_started" },
  /** Charges live, payouts held — `restricted`, since nothing is outstanding for the owner to do. */
  payouts_held: { card: "active", payouts: "restricted", onboarding: "restricted" },
  /** Both capabilities live, which is the only way to `complete`. */
  live: { card: "active", payouts: "active", onboarding: "complete" },
};

/** Puts a seeded Restaurant into one of those states. No `stripe_account_id` is set, so
 * `refreshStripeStatus` returns the row untouched and what is written here is what the API
 * returns — checked in the service, not assumed. */
export async function setStripeState(restaurantId: string, state: StripeState): Promise<void> {
  const { card, payouts, onboarding } = STRIPE_STATES[state];
  await execute(
    `UPDATE restaurant
        SET card_payments_status = $2, payouts_status = $3,
            onboarding_status = $4::"onboarding_status", updated_at = NOW()
      WHERE id = $1`,
    [restaurantId, card, payouts, onboarding],
  );
}
