---
title: IMPLEMENTATION_PLAN
version: 2.19.0
status: Active
classification: Critical
priority: Highest
owner: Founder
technical_owner: AI Technical Co-Founder
supersedes: IMPLEMENTATION_PLAN v1.0 — see ARCHITECTURE_DECISIONS.md for the reasoning behind every change below
---

# IMPLEMENTATION PLAN

> "A great product is built one correct decision at a time."

---

# General Principle

The MVP is not built feature-first. It is built foundation-first.

Development order:

Foundation (Ledger, Outbox, Idempotency, Audit, Rate Limiting)
↓
Authentication
↓
Organization & Restaurant Module
↓
Membership Module
↓
Payments & Ledger
↓
Tips
↓
Wallet
↓
Transactions
↓
Dashboard
↓
Analytics
↓
Security Hardening
↓
Testing (End-to-End & Regression)
↓
Deployment

**Prerequisite:** `ARCHITECTURE_DECISIONS.md` reviewed and Accepted before Sprint 0 begins. ADR-012 (launch market) is Accepted — Lithuania, EUR — so Sprint 3 is not blocked on a founder decision here.

---

# What "Definition of Done" Means

Every "Definition of Done" line below is a claim that the listed things actually happened, verified by actually running the relevant commands in a real environment against a real database/services — not that the code was written and looks like it should work. "Backend starts" means a session watched it start. "A test posting that doesn't balance is rejected" means the test was actually run and actually failed the bad case. Code review and code execution are different kinds of evidence; a Definition of Done line requires the second kind, not just the first.

If the session's environment cannot run something required for a Definition of Done line — no database, no Node, no network — say so explicitly in the report, rather than reporting the item as done or leaving it ambiguous. An honest "written but not run, here's exactly what's unverified" is a complete report. A Definition of Done line marked satisfied on the strength of the code merely looking correct is not, regardless of how confident the write-up sounds.

**The local gate run before opening a pull request must be the same set of commands CI runs, and that set includes `build`.** Not a subset chosen by what seems relevant — lint, typecheck and tests passing locally while `build` was never run is how test code reached the production bundle unnoticed, and how a fixture import that could not compile got as far as CI. The build is the only step that enforces `rootDir`, and it is the only one whose output is what actually deploys. Run `pnpm run lint`, `pnpm run typecheck`, `pnpm run test` **and `pnpm run build`** before pushing.

A pushed commit ("запушено", a commit hash) is not the same claim as a green CI run, and reporting the first must never stand in for the second. This is not hypothetical: CI failed on every run from the very first commit through Sprint 2, and it went unnoticed for that entire stretch because every session report confirmed the push had happened without separately checking whether GitHub's own CI run for that push actually passed. Any report claiming something is done must state the current CI status on GitHub for that commit, not just the fact that it was pushed.

---

# Sprint 0
## Repository Setup

Objectives: Create Git Repository, Configure Branch Strategy, Configure GitHub, Configure CI, Configure Docker, Configure Documentation, Configure Linting, Configure Formatting, Configure Testing.

Definition of Done: Repository can be cloned. Project starts with one command. CI passes. Docker builds. `ARCHITECTURE_DECISIONS.md` is in the repository and `MASTERPLAN.md` references it.

---

# Sprint 1
## Foundation

Tasks: Create Backend, Create Frontend, Configure NestJS, Configure Next.js, Configure Prisma, Configure PostgreSQL, Configure Redis, Configure Environment Variables, Create Health Check, Create Logger, Create Error Handler, Create Validation Layer.

Added, per ADR-001 / ADR-002 / ADR-003 / ADR-004 / ADR-010 — this is what changed the most from v1.0:
- `Currency` reference table + ISO 4217 seed data
- `JournalEntry` / `LedgerLine` schema, plus a Ledger Module write-helper that rejects any posting where debits ≠ credits. No real writer yet — the mechanism exists so Sprint 5 doesn't have to invent it under pressure.
- **Deferred constraint trigger on `ledger_line`** (added per the Sprint 0 schema audit, Founder-approved): `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW`, `INITIALLY DEFERRED`, summing debits and credits per `journal_entry_id` at transaction commit and raising an exception if unbalanced. This is a second, independent layer behind the Ledger Module write-helper above — a database-level guarantee that holds even if the write-helper is ever bypassed by a future bug or a raw SQL script. Written as hand-authored SQL in the migration (Prisma cannot express triggers natively).
- **`CHECK` constraint on `journal_entry`** (added per the Sprint 0 schema audit, ADR-017, extended on Founder request): `entry_type` must agree with which of `refund_id` / `chargeback_id` / `adjustment_id` is set — e.g. `entry_type = 'refund_issued'` requires `refund_id` set and the other two null; `payment_captured` / `tip_allocated` / `payout` require all three null. Unlike the trigger above, this is a plain single-row constraint — no deferral needed. SQL in `apps/backend/prisma/sql/ledger_integrity.sql`.
- `OutboxEvent` schema + polling worker skeleton
- `IdempotencyKey` schema
- Audit Log write path as a shared interceptor on every mutating endpoint
- Baseline rate limiting module (generic; per-endpoint tuning happens in Sprint 11)

Definition of Done: Backend starts. Frontend starts. Database connects. Redis connects. Health endpoint works. A test posting to `LedgerLine` that doesn't balance is rejected — both by the Ledger Module write-helper and, if that's bypassed directly via SQL, by the deferred trigger.

---

# Sprint 2
## Authentication

Features: Registration, Login, Logout, Refresh Token, JWT, RBAC, `Role` / `Permission` / `RolePermission` seed data, Protected Routes, User Profile, Tests.

Added: Sprint 1's rate limiter applied to these endpoints now (10/min per API_Contract). Sprint 1's Audit interceptor confirmed to capture register/login/logout — nothing new to build here, only to verify.

Definition of Done: Owner can register. Owner can login. Protected routes work. JWT refresh works. A brute-force attempt is throttled. A login attempt appears in Audit Log.

---

# Sprint 3
## Organization & Restaurant Module

Renamed from Restaurant Module (ADR-005).

Tasks: Create Restaurant (auto-creates an Organization if the user has none), Add Restaurant to Existing Organization, Update Restaurant, Delete Restaurant, Restaurant Settings, Restaurant Profile, Restaurant Validation, Stripe Connect account creation and onboarding flow — `stripe_account_id`, `onboarding_status`, `card_payments_status`, `payouts_status`, `requirements_due` (ADR-009), Currency selection at creation, Tests.

Definition of Done: Restaurant exists. Restaurant editable. Restaurant displayed. Owner sees Stripe onboarding status and any outstanding requirements.

---

# Sprint 4
## Membership Module

Renamed from Employee Module (ADR-005).

Tasks: Invite Membership (`restaurant_id` nullable for an organization-wide role), Membership Login, Membership Profile, Membership List, Role Assignment (using Sprint 2's seeded roles/permissions), Tests.

Definition of Done: Membership invitation works. Membership login works. An org-wide Membership reaches every Restaurant in its Organization; a restaurant-scoped one reaches only its own.

---

# Sprint 5
## Payments & Ledger

Renamed from Stripe Integration — this is where the Ledger Module gets its first real writer.

Tasks: Payment Intent, Payment Confirmation, Payment Status, Payment History, Idempotency-Key enforcement (ADR-004), Transaction Creation, `JournalEntry` + `LedgerLine` write on confirmation (ADR-002), `OutboxEvent` row inserted in the same transaction (ADR-003), Stripe webhook handling — signature verification, `payment_intent.succeeded`, `charge.refunded` → Refund + compensating entry, `charge.dispute.created` / `closed` → Chargeback + compensating entry, `account.updated` → Restaurant onboarding fields (ADR-008, ADR-009). **Tests are mandatory here, not deferred** — this closes the single biggest gap in v1.0, where the money-touching sprints were exactly the ones missing an explicit Tests task.

**Known issue to fix while wiring up `IdempotencyInterceptor` here, not rediscover later (flagged during Sprint 1 foundation work, `src/common/idempotency/idempotency.interceptor.ts`):** global interceptors (`AuditLogInterceptor`, `ResponseInterceptor` — registered as `APP_INTERCEPTOR` in `app.module.ts`) wrap *outside* a method-level `@UseInterceptors(IdempotencyInterceptor)`. On a replayed idempotent request (cached response returned, handler never re-invoked), `AuditLogInterceptor`'s `next.handle()` still resolves and still writes an `AuditLog` row — logging a second "mutation" that didn't actually happen. Fix before this sprint's Definition of Done is considered met: either have `IdempotencyInterceptor` mark the request when serving a cached replay (e.g. a request-scoped flag `AuditLogInterceptor` checks and skips on), or reorder so idempotency resolution runs ahead of the audit interceptor in the chain.

Definition of Done: Test payment succeeds. Every `JournalEntry` created balances (debits = credits). Webhook processing is idempotent under replay. A test refund produces a correct compensating entry and the Ledger still balances. A replayed idempotent request produces exactly one `AuditLog` row, not two.

---

# Sprint 6
## Tips

Tasks: Preset Tips, Custom Tip, Automatic Allocation — writes one `LedgerLine` credit per tip, Individual strategy (ADR-007), `TipAllocationStrategy` interface in code (Pool / Shift / Percentage / Role-based designed, not implemented), Tip History, Restaurant Configuration, Tests.

Definition of Done: Customer leaves a tip. Exactly one `LedgerLine` credits the correct Membership's Wallet. Restaurant sees analytics. Adding a second allocation strategy later requires no schema change.

---

# Sprint 7
## Wallet

Tasks: Wallet scoped to Membership (ADR-006), Balance — a projection updated by the Outbox consumer, the first real use of Sprint 1's polling worker, History, Pending, Available, multi-Membership aggregation for the Waiter Portal, Future Withdrawals Placeholder, **Tests.**

Definition of Done: Wallet always matches the sum of that Membership's `LedgerLine` rows. A Wallet can be deleted and rebuilt from `LedgerLine` alone and match exactly.

---

# Sprint 8
## Transactions

Tasks: Transaction List, Transaction Details — breakdown computed from `LedgerLine` at read time, never stored on Transaction (ADR-002), Search, Filters, Pagination, Export CSV, **Tests.**

Definition of Done: Restaurant can audit every payment. Every Transaction's displayed breakdown sums exactly to its `gross_amount`.

---

# Sprint 9
## Dashboard

Tasks: Today's Revenue, Today's Tips, Revenue Chart, Recent Payments, Top Staff, Average Tip, **Tests for aggregation logic.**

Definition of Done: Owner understands today's business in under five seconds. Dashboard figures match a manual sum over `LedgerLine`.

---

# Sprint 10
## Analytics

Tasks: Revenue, Tips, Staff, Performance, Reports, Exports, **Tests for aggregation logic.**

Definition of Done: Restaurant can measure performance. Every analytics figure is reproducible from `LedgerLine`.

---

# Sprint 11
## Security Hardening

Reframed from v1.0: rate limiting and audit logging already exist since Sprint 1. This sprint tunes and pressure-tests them — it is not their first implementation.

Tasks: Per-endpoint rate limit tuning, Permission Review (audit every `RolePermission` row), Validation Review, Security Headers, webhook signature verification audit, OWASP Top 10 review, penetration test pass, `@nestjs/core` 10→11 major upgrade (flagged as a deferred finding during the pre-Sprint-10 dependency audit, confirmed by the Founder as belonging to this Sprint specifically; done as its own focused task with its own live verification, not mixed into the rest of the audit — same precedent as the Next.js 14→15 upgrade, `IMPLEMENTATION_PLAN.md` Sprint 5-era work).

Definition of Done: OWASP Top 10 checked. No endpoint is missing a rate limit or a permission check.

---

# Sprint 12
## Testing

Reframed from v1.0: unit and integration tests already exist per module since Sprint 2. This sprint adds end-to-end, regression, and resilience testing on top of them — not the first tests written.

Tasks: End-to-end critical-flow tests (register → create restaurant → invite staff → pay → tip → wallet updates → dashboard), Regression suite, Smoke tests, Load testing on the Payment/Ledger path, Chaos test — kill the Outbox worker mid-run and confirm it resumes without losing or duplicating an event.

Definition of Done: Coverage acceptable. Critical flows tested. The Outbox recovers correctly from a mid-processing crash in a test.

---

# Sprint 13
## Deployment

Tasks: Docker, GitHub Actions, Production Database, Domain, SSL, Monitoring — including Outbox Lag alerting, Backups.

Definition of Done: Production online. Outbox Lag is a monitored, alertable metric from day one, not added later.

---

# Development Rules

Never work on more than one major module simultaneously. Every module reaches production quality before starting the next.

---

# Daily Workflow

Morning → Pull latest code → Review open issues → Select task → Read documentation → Implement → Test → Self Review → Commit → Push → Pull Request.

---

# Pull Request Checklist

Business Logic, Security, Performance, Documentation, Testing, Naming, Architecture. Any money-moving change goes through the Ledger Module — no PR should compute or edit a balance directly. No PR merges without review.

---

# MVP Completion Checklist

Owner can register. Restaurant created. Team invited (Membership). Customer pays. Customer tips. Wallet updates. Dashboard updates. Reports work. A refund processes correctly and the Ledger stays balanced. A reconciliation query — sum of debits equals sum of credits, per account — returns zero discrepancies. Production deployed. Documentation complete.

Only then is MVP complete.

---

# Blocking Gate Before The First Pilot Restaurant

**Not a task and not an intention. A condition that must be false before any real restaurant is shown the registration screen.**

`CURRENT_PLATFORM_TERMS_VERSION` (`apps/backend/src/common/agreements/agreement-versions.ts`) must no longer be `UNPUBLISHED-no-terms-document-exists-yet`, and the Terms of Service and Privacy Policy it names must actually exist and be reachable from the links on that screen.

**The reason is not compliance paperwork.** Registration now writes an `agreement_acceptance` row saying *this person accepted revision X at time T* (ADR-049). While the version is a placeholder, every such row is a **false record** — it asserts agreement to a document nobody can produce. A missing record is visibly missing; a false one looks exactly like a real one, and looks more convincing the longer it sits in the table.

**A false record is worse than no record.** That is why this is a gate rather than a to-do.

Checking it requires no tooling: the constant either is the placeholder or it is not. The placeholder was written to be unmistakable in the data itself for the same reason — a date string would have produced rows that look published.

Two obligations feed the same gate, both found in the Sprint 14 Stripe research and both genuinely unmet: **our own terms of service**, and **our own privacy policy referencing Stripe's role**. The second is an information duty under GDPR Art. 13, not a consent — see ADR-049 for why that distinction decides the shape of the screen.

**Two code paths must be closed before the gate can lift, not one.** `POST /auth/register` records an acceptance as of ADR-049. `POST /memberships/invitations/accept` — the other path in the backend that creates a `User` — still does not, so an invited person becomes a User with no record of agreeing to anything. It is open because that screen does not exist yet and a required field with no screen to fill it would break the endpoint's only current caller. It is also the path a **waiter** takes, which is the population whose separate treatment is half of ADR-049's reasoning, so it is the more consequential of the two rather than the leftover.

---

# Deferred, Not Yet Scheduled

Dependency-audit findings that require a major-version bump are never mixed into a routine audit or another sprint's own task list — each earns its own focused task with its own live verification (typecheck, tests, both builds, and a real running-app check where the surface is user-facing), the same discipline `@nestjs/core` 10→11 got once assigned to Sprint 11 above. Listed here until a Sprint claims them, so the decision isn't only recoverable from chat history:

- **Prisma 5→7.** Two majors at once (5→6, 6→7) — flagged during the pre-Sprint-10 dependency audit, deliberately not bundled into Sprint 11 (rate-limit tuning and Prisma's own breaking changes shouldn't compete for review attention in the same PR). Needs its own scoped plan before it gets a Sprint.
- ~~**vitest 2→3.**~~ **Done (ADR-037).** Completed as its own focused task with its own live verification, exactly as this section requires. Achieved its stated purpose rather than merely bumping a number: `check-audit.js`'s ignore list is now **empty**, and CI passes without it — the four advisories it used to excuse are genuinely gone, not re-justified.
- **Multi-factor authentication.** Sprint 13 (ADR-032/ADR-033) closed the breached-password half of `THREAT_MODEL.md`'s combined "no MFA and no breached-password check" entry, deliberately leaving MFA itself untouched — Founder's own explicit instruction: a large, standalone feature, not a point fix alongside five narrower ones. Needs its own scoped plan (which factor(s), enrollment/recovery UX, whether it's mandatory or opt-in per Role) before it gets a Sprint.

Not a dependency upgrade, but deferred by the same rule — an explicit decision with a named trigger, so it stays recoverable from this document rather than only from chat history:

- **Staging environment (ADR-035).** The project has exactly one Railway environment: `production`. Everything that is not a developer's laptop is live production — which is the shared root of tunnelling into the production database to verify alerting, creating throwaway test restaurants in it, and having nowhere to rehearse a restore. Its full shape is already decided (ADR-035: separate Railway environment, separate Stripe sandbox, separate JWT/webhook secrets, separate alert channel, synthetic seed with production dumps **prohibited**), so this is scheduling, not design. **Deferred with the same trigger: before the first real pilot restaurant is onboarded.** Deferred for two specific reasons, neither of which is cost — the entire production stack currently bills around $1.83/month, so a duplicated idle environment is a rounding error. It is **blocked**: ADR-035 requires a second Stripe sandbox, and Stripe integration is currently non-functional (`invalid_v2_key`, open with Stripe support), so half of staging could not be exercised even if it existed. And it is **premature**: staging exists to stop us touching a database holding customer data, and there is no customer data yet. That second reason expires exactly when the trigger fires.

- **Off-platform database backup.** **The reason for this item has narrowed, and the narrowing is the point** — an earlier version of this entry leaned partly on retention depth, and that argument is now closed: PITR plus Daily/Weekly/Monthly volume snapshots (6 / 27 / 89 days, `THREAT_MODEL.md` entry 22) cover both fine-grained recent recovery and damage discovered months later, through two mechanisms independent enough that one failing does not take the other with it. Depth is no longer the gap.

  What remains is the one thing no in-platform mechanism can address by construction: **every copy lives inside Railway.** PITR, all three snapshot tiers and the volume itself share a single point of failure that is not a disk — losing access to the account, or the account's own data being lost, takes all of them at once. For a system whose entire premise is an authoritative financial Ledger, one copy outside that blast radius is the reasonable end state, and it is now the *only* remaining reason to build this.

  **Deliberately deferred, with a specific trigger rather than "someday": revisit before the first real payment from the first real pilot restaurant.** The deferral reason is honest and time-bound and has not changed — today the production Ledger is empty (no payment has ever been captured in production), so an off-platform copy would be protecting nothing, while the work itself is real (where it lives, how it is encrypted, who holds access, how its own restore gets rehearsed). The moment real money moves through it, that calculus inverts. Founder decision.

- **`Role.name` stops doing two jobs.** It is currently both the stable key — `seed.ts` upserts on it, fixtures look up by it — and the text a human reads in a role picker. Today those coincide, because "Owner" and "Manager" happen to be reasonable labels in English. **They stop coinciding the day Lithuanian arrives:** a translated label cannot be the upsert key, and `ADR-040`'s dictionary translates strings in *code*, not values in *tables*. Renaming "Administrator" to something clearer would break the same way, for the same reason. The fix is a display label separate from the key, plus a decision on where its translation lives — small, but a schema change and therefore not something to do in passing. **Trigger: when Lithuanian arrives** (`ADR-040`'s own trigger — before the first pitch).

- **`seedRbac` can grant a Permission but cannot revoke one.** Found by auditing the create-vs-update class the Founder asked about after ADR-044's seed fix, and it is the sharper instance of it.

  The Role and Permission upserts are complete (both mirror `create` in `update`, and the `RolePermission` upsert has nothing to update — its two fields *are* the composite key). But the loop only ever **adds** `RolePermission` rows. **Remove a permission from a Role in `seed.ts`, deploy, and the row stays in the database. The permission remains granted while the code says it was revoked.**

  Two properties make this worse than an ordinary omission. **It is directional in the dangerous way** — grants apply, revocations do not — on the matrix that decides who can do what. And **it cannot reproduce on a developer's machine**: `db:reset` rebuilds the matrix from nothing, so the seed always looks correct locally, and the divergence exists only where rows already exist. Which is production.

  Not urgent today — no Role's permission list has ever narrowed. It becomes urgent the first time one does, and that is exactly the moment nobody will be watching for it. **Fix shape: reconcile rather than add — delete `RolePermission` rows for that Role whose permission is not in the intended list, in the same pass.** Small, but it changes a seed from additive to authoritative, which deserves saying out loud rather than slipping in.

- **~~The ADR-005 reachability predicate is hand-rolled in 13 places while a shared utility exists.~~ CLOSED by ADR-047.** The heading stood in the present tense after the body below was marked closed — an entry contradicting itself, found in the Sprint 14 documentation sweep. `restaurant-reachability.util.ts` was extracted at the pattern's fourth occurrence, and its own comment records the exception: *"the three existing call sites are left as-is to avoid unrelated churn in already-shipped modules."* **There are now thirteen**, across `membership`, `payment`, `restaurant`, `settings`, `tip`, `transaction` and `wallet` — the decision was applied to new call sites, the un-migrated count grew afterwards, and the comment describing the exception went stale without anyone noticing.

  **This is not a tidiness item.** `CLAUDE.md`'s Architecture Review paragraph exists because this exact predicate has already shipped wrong twice — `RestaurantService.findAllForUser` and `TipService.assertReachable`, both by comparing `restaurantId === null` without the `organizationId` check. Thirteen independently-maintained copies of a predicate the project has twice got wrong is a risk surface, not a style preference.

  Audited alongside it and found **fully adopted**, so this is one instance rather than a habit: `splitPlatformFee` (both intended call sites), `restaurant-ledger-window.util` (both), `timezone-day.util` (both, via different exported functions), `seedRbac` (consumed by `global-setup.ts` as intended). **No trigger — this is scheduled work, not a watch item.**

  **Costed by reading all thirteen rather than estimating from the count, because they are not one job:**

  | Group | Sites | Shape | Effort | Regression risk |
  |---|---|---|---|---|
  | **A** | 7 | Byte-identical to `isRestaurantReachable(user, restaurant)` — `membership` L63, `payment` L201/L219, `restaurant` L194, `settings` L51, `tip` L131, `transaction` L276 | ~30 min | **Very low.** The same expression, and every one of these modules already has reachability tests. |
  | **B** | 4 | Reachability **+** permission → `hasPermissionAtRestaurant` — `membership` L141, `restaurant` L217, `settings` L67 are drop-in; **`payment` L272 is not** (`getGrantingMembershipOrThrow` returns the granting Membership, not a boolean, and needs a `findGrantingMembership` helper) | ~45 min | **Low, concentrated in one site** — and that site is on the money path. |
  | **C** | 2 | **Not the same call.** `membership` L123 and `wallet` L155 reach a *Membership*, not a Restaurant: their `restaurantId` may legitimately be null, and Wallet adds an own-wallet short-circuit plus its own `restaurantId !== null` requirement. | — | Forcing these into the shared signature would be the actual danger. |

  **CLOSED by ADR-047.** Ten sites consolidated, three excluded — not two. The estimate above counted `MembershipService` as one exclusion; it holds *two* nullable-target checks (`getReachableOrThrow` and `assertPermission`), so the split is 10/3 rather than 11/2.

  **The exclusion stopped being a judgement call while the work was being done.** Surveying these very call sites turned up a live cross-Organization leak in `MembershipService`: with an org-wide target, `m.restaurantId === target.restaurantId` is `null === null` for any caller org-wide in any Organization, and `||` short-circuits before the organizations are compared. An unrelated Owner could read another Organization's org-wide Membership and re-role it. `WalletService` faces the identical nullable target and is correct, because it refuses org-wide Wallets outright. **The two read as the same call and differed on exactly the check that decides** — which is what makes excluding them a safety property rather than tidiness.

  The recurrence guard landed with it: `repo-invariants.spec.ts` fails if the predicate is written inline anywhere outside the utility, falsified by reintroducing it in `tip.service.ts`. Deliberately no allowlist — the excluded three compare against a Membership's or Wallet's `organizationId`, never a Restaurant's, so they are excluded by construction rather than by a list someone edits to go green.

- **Fixtures build their Role and Permissions from the seed, mechanically rather than by discipline.** `CLAUDE.md`'s Testing Philosophy now forbids the literal; this item is what would make the rule unbreakable rather than remembered — the same preference for a mechanism that produced the fixture-safety check and the absent warning colour.

  **The shape is cheap because half of it exists:** `seed.ts` already exports its `ROLES` matrix, and exports it for exactly this reason — the first drift incident was closed by making `test/global-setup.ts` consume it instead of keeping a copy. The specs simply never followed. A helper reading `permissions` from that same exported constant, plus a check that fails on a literal `permissions: [` in any spec outside the helper, closes it. **Estimated cost: the helper plus roughly a dozen call sites — under an hour**, with no schema change and no production code touched.

  Deferred rather than done only because it landed mid-security-fix, and mixing a test-infrastructure refactor into a diff that closes a live data leak would hide both. **No external trigger: this is simply next after the current sequence.**

- **Session tokens move from `localStorage` to an httpOnly cookie.** The API returns `accessToken` and `refreshToken` in the JSON body (`API_Contract.md`, Login), so the browser has to store them somewhere, and the login screen (Sprint 14) uses `localStorage`. **It is readable by any script that runs on the page**; an httpOnly, `SameSite` cookie set by the backend would not be.

  **Deferred deliberately, and the reason is about change hygiene rather than risk appetite:** switching is a change to the *authentication contract* — the API would set a cookie rather than return a token, and every caller changes with it. Making that change in the middle of delivering the first screen would mean two independent changes arriving in one diff, each hiding the other's failures. The Founder's call, and the right one.

  **Trigger, explicit: before the first pilot restaurant.** Today the exposure is theoretical — there are no real users and no third-party scripts on any page. Both of those stop being true at exactly the moment the trigger fires.

- **Refresh-token revocation that survives a Redis outage (ADR-019's own trigger, now fired).** **This is not a new finding.** ADR-019 accepted the risk explicitly and named the condition for revisiting it in its own Consequences: *"revisit if refresh-token revocation ever needs to survive a Redis outage."* Noticing that the Sprint 13 volume-backup schedules cover only the Postgres volume, and that the redis volume has no schedule at all, is that condition arriving — recorded here so the revisit happens because the ADR said so, not because someone remembered.

  Redis currently holds two kinds of state: rate-limit counters, and the revocation set — individual `jti`s rotated out, plus `familyId`s revoked on refresh-token reuse detection. Losing the counters is harmless. Losing the revocation set means **tokens that were deliberately invalidated become valid again** — a logout, or a family revoked because we detected a stolen token being replayed, silently un-does itself.

  **The fix is explicitly not "turn on snapshots for the redis volume."** A restored, stale revocation set is worse than an empty one, and the distinction is the whole reason this needs design rather than a toggle: an empty set is honestly wrong in a way we can reason about — every outstanding token is valid, we know it, and we can act on it. A stale set is *dishonestly* wrong — some genuinely revoked tokens are valid again while the system reports itself protected, which is the failure mode that gets discovered by an incident rather than by a check.

  **Deferred until after the frontend. Founder decision, with the reasoning recorded because it is what makes the deferral defensible rather than convenient:** the blast radius is bounded by the token's own TTL (at most 7 days, after which every affected token expires by signature regardless), there are zero real users today so there is nothing outstanding to un-revoke, and the real solution needs actual design — a Postgres table, a strategy for pruning expired rows, and, most consequentially, the latency cost of a database read in the token-verification path **on every authenticated request**, which is exactly why ADR-019 put this in Redis to begin with. That last point is the reason this cannot be a quick fix: it re-opens ADR-019's original trade-off rather than patching around it.

- **~~Does the seed run on deploy, and may it delete?~~ ANSWERED by ADR-048 — yes, and no, respectively.** The entry below is kept because the *separation* of the two questions is the reasoning ADR-048 rests on, and because this item stood open in the plan after the ADR that closed it had merged. `railway.backend.json` runs migrations before a deploy and nothing else, so `seed.ts` has never executed automatically. ADR-044's addendum records what that cost: a shipped privilege-escalation fix that was not in effect in production for eleven days, because the code read a column the data never received. **The formulation to keep is the Founder's — `seed.ts` describes production rather than making it so.**

  The Founder's instruction is that these are two separate decisions and must not arrive together:

  - **The seed runs on every deploy.** Makes it authoritative *on a schedule*. On its own this is close to safe today, because the seed is `upsert`-only: it can add and correct, never remove.
  - **The seed may delete — DONE (ADR-046).** It now reconciles: a Permission removed from `seed.ts` is revoked on an existing database instead of surviving forever. **This raises the stakes on the remaining decision rather than settling it.** Running the seed used to be safe in the sense that nothing could be lost; it can now revoke, which makes a manual run a privileged operation and an automatic one a standing risk. The two decisions are now one apart instead of two, and the remaining one is the one with teeth.

  Each alone is defensible. **Together they mean every deploy can silently revoke permissions in production**, which is a materially different system from either.

  **The question the ADR is required to answer, recorded so it cannot be skipped: if the seed is authoritative and runs on every deploy, what protects production from an incomplete `seed.ts`?** One fact argues in favour and does not answer this — `seed.ts:135` is the **only** writer of `RolePermission` anywhere in the codebase (verified by grepping the table, not by recalling the flows), so an authoritative seed cannot be fighting some other grant path. But that establishes only that nothing else writes; it says nothing about the seed itself being wrong. **This exact failure has already happened once in this project**, in the test fixtures: `test/global-setup.ts` maintained its own copy of the matrix and had gone stale at 4 of 10 Permissions and 3 of 4 Roles. A stale matrix that can only add is a documentation bug. A stale matrix that can delete is an outage.

- **The suite should clean up after itself, and today it does not.** Every run leaves its rows in the shared development database — roughly a few dozen Payments and Outbox events each — and nothing removes them. Three failures in one sprint came from that accumulation: `payment-reconciliation.service.spec.ts` twice (once with `Number of calls: 460`, once at 768 Payments) and `outbox-poller.service.spec.ts` once. Each was diagnosed and then fixed with `pnpm run db:reset`, which is a workaround performed by whoever happens to be looking.

  **Honest cost, because this is bigger than it sounds.** It is not one cleanup hook. Specs create Organizations, Restaurants, Memberships, Payments, Transactions, JournalEntries, LedgerLines, OutboxEvents and Wallets, with foreign keys between them, and several deliberately assert on rows created by *other* code paths (the Outbox poller's chaos test, the reconciliation batch). A blanket truncate between files would race with vitest's parallel file execution, which is the same class as the `upsert()` race `global-setup.ts` already documents. Doing it properly means either per-file transactional rollback (a real change to how every spec obtains its Prisma client) or per-spec ownership of its own rows (touching most spec files). **Estimate: a focused sprint task, not an afternoon** — and it is test infrastructure, so it competes directly with product work.

  **The instrument found the number that actually matters on its first run, and it is a hard edge rather than a vague "too many".** The suite leaves permanently-unpublished OutboxEvents behind — deliberately malformed rows from the tests that assert the retry path, which by construction can never publish. `OutboxPollerService` reads **50** per poll, oldest first, so once that debris fills a batch the poller specs' own fresh events never enter one, and they fail for a reason unrelated to the code under test. A real failure was observed at **61 unpublished**.

  **The reframing that follows, stated plainly because the softer word invites skipping it: `pnpm run db:reset` is not hygiene, it is a precondition of a trustworthy run.** "Hygiene" makes it sound like tidying — optional, virtuous, safely deferred. It is not: past the threshold the suite reports failures that have nothing to do with the code under test, and the person reading them has no reason to suspect the database. A failure produced by leftover rows is not a weaker signal than a real one, it is a **wrong** one.

  **How fast it accumulates is deliberately not stated as a rate.** Observed counts across consecutive runs were 0 (after a reset), then 45, 10 and 61 — it depends on ordering and on how much each run's poller manages to publish. The honest claim is the direction and the threshold, not a per-run figure; an early draft of this entry asserted "roughly 45 per run" on the strength of a single measurement and the next run contradicted it.

  **Deferred, with two things shipped in the meantime** (ADR-046's PR): `global-setup.ts` prints the counts unconditionally, and escalates to an explicit WARNING naming `db:reset` once `unpublished >= 50`. Neither fixes accumulation; together they remove the need to remember the rule before suspecting it, and turn a vague "too many rows" into the one number with a hard edge. **No trigger date — next whenever test infrastructure gets a slot.** The instrument stays useful afterwards: a count near zero is the fastest confirmation that cleanup actually works.

- **Executable files that no compiler checks (audited on the Founder's instruction, after `prisma/seed.ts` turned out to be one — found the week it became able to delete production data).** The question is the input-grep method pointed at the compiler: *what runs that nothing typechecks?* Answered by listing every `.ts`/`.js`/`.mjs` outside a `src/` directory and checking it against each package's `tsconfig` include. `prisma/**` and `test/**` were closed in ADR-046's PR. Four remain, and the first two are the ones that matter because **they are themselves gates**:

  - **`scripts/preflight-deploy.js`** — plain JS, no `// @ts-check`. It runs before every manual production deploy and decides whether the deploy proceeds.
  - **`.github/scripts/check-audit.js`** — plain JS, no `// @ts-check`. It runs on every CI run and fails the build on a high/critical advisory. A guard that can quietly stop guarding is the recurring shape of this sprint (ADR-045).
  - **`apps/backend/vitest.config.ts` and `vitest.load.config.ts`** — package-root files, outside `src`/`test`/`prisma`, so still uncovered. Lower stakes: a mistake here breaks the test run loudly.
  - **`apps/frontend/tailwind.config.ts`** — the frontend include is `src/**` plus Next's generated types; and `apps/e2e/scripts/build-apps.mjs` is `.mjs`, which `**/*.ts` does not match.

  **Not fixed on discovery**, deliberately and for the same reason as the environment variables: `// @ts-check` on either script may surface real errors, and fixing a deploy gate belongs in its own change rather than riding along in one about seeding. Recommended order when it is taken up: the two gates first, the configs after.

- **Environment variables that became load-bearing after being declared optional (ADR-045's class, audited on the Founder's instruction).** `ALERT_WEBHOOK_URL` is now required in production and is not the only one of its shape. Two others were found by reading every `.optional()` and `.default()` in `env.validation.ts` against what actually consumes them:

  - **`NODE_ENV` — CLOSED, and it was the sharpest of the three.** It carried `.default("development")`, which made it the gate that could go missing on its own. `StripeService`'s boot-time liveness probe — ADR-038 Decision 2, built specifically to catch the one-character secret truncation `env.validation.ts` admits it cannot — is gated on `NODE_ENV === "production"`, as are the production rules above. **An environment that lost the variable would have silently disabled all of them.** A guard whose gate can disappear is a guard with an invisible off switch.

    The default is removed and the variable is required. **The cost was measured rather than assumed, because "this will break local development" is the obvious objection and it was false:** every path that actually boots the app already sets `NODE_ENV` explicitly — Railway in production, `apps/backend/.env` and `.env.example` locally, vitest's own `test` (verified with a probe rather than taken from documentation), `playwright.config.ts` for the e2e harness — and `docker/docker-compose.yml` runs only Postgres and Redis, with no application container at all. Nothing that exists relied on the default.

    Proven on the real process in both directions, not only by tests: with the variable, `health: 200`; without it, the app refuses to start with `Invalid environment configuration: NODE_ENV: Required`. The test that used to document the weakness now asserts it is closed.
  - **`FRONTEND_URL` — CLOSED.** It defaults to `http://localhost:3000` and is read at `restaurant.service.ts:138` for Stripe Account Links `refresh_url`/`return_url`, so a missing value would redirect a restaurant owner finishing Stripe onboarding to localhost — no boot failure, no log, just a broken return journey at the end of the most important flow a new customer completes. **The rule that closed it is not "required in production", and the difference is the interesting part:** because this variable carries a `.default()`, an unset value and an explicitly-localhost one are indistinguishable by the time validation sees them, so requiring presence would have caught neither. Production now rejects a **loopback host** — which catches both, and treats an explicitly wrong value as no better than a missing one. Verified against the live service before shipping: production is `https://plaintabs.com`, so the rule changes nothing about today's deploy.
  - **JWT TTLs are not set in production at all** (verified by listing variable names on the live service): `JWT_ACCESS_TTL_SECONDS` and `JWT_REFRESH_TTL_SECONDS` run on their code defaults of 900 s and 7 days. Lowest severity of the three — the values are deterministic and documented — but worth recording because ADR-019's deferral of refresh-token revocation rests explicitly on *"at most 7 days, after which every affected token expires by signature"*. That security argument currently depends on a default nobody chose rather than a value someone set.

  All three are now closed, each with a different remedy — required, value-constrained, and default-removed respectively. The general rule they share is worth stating once: **a variable's optionality is a claim about consequences, and it stops being true the moment something starts depending on it.** Nothing re-checks that claim when the dependency is added, which is exactly how all three arose.

  **Evaluated on the Founder's instruction, and NOT built: a test cross-referencing the optional variables against the places their values are used.** It does not survive contact with what it would have to check. Enumerating the optional keys is easy — the zod schema is introspectable. Finding the consumers is easy — they are `config.get`/`getOrThrow`/`process.env`. But the property that matters is neither: it is *"does this consumer degrade silently when the value is absent or defaulted?"*, which is semantic and invisible to any static check. `FRONTEND_URL` was consumed through `getOrThrow`, which reads as safe and was not, precisely because the default guaranteed a value. A test that flagged "optional variable, used somewhere" would flag every one of them, so it would need an allowlist — and **an allowlist that someone edits to make the build green is a rubber stamp**, the same decay that let `test/global-setup.ts`'s permission matrix go stale for a whole sprint. It would convert a design question into a chore and reliably lose.

  **What would be worth ~20 lines, if we want a mechanism here at all:** an inventory test that pins the *set* of optional/defaulted variables, failing when that set changes rather than judging whether any member is safe. No semantics, no allowlist, and it puts a human decision at the moment optionality is declared. Its honest limit is that it catches the declaration side only — not the case that actually bit us three times, where the variable was already optional and a dependency arrived later. That case may simply not be mechanisable, which is why the rule went into `CLAUDE.md` as a question to ask when *adding a dependency*, rather than as a check.

- **The Outbox poller has no claim step (ADR-003), found while reading it for ADR-045.** `OutboxPollerService.poll()` selects `publishedAt: null` and marks the row published only later, inside the dispatch transaction. Between those two moments the row is visible to any other poller: no `SELECT … FOR UPDATE SKIP LOCKED`, no claimed-at column, no advisory lock. **Two instances read the same rows and both dispatch them.**

  **Two things hold it harmless today, and neither is the mechanism.** The first is that production runs a single backend instance. The second is easy to mistake for safety and must be written down as what it is: `WalletProjectionService` **recomputes a balance in full rather than applying a delta**, so running it twice produces the same number. That is a property of the only consumer that exists — not a guarantee the Outbox offers. **A consumer that increments, appends, or sends anything outward converts double dispatch into double counting, on the money path.** This is ADR-042's shape one layer down: correctness resting on an infrastructure fact recorded in no document, except that here the fact is a coincidence of the current handler rather than an instance count.

  **Not fixed on discovery, deliberately** — it changes the Outbox's concurrency contract, it needs its own tests, and it was found in the middle of an unrelated alerting change.

  **The trigger is two triggers, and they are not the same kind of event. Keeping them separate is the point.**

  - **A second backend instance.** Requires a deliberate act — someone raises the replica count in Railway. It is a decision, it has an owner, and it can be gated: whoever scales the backend must land this first. The hazard is that the act is *one click* and looks purely operational, so nothing about it prompts a question about the Outbox.
  - **A second Outbox consumer.** Requires no decision at all — it arrives through ordinary feature work. `SYSTEM_ARCHITECTURE.md` already names Restaurant and Analytics projections as next, and `outbox-poller.service.ts`'s own comment says a handler registry earns its cost when the second consumer lands. **That sprint will be about the projection, not about concurrency**, and the person writing it has no reason to look at how rows are claimed.

  The second is the one to defend against, precisely because it does not announce itself: the first fires when someone chooses something, the second fires when someone builds the feature that was always planned. **Whichever comes first, but the second is the one that will arrive without anybody deciding it should.**

- **Error-rate monitoring, and the Sentry decision it belongs to (step 2 of ADR-045).** Step 1 shipped: an unhandled error now leaves the process as a deduplicated alert, and a failure outside the HTTP cycle is caught at all for the first time. **It closes one specific hole and deliberately not the adjacent one.**

  What remains uncovered is *handled* errors. An `AppException` returning 402 fifty times in a minute passes through `AllExceptionsFilter`'s typed branches, never reaches the unhandled path, and is invisible to everything built in ADR-045 — while being, for a payments product, plausibly more urgent than any crash. Fifty declined payments in a minute is either a Stripe incident or a bug we shipped, and today the only way to learn it is for a restaurant to phone.

  This needs somewhere to **aggregate** — a rate over a window, per route, per error code — which is a different mechanism from a webhook POST and the strongest honest argument for a third-party tool. **Trigger: before the first pilot restaurant, or the first production payment, whichever comes first** — both are the moment "nobody has phoned" stops being evidence that nothing is wrong.

  The Founder's four conditions on Sentry stand and are recorded here so they survive the chat that produced them: no PII in events; the redaction list must have **one source shared by pino and Sentry**, because two lists diverge and the second one silently stops matching; the SDK is evaluated as a dependency like any other; and it is added as a *second sink for our policy*, never as the thing that defines it.

---

# Final Rule

Never build the future before the present works. Every completed sprint becomes the foundation of the next. Quality compounds. So does technical debt. So does an unbalanced Ledger — check it every sprint, not only at the end.
