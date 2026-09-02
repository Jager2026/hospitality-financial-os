---
title: UX_API_RECONCILIATION
version: 1.0.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# UX_MAP reconciled against the API that actually exists

**Report only. No canonical document was edited and no frontend code was written.**

**Source of truth is the code** — controllers, decorators, guards, service response interfaces. `API_Contract.md` was used only as a cross-check, and where the two disagree that is recorded as its own finding, in **Section E**, because a contract that documents routes nobody built is a worse problem than a stale screen description.

**Scope:** Restaurant Portal and Waiter Portal. The Customer Experience screens were **not checked** — they are the Stripe terminal flow, not this API.

---

## How the route inventory was built, and why that matters here

Every route was extracted by a script over `apps/backend/src/**/*.controller.ts`: **57 routes**, each with its HTTP method, path, handler, and the `@RequirePermission` actually governing it.

**The first version of that script was wrong, and it is worth saying so before any of its output is believed.** It reported `GET /analytics/revenue` as having no permission. It has one. Two things defeated the naive reading:

1. `@RequirePermission` may sit **on the controller class** and be inherited by every route (`analytics.controller.ts:28`);
2. a method-level override sits **after** the `@Get(...)` decorator, not before it (`analytics.controller.ts:40-41`).

A backward-only scan sees neither. **This is the same instrument failure as PR #109** — a route parser that attributed each decorator to the wrong route and produced a page of phantom findings. It was caught here the same way: by running the scanner against a **known-answer pair** — one route that must come back permissioned (`/analytics/revenue` → `reports.view`), one that must come back bare (`/auth/login` → none) — before trusting a single line of its output. The corrected scanner passes both.

**Section E's diff had the same problem twice more, and both were caught the same way.** See its own note.

---

## A. Correct — UX_MAP matches the API

| Screen | Field / behaviour | Endpoint | Evidence |
|---|---|---|---|
| Dashboard | Today's Revenue + fixed caption | `GET /dashboard` | `dashboard.service.ts:51,54` — `todayRevenue`, `todayRevenueNote` as a server-returned constant |
| Dashboard | Today's Tips | `GET /dashboard` | `dashboard.service.ts:55` |
| Dashboard | Average Tip, basis points, `null` not `0` | `GET /dashboard` | `dashboard.service.ts:60` |
| Dashboard | Revenue Chart, 7 days | `GET /dashboard` | `dashboard.service.ts:35-37,61` |
| Dashboard | Recent Payments, all-time | `GET /dashboard` | `dashboard.service.ts:17-22,62` |
| Dashboard | Top Staff with display name **and** email | `GET /dashboard` | `dashboard.service.ts:25-32,63` |
| Employees | Role picker with name + description | `GET /roles` | `role.controller.ts:21`, `role.service.ts:37` |
| Employees | Invite scoped to one venue or all | `POST /memberships` | `membership.controller.ts:45` |
| Employees | Employee list per venue | `GET /restaurants/:id/staff` | `membership.controller.ts:102` |
| Employees | Per-restaurant Wallet for a person | `GET /memberships/:id/wallet` | `wallet.controller.ts:36` |
| Transactions | Refund / Chargeback block | `GET /transactions/:id` | `transaction.service.ts:34,42` — `refunds[]`, `chargebacks[]` |
| Transactions | Processing Fee as "—", never `0` | `GET /transactions/:id` | `transaction.service.ts:22` — typed `null`, not `string` |
| Transactions | Net Amount, Tips, Platform Fee | `GET /transactions/:id` | `transaction.service.ts:18-20` |
| Analytics | Five sections + five CSV exports | `GET /analytics/{revenue,tips,staff,performance,reports}[/export]` | `analytics.controller.ts:32-121` |
| Analytics | Export gated **separately** from reading | — | `reports.view` on the class (`:28`), `data.export` overriding per export route (`:41,61,81,101,121`). The split UX_MAP describes is real and enforced |
| Close A Venue | `DELETE` is a close, not a delete | `DELETE /restaurants/:id` | `restaurant.controller.ts:103` |
| Settings | Tip configuration | `GET`/`PATCH /restaurants/:id/settings/tips` | `settings.controller.ts:18,23` |
| Settings | Payment Configuration — Stripe status and outstanding requirements | `GET /restaurants/:id` | `restaurant.service.ts:115-117`; fields at `schema.prisma:202,207,210,213` |
| Waiter Wallet | Available / Pending / restaurant name | `GET /wallets` | `wallet.service.ts:7-17` — `availableBalance`, `pendingBalance`, `restaurantName` |
| Waiter Wallet | Ledger-derived history with direction and entry type | `GET /wallets/:id/transactions` | `wallet.service.ts:19-29` |
| Waiter Wallet | Withdrawals exist as a placeholder that refuses | `POST /wallets/:id/withdrawals` | `wallet.controller.ts:47` |
| Profile | Employment — every active Membership and its role | `GET /auth/me` | `jwt-auth.guard.ts:12-17` |
| Profile | Language is editable | `PATCH /profile` | `profile.controller.ts:20` |

**Also correct, and worth recording as such: the gaps UX_MAP already declares.** The document names four things as backend gaps rather than promising them — Staff Member on transactions, Audit Events, password change, and a role-permission catalogue. **All four are genuinely absent, exactly as described.** They appear below in **C** as capability gaps, not in **B**: the map is not stale about them, it is accurate about being blocked.

---

## B. Stale — UX_MAP describes something the API does not do

| Screen | Field | Reality | Evidence |
|---|---|---|---|
| Dashboard | **"Today's Transactions"**, defined as a count | **No such field.** `DashboardSummary` has no transaction count of any kind, and no `count` aggregation exists in the service | `dashboard.service.ts:48-65` |
| Dashboard | **"Average Bill" = revenue ÷ today's transaction count**, `null` not `0` | **No such field**, and its divisor does not exist either — see the row above | `dashboard.service.ts:48-65` |
| Dashboard | Banner naming the outstanding Stripe requirement | The Dashboard response carries **no** Stripe status at all — not `cardPaymentsStatus`, not `payoutsStatus`, not `requirementsDue` | zero matches in `dashboard.service.ts`; fields live on `GET /restaurants/:id` |
| Transactions | Transaction Card shows **Tip** | `TransactionListEntry` has `grossAmount` and **no tip field**. UX_MAP flags Staff Member as a known gap on this card but not Tip — this one is unrecorded | `transaction.service.ts:52-60` |
| Profile | "Owner Information … name and email cannot yet be changed" — implying they are at least displayed | **Name is not readable at all.** `GET /profile` returns `{id, locale}`; `GET /auth/me` returns id, email, locale, memberships — **no `displayName` anywhere**, though the column exists and the Dashboard returns other people's | `profile.service.ts:12`; `jwt-auth.guard.ts:8-18`; `dashboard.service.ts:206` |

**The Dashboard rows are the substantive finding in this section.** Two of the nine promised sections have no data source, and one of the two — Average Bill — is defined in UX_MAP down to its null-handling, which reads as though it were built. **A frontend built from this document would fail on the Dashboard first**, which is also the first screen an owner sees.

---

## C. Missing — a screen exists in UX_MAP with no endpoint behind it

**Per the task, this is not a work list. It is the input to deciding whether a screen should exist at all.**

### C1. The Waiter Portal has no waiter-scoped endpoints, and this is the largest single finding

UX_MAP describes five Waiter Portal screens. The permission facts:

- **The seeded `Waiter` role holds zero Permissions** (`prisma/seed.ts:86` — `permissions: []`).
- `GET /dashboard` requires `reports.view` (`dashboard.controller.ts:16`).
- `GET /transactions` and `GET /transactions/:id` require `reports.view` (`transaction.controller.ts:41,53`).

| Screen | Section | Reality |
|---|---|---|
| Waiter Home | Today's Earnings · Today's Tips · Today's Transactions · Average Tip · Recent Payments · Quick Statistics | **No endpoint serves any of it.** There is no waiter-scoped summary route; `GET /dashboard` is restaurant-scoped and permission-gated away from a Waiter |
| Waiter Home | Combined totals across multiple Memberships, with a per-restaurant filter (ADR-006) | **Not built.** Nothing aggregates across Memberships |
| Waiter Transactions | Restaurant · Time · Tip · Total Bill · Status · Reference Number | **A Waiter cannot call `GET /transactions` at all** — `reports.view` |
| Waiter Transactions | Details: Bill · Tip · Wallet Change · Payment Status · **Receipt** | Same refusal. Additionally **"Receipt" exists nowhere** in API or schema — UX_MAP already struck it from the *owner's* transaction screen for exactly that reason, but it survives here |
| Waiter Settings | Notifications · Theme · Privacy | **No endpoints.** UX_MAP removed Notifications/Theme from the *owner's* Settings and Profile as unbacked; the identical headings remain in the Waiter Portal |

**What a Waiter can actually reach today:** `GET /tips/me` (`tip.controller.ts:14`), `GET /wallets` and `GET /wallets/:id[/transactions]` (`wallet.controller.ts:13,18,23`), `GET /auth/me`, `GET`/`PATCH /profile`. **That is a Wallet screen and a tip history — roughly one and a half of the five screens described.**

**The decision this poses, stated rather than answered:** the Waiter Portal as mapped needs a waiter-scoped summary endpoint and a waiter-scoped transaction list, both of which are new surface with their own scoping rules. **Whether the pilot needs a Waiter Portal at all is the prior question** — a waiter can be paid without ever logging in, and the four screens named as the current priority are the owner's.

### C2. Owner-side screens with no source

| Screen | Section | Reality |
|---|---|---|
| Settings | **Permissions** — "show what each role can do" | `GET /roles` returns `{id, name, description}` only — **no permission list** (`role.service.ts:37`). `GET /auth/me` exposes permissions for the caller's **own** roles only. UX_MAP already calls this a gap |
| Profile | **Security** — change your own password | **No endpoint.** Auth has register / login / refresh / logout / me and nothing else (`auth.controller.ts:28,53,60,70,80`). UX_MAP already calls this a gap |
| Transactions | **Staff Member** on card and details | Not returned by any transaction endpoint (`transaction.service.ts:26-60`); `waiterMembershipId` is an input filter only. UX_MAP already calls this a gap |
| Transactions | **Audit Events** | `AuditLog` is written (ADR-010) and **no route reads it** — no audit controller exists in the 57 routes. UX_MAP already calls this a gap |
| Settings | Business Details · Restaurant Information | Served by `PATCH /restaurants/:id` (`restaurant.controller.ts:87`); **not verified field-by-field against the Zod update schema** — see *Not checked* |
| Restaurants | Per-restaurant aggregates on the card | Deliberately absent, and UX_MAP already records the Founder decision to ship name + status first. **No gap** — listed here only so it is not re-derived as one |

---

## D. Not shown — the API returns things UX_MAP does not mention

| Endpoint | Returned but unmapped | Evidence |
|---|---|---|
| `GET /transactions/:id` | `tax` — always `"0"` today, a real field with no screen | `transaction.service.ts:21` |
| `GET /transactions/:id` | `refundedAmount` as a standalone total, separate from the `refunds[]` array | `transaction.service.ts:23` |
| `GET /transactions` | `meta: {page, limit, total, pages}` — pagination exists; **no UX_MAP screen describes paging behaviour** for any list | `transaction.service.ts:62-65` |
| `GET /dashboard` | `todayRevenueNote` as a **server-supplied string** — UX_MAP describes the caption's wording but not that the API dictates it, which is the part a frontend must not re-invent | `dashboard.service.ts:54` |
| `GET /auth/me` | The caller's full permission list per Membership — usable to drive menu visibility, which UX_MAP's navigation rules never mention as available | `jwt-auth.guard.ts:16` |
| `GET /agreements/current` | Terms version currently in force — no screen in UX_MAP | `agreements.controller.ts:39` |
| `GET /currencies` | Currency list — no screen in UX_MAP | `currency.controller.ts:10` |
| `GET /organizations`, `GET /organizations/:id`, `PATCH /organizations/:id` | Organization as an editable entity. UX_MAP mentions Organization-level "Company Information" on Profile but maps no screen to these three routes | `organization.controller.ts:18,23,28` |
| `GET /payments/:id/status` | A payment-status poll — no screen | `payment.controller.ts:80` |

---

## E. Contract versus code — the finding the task ranked highest

**Four endpoints are documented in `API_Contract.md` as existing, current, read-only routes and do not exist in the code:**

| Documented | Contract | Code |
|---|---|---|
| `GET /transactions/{id}/refunds` | `API_Contract.md:258` | **absent** |
| `GET /refunds/{id}` | `API_Contract.md:261` | **absent** |
| `GET /transactions/{id}/chargebacks` | `API_Contract.md:264` | **absent** |
| `GET /chargebacks/{id}` | `API_Contract.md:267` | **absent** |

**They are not marked future.** The section header states *"Everything here is read-only"* and describes them as the way refunds and chargebacks are read. **The data itself is reachable** — `GET /transactions/:id` embeds `refunds[]` and `chargebacks[]` (`transaction.service.ts:34,42`) — so this is four documented routes that were never built, not missing data.

**Why this ranks above the UX findings:** `API_Contract.md` is what a frontend engineer builds against. A stale screen description is discovered when the screen is designed; a documented endpoint is discovered when it 404s at integration time, after the code around it is written.

### The diff that found this was wrong three times first

**Three false findings, all in the instrument's favour, all removed after checking each against its context:**

- **`POST /tips` and `POST /wallets`** — extracted from the sentences *"There is no `POST /tips`"* (`API_Contract.md:240`) and *"there is no `POST /wallets`"* (`:273`). **The regex read a negation as a declaration.**
- **`/uploads` (three routes) and `GET`/`PATCH /settings`** — both explicitly labelled *"future"* / *"not built by Sprint 6"* (`:410`, `:392`). Real absences, correctly documented, not divergences.
- **`POST /organizations/:organizationId/restaurants`** — reported absent because the contract writes the parameter as `:organizationId` while the normaliser only collapsed `{...}` form. **The route exists** (`restaurant.controller.ts:58`).

Eleven raw hits, **four real**. Reporting the raw output would have been a page of phantom findings — the failure mode `CLAUDE.md` describes as a broken checker failing *by finding something*, which is exactly what an audit is looking for.

---

## Permissions: what UX_MAP implies versus what the guards enforce

`PermissionsGuard` reads `@RequirePermission` (class-level, overridable per method), and **19 service-level fine-checks** (`assertPermission` / `hasPermissionAtRestaurant`) narrow further, per ADR-005.

| Screen | UX_MAP audience | Enforced | Verdict |
|---|---|---|---|
| Dashboard | Owner, Manager | `reports.view` — Owner + Manager + Administrator | **matches** |
| Analytics (read) | Owner, Manager | `reports.view` | **matches** |
| Analytics (export) | not distinguished on screen | `data.export` — Owner + Manager | **matches**; UX_MAP correctly states the split must be visible in the UI |
| Employees — invite | Owner, Manager | `membership.invite` | **matches** |
| Employees — role list | Owner, Manager | `GET /roles` → `membership.invite` (`role.controller.ts:21`) | **matches**, and notable: the role catalogue is gated by the permission to invite, not by a read permission |
| Transactions | Owner, Manager | `reports.view` | **matches** for the owner side; **refuses the Waiter Portal's own Transactions screen** — see C1 |
| Restaurants list / detail | Owner, Manager | **no `@RequirePermission`** — reachability only (`restaurant.controller.ts:77,82`) | matches UX_MAP's intent; the narrowing is `isRestaurantReachable`, not a permission |
| Restaurant edit | Owner, Manager | no route-level permission; **fine-check inside the service** — `assertPermission(user, restaurant, "restaurant.edit")` (`restaurant.service.ts:122`) | **matches**, and only visible in the service — a route-decorator audit alone would call this unguarded |
| Connect Payments / onboarding link | Owner | `restaurant.create` fine-check, 404 not 403 (`restaurant.service.ts:179`) | **matches as of Closed Threat 27**; restricts to Owner **and Administrator**, since Administrator holds every Permission by design |
| Waiter Wallet / tips | Waiter | **no permission** — reachability and ownership (`wallet.controller.ts:13`, `tip.controller.ts:14`) | **matches** |

**One structural note.** Nine of the 57 routes carry no `@RequirePermission` and are narrowed only inside their service. That is ADR-005's design, not a defect — but it means **any future audit that reads decorators alone will misreport them**, which is how the #109 phantom-findings incident began.

---

## Not checked — stated rather than inferred

- **Request bodies against their Zod schemas.** This report reconciles what screens *display* against what endpoints *return*. Field-level validation of what a screen may *submit* — `create-restaurant.schema.ts`, `update-restaurant.schema.ts`, the settings and membership DTOs — **was not verified**.
- **Customer Experience screens.** Out of scope: they are Stripe's hosted terminal flow, not this API.
- **Whether every returned field is populated in practice.** Shapes were read from TypeScript interfaces and controllers; **no endpoint was called** for this report, and a field present in an interface can still be empty at runtime.
- **`GET /health`, `POST /webhooks/stripe`.** Infrastructure, no screen.
- **Frontend code.** Four screens exist in `apps/frontend`; this report did not open them, so it says nothing about which of these gaps the built screens already work around.
