-- ============================================================================
-- ADR-088. One ACTIVE Membership per person, per Organization, per Restaurant.
--
-- The rule that produces duplicates lives in `MembershipInvitationService.accept`, and it is now
-- correct: the invitation row is claimed with a conditional write before anything is created, so
-- two concurrent accepts cannot both proceed. **This index exists because that is a rule, and the
-- next code path that creates a Membership can simply not apply it.** A rule is forgotten in
-- silence; a constraint cannot be.
--
-- PARTIAL, on `status = 'active'`, and the reason is a fact about this schema rather than a
-- preference: removing somebody is `MembershipService.disable`, which writes `status = 'inactive'`
-- and LEAVES THE ROW. Nothing anywhere writes `deleted_at` on a membership — the codebase says so
-- in `auth/active-memberships.ts` and a search confirms zero write sites — so a partial index on
-- `deleted_at IS NULL` would cover every row and be a full unique index wearing a WHERE clause. It
-- would then block re-inviting somebody who once worked here, which is an ordinary thing to do and
-- which `invite()` deliberately permits: it does not check for an existing Membership at all.
--
-- NULLS NOT DISTINCT, and this is the half that is easy to leave out. `restaurant_id` is NULL for
-- an org-wide Membership (ADR-005) and 1,450 of the rows in the development database are exactly
-- that. Postgres treats NULLs as distinct in a unique index by default, so without this clause the
-- org-wide case — a role over every restaurant in an Organization — would be the one case left
-- unconstrained. Available since Postgres 15; dev and CI both run 18.
--
-- Prisma's schema language expresses neither a WHERE nor NULLS NOT DISTINCT on a unique index, so
-- it lives here — the same reasoning, and the same shape, as `shift_one_open_per_restaurant`.
--
-- Safe to apply: measured before writing, the development database holds zero groups of
-- (user_id, organization_id, restaurant_id) with more than one ACTIVE row.
-- ============================================================================
CREATE UNIQUE INDEX "membership_one_active_per_scope"
  ON "membership" ("user_id", "organization_id", "restaurant_id")
  NULLS NOT DISTINCT
  WHERE "status" = 'active';
