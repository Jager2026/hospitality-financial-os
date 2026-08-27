---
title: IMPLEMENTATION_PLAN
version: 2.10.0
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

- **Refresh-token revocation that survives a Redis outage (ADR-019's own trigger, now fired).** **This is not a new finding.** ADR-019 accepted the risk explicitly and named the condition for revisiting it in its own Consequences: *"revisit if refresh-token revocation ever needs to survive a Redis outage."* Noticing that the Sprint 13 volume-backup schedules cover only the Postgres volume, and that the redis volume has no schedule at all, is that condition arriving — recorded here so the revisit happens because the ADR said so, not because someone remembered.

  Redis currently holds two kinds of state: rate-limit counters, and the revocation set — individual `jti`s rotated out, plus `familyId`s revoked on refresh-token reuse detection. Losing the counters is harmless. Losing the revocation set means **tokens that were deliberately invalidated become valid again** — a logout, or a family revoked because we detected a stolen token being replayed, silently un-does itself.

  **The fix is explicitly not "turn on snapshots for the redis volume."** A restored, stale revocation set is worse than an empty one, and the distinction is the whole reason this needs design rather than a toggle: an empty set is honestly wrong in a way we can reason about — every outstanding token is valid, we know it, and we can act on it. A stale set is *dishonestly* wrong — some genuinely revoked tokens are valid again while the system reports itself protected, which is the failure mode that gets discovered by an incident rather than by a check.

  **Deferred until after the frontend. Founder decision, with the reasoning recorded because it is what makes the deferral defensible rather than convenient:** the blast radius is bounded by the token's own TTL (at most 7 days, after which every affected token expires by signature regardless), there are zero real users today so there is nothing outstanding to un-revoke, and the real solution needs actual design — a Postgres table, a strategy for pruning expired rows, and, most consequentially, the latency cost of a database read in the token-verification path **on every authenticated request**, which is exactly why ADR-019 put this in Redis to begin with. That last point is the reason this cannot be a quick fix: it re-opens ADR-019's original trade-off rather than patching around it.

---

# Final Rule

Never build the future before the present works. Every completed sprint becomes the foundation of the next. Quality compounds. So does technical debt. So does an unbalanced Ledger — check it every sprint, not only at the end.
