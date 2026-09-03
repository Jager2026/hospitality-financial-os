---
title: ADR-066 — The Accountant role: two permissions, and why it is not a reduced Manager
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-066 — The Accountant role: two permissions, and why it is not a reduced Manager

**Status:** Accepted (Sprint 14), 2026-09-03. Role and tests only; no new endpoints.

---

## Context

ADR-065 decided that accounting gets both a shift list and a calendar list. **Nothing said who the accountant is.** Today a bookkeeper would have to be given a Manager membership — which also lets them invite staff, disable memberships and reconfigure tips — or an Owner one, which lets them do everything.

`DATABASE.md` has named `Accountant` as a future role since Sprint 0. This is that role.

---

## Decision

**A seeded `Accountant` role holding exactly two permissions: `reports.view` and `data.export`.** Nothing else.

**Not a reduced Manager**, and the distinction is the decision. Manager is *day-to-day operational control*: it invites staff, manages memberships, configures tips, and manages payment activity. **An external bookkeeper needs none of that** and should not be able to do any of it. Two permissions describe the job exactly: read the figures, take them out of the building.

**What it cannot do, by the absence of the permission each route requires:**

| Refused | Because it lacks |
|---|---|
| `GET /payments/{id}`, `POST /payments` | `payments.manage` |
| `PATCH /restaurants/{id}` (settings) | `restaurant.edit` (fine-checked in the service, ADR-005) |
| Inviting or managing staff | `membership.invite`, `membership.manage` |
| Tip presets | `tips.configure` |
| RBAC | `roles.manage` |
| Creating or closing a venue | `restaurant.create`, `restaurant.delete` |

**Attached through an ordinary `Membership`**, org-wide or restaurant-scoped. **No new mechanism**: reachability (ADR-005) is unchanged, and an accountant for a whole chain is an org-wide membership exactly as an Owner is.

**Grantable by a Restaurant** — `platformOnly` is false, unlike `Administrator` (ADR-044). A venue hires its own bookkeeper; that is not ours to mediate.

---

## The reconciliation gate — estimated first, then established by execution

**The concern was real and worth checking before writing anything.** ADR-046 made the seed *reconcile* rather than only add, and ADR-048's confirmation gate stops a run that would revoke anything. `restaurant.delete` was left un-renamed for exactly this reason: a rename would have looked like a revocation and blocked the next deploy.

**Adding a role does not trip it, and this was established by running the real code rather than by reading it.** `findStaleGrants` iterates the file's roles and selects `RolePermission` rows *not* in the intended set; **a new role has no existing rows, so it can contribute none.**

Two executions, both against a real database:

- The real seed, with `Accountant` present: `Seeded 10 permissions and 5 roles.` — **no revocation printed, gate not triggered.**
- `findStaleGrants` called directly from a test, asserting the Accountant contributes zero stale grants. **That assertion is in the suite**, so the claim is re-checked on every run rather than resting on one session's observation.

**No new Permission was created**, which is the other half of why this is cheap: the ten permissions are unchanged, so nothing that reads them can drift.

---

## Consequences

**`SEEDED_ROLE_NAMES` gains `Accountant`**, so a test fixture may name it and read its real grants from the database. The rule that a fixture never types a role's permissions as a literal (ADR-046's own lesson, paid for twice) applies to this role from its first day.

**The matrix is asserted AND the behaviour is asserted.** A permission present in a list is not a permission enforced on a route — this project has recorded five tests that once encoded a leak as the specification. So the suite also puts an Accountant through the real services: `AnalyticsService.getRevenue` and `exportRevenueCsv` resolve, `PaymentService.findOne` rejects with `PAYMENT_NOT_FOUND`. **Same caller, two paths, one allowed and one not** — an implementation gating neither, or both, fails one of them.

**Not built here:** any endpoint. This role is the *who*; ADR-065's second list is the *what*, and it is the next change.

**Not decided here:** whether an Accountant should see individual transactions (they can, through `GET /transactions`, which requires `reports.view`) while being refused individual *payments*. That asymmetry is inherited from the existing permission split, not introduced by this ADR — worth naming so it is a decision the next time someone looks, rather than a discovery.
