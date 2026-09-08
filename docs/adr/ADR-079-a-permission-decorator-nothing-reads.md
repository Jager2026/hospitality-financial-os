---
title: ADR-079 — A permission decorator nothing reads, and an audit that could not tell
version: 1.1.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-079 — A permission decorator nothing reads, and an audit that could not tell

**Status:** Accepted (Sprint 15), 2026-09-08; decided and built 2026-09-09 in PR #187 — see
*Decided* at the end. **As first written this document fixed nothing:** it recorded that three routes
carry a permission decorator with no guard in scope, and the more useful finding, that **two previous
permission audits asked a question that could not have told the difference.** The measurement below
is kept in the present tense it was written in, because it is the record of what was true then; the
Decision section says what changed.

---

## The measurement

Every step executed, none read off a decorator.

**`PermissionsGuard` is not global.** `app.module.ts` registers exactly two `APP_GUARD`s —
`AuditEntityResolverGuard` and `ThrottlerGuard`. So a route is covered only by a `@UseGuards(...)`
naming it, on the method or on the class.

| Where the guard is | Routes |
|---|---|
| on the method | 8 |
| on the class | 10 |
| **nowhere in scope** | **3** |
| total carrying `@RequirePermission` | 21 |

The three:

| Route | Permission claimed | Controller |
|---|---|---|
| `GET /transactions/{id}` | `reports.view` | `@UseGuards(JwtAuthGuard)` only |
| `GET /payments/{id}` | `reports.view` | `@UseGuards(JwtAuthGuard)` only |
| `GET /payments/{id}/status` | `reports.view` | `@UseGuards(JwtAuthGuard)` only |

### The instrument, checked against known answers in both directions

This class of tool has been wrong three times in this project, so it was checked before its output
was believed — and checked on cases whose answers were already known.

- **Must come back clean:** `AnalyticsController`'s ten export routes. The audit clears them, and
  the class really does carry `@UseGuards(JwtAuthGuard, PermissionsGuard)`, read directly. A parser
  that missed class-level guards would have reported ten false findings — the loud direction, and
  the one that would have made this document a list of phantoms.
- **Must come back dirty:** the three above. The audit flags them, and their classes really do
  carry `@UseGuards(JwtAuthGuard)` alone.

**And a check the parser cannot give: the running API was asked.** A Waiter (zero permissions) and
an Owner (holds `reports.view`), against a seeded venue with a real payment and transaction:

```
route                        WAITER      OWNER
GET /payments/{id}             404        200
GET /payments/{id}/status      404        200
GET /transactions/{id}         404        200
```

Both columns matter. A refusal that refuses everybody is a broken route, not a permission — the
lesson #108 recorded when its own first falsification flipped a marker for a 500 rather than a
denial. Probe rows removed afterwards; the venue, payment, transaction and both users are gone.

---

## Are they open? No — and the reason changes what the finding is

All three are closed by the service, in `assertPermittedAtRestaurant`, against
`PAYMENT_READ_PERMISSION` and `TRANSACTION_PERMISSION` — **both of which are the string
`"reports.view"`**, the same permission the inert decorator names. So the contract document is
accurate about what is required; only the *place* the requirement is enforced differs from where an
audit of decorators would look.

**What the inert decorator actually costs, stated precisely, because it is milder than it sounds
and its real risk is elsewhere.** `PermissionsGuard`'s own documentation is explicit: it is a
**coarse pre-filter, not the authorization decision** — it answers "does this caller hold the
permission on *any* Membership", and the resource-scoped decision lives in the services by design
(ADR-043).

So an inert decorator does not remove the decision. **It removes the second layer that exists to
catch a missing first one.** That layer is not decorative: `permission-scope.e2e.spec.ts` exists
because a list route once widened across Organizations, and #108 measured a zero-permission Waiter
reading another restaurant's full transaction breakdown through the very route now sitting inert.

**Sorted by what a future missing service check would expose:**

1. **`GET /transactions/{id}`** — the full financial breakdown: gross, the venue's share, tip,
   platform fee, tax, refunds, chargebacks. This is the exact payload #108 measured leaking.
2. **`GET /payments/{id}`** — amount, tip, status, processor reference.
3. **`GET /payments/{id}/status`** — status alone, and it delegates to `findOne`, so it shares the
   single point of failure rather than adding one.

All three depend on **one** service method each. Today that method checks. Nothing external says it
must keep checking.

---

## The part that matters more than the three routes

**Two audits have asked the wrong question.** #109 and the #117–#156 block closure both established
which routes "carry a permission" — and *carrying* is not *enforcing*. Their conclusions happen to
be correct here, because the services close all three. **They were right by luck**: nothing either
audit measured could distinguish a route closed in a service from one closed nowhere.

The repository's own contract invariant has the same shape: it fails when a route carrying
`@RequirePermission` is not documented in `API_Contract.md`. It keys on the decorator's
**presence**. A route can therefore be documented as permission-guarded, pass the invariant, and
have nothing read the decorator.

**This is the `@ts-check` shape exactly** (#163): a marker that claims a check it does not get. That
invariant's own words — *"it **claims** to be checked, and the claim is what makes it worse than a
plain unchecked file: it answers the question before anyone asks it."*

---

## Options

### A — Nothing; the finding stays in this document

**Price:** the next audit asks the same question and gets the same unreliable answer, and the three
routes stay one refactor away from being open with no signal. **Buys:** nothing to build.

### B — An invariant in the #163 shape: no route may claim a permission the framework will not enforce

The precedent is worth copying in full, because its three design decisions are what make it
non-decaying:

1. **Match the claim's syntactic form, not its text.** #163 matches a line whose *entire trimmed
   content* is `// @ts-check`. Here the equivalent is a decorator in a route's own decorator block —
   determined by walking the block, as the audit above does, rather than by searching the file for
   a string.
2. **No exception list.** #163 states the reason: *"There is nothing for anyone to add themselves to
   in order to go green; the only ways out are to include the file or to stop claiming."* Here the
   two exits are: wire the guard, or drop the decorator and rely on the service — a real choice,
   made deliberately, in the file.
3. **A non-vacuity assertion.** #163 fails if nothing claims `@ts-check` at all, *"the shape this
   suite has already been bitten by twice"*. Here: fail if the walk finds zero routes carrying
   `@RequirePermission`.

**The prose trap is the specific risk, and this project has now paid for it twice.** #163's first
version used `includes("@ts-check")` and flagged the very next file written — one explaining in a
docstring why it deliberately carries no such marker. In #184 the seeded-Role matcher flagged a
comment that quoted the forbidden literal while explaining the rule. Both times **a checker punished
prose for discussing the rule**, and both times the fix was the matcher, never the comment. A
decorator-block walk is immune in a way a file-wide `grep` is not — which is the argument for B over
any regex over source text.

**Price:** a parser we maintain, and Nest's scoping rules encoded in it (method, class, global). If
`APP_GUARD` registrations ever change, the parser must learn that too — a dependency worth naming.
**Buys:** the claim becomes true or it fails, and the existing contract invariant stops certifying
something it cannot see.

### C — Register `PermissionsGuard` globally, so the decorator is always read

**This one is measured out rather than argued down.** The guard's own file says why it cannot be
global: *"NestJS runs global guards (APP_GUARD) before controller/method-level ones, so a global
PermissionsGuard would run before a route-level `@UseGuards(JwtAuthGuard)` and never see
`request.user`."* Making it global requires making `JwtAuthGuard` global too, which changes every
public route (`/auth/*`, `/agreements/current`, the webhook) into something needing an explicit
opt-out — a much larger change with a much larger blast radius than the problem.

**Price:** a redesign of authentication's default. **Buys:** the class of error disappears rather
than being detected. **Not recommended now**, and recorded so it is not re-proposed as the obvious
fix.

### D — Teach the existing contract invariant to key on enforcement rather than presence

It already walks every controller and extracts routes and permissions. Adding "and is a guard in
scope?" reuses that walk instead of adding a second one.

**Price:** one invariant now asserts two different things — that a route is documented, and that its
decorator is live — so a failure needs care in its message to say which. **Buys:** the cheapest of
the mechanical options, and it closes the specific gap that made the contract document trustworthy
about a route nothing enforces.

### E — Remove the three decorators

If the service is the enforcement point, the decorator is a comment that looks like a mechanism.
**Price:** it removes the second layer entirely, and the contract invariant would then stop
requiring these routes to document a permission — losing documentation as well as a pre-filter.
**Buys:** honesty, at the cost of defence in depth. Recorded because it is the opposite of B and D
and deserves to be rejected explicitly rather than ignored.

---

## Recommended (and, at the time of writing, not acted on)

**D, then B if D proves awkward.** D reuses a walk that already exists and closes the exact gap:
the invariant that certifies these routes as documented would stop certifying a decorator nothing
reads. B is the same rule with its own walker if separating the two assertions turns out cleaner.

**Not C**, for the measured reason above. **Not E**, because the pre-filter is what catches a
missing service check, which is the failure this codebase has actually had.

**Trigger, if nothing is chosen: the next permission audit, or the next route that carries
`@RequirePermission`.** Either is a moment where the question "is this enforced?" gets asked and
answered wrongly.

---

## Decided (PR #187): D and B are one thing, and the three are fixed

**Accepted: the walk is shared, the assertions are two.** D's argument was that the contract
invariant already walks every controller; B's was that documentation and enforcement are different
claims and a failure must say which. Both hold, and they are not in tension — one
`routesClaimingPermission()` helper does the walk, and two invariants ask their own question of its
output. B's three design constraints are carried in full: the match is on a decorator's syntactic
form, there is no exception list, and a non-vacuity assertion fails if the walk finds nothing.

**And the three decorators are wired**, `@UseGuards(JwtAuthGuard, PermissionsGuard)` on
`TransactionController` and `PaymentController`. The per-method guards on the two routes that had
them were removed as duplicates of the class one: two copies of a rule is how the two drift.

### The invariant, falsified three ways

Each was executed, not reasoned about.

| Falsification | Required | Observed |
|---|---|---|
| Remove `PermissionsGuard` from one controller | fails, naming the routes | fails, naming all three with file and permission |
| Remove `@RequirePermission`, keep the guard | passes — the second honest exit | passes |
| A route with neither | passes — this is not "every route is guarded" | passes |

**The prose trap was tested where it actually bites: on the file the rule discusses.** The
controller broken in the first falsification carries, in its own docstring, the literal text
`@UseGuards(PermissionsGuard)` and `@RequirePermission("reports.view")`. A text matcher would have
read the docstring as the guard and stayed green. The walk reads only lines whose trimmed content
begins with `@`, so the invariant failed as it must.

### Re-measured live, and one column changed

Same probe as above — a real venue, a real payment, a real transaction — with the guard now wired:

```
route                          WAITER                OWNER
GET /payments/{id}             403 PERMISSION_DENIED  200
GET /payments/{id}/status      403 PERMISSION_DENIED  200
GET /transactions/{id}         403 PERMISSION_DENIED  200
```

**The Owner is unchanged at 200 on all three** — which was the specific risk worth checking: had the
guard read the permission differently from the service, the Owner would now be refused, and that
would have been a finding rather than a fix. It does not.

**The Waiter's refusal moved from 404 to 403, and that is a real change in what a refused caller is
told.** This project's own doctrine (`permission-scope.e2e.spec.ts`) says the two are not
interchangeable: a 403 concedes that the resource exists, a 404 does not. So it was measured rather
than argued:

```
GET /payments/{NONEXISTENT}     WAITER 403 PERMISSION_DENIED  OWNER 404 PAYMENT_NOT_FOUND
GET /transactions/{NONEXISTENT} WAITER 403 PERMISSION_DENIED  OWNER 404 NOT_FOUND
```

The guard runs before the service and never looks at the id, so the Waiter gets an identical 403 for
a row that exists and one that does not. **No existence oracle is created; the information available
to that caller strictly decreased.** What the 403 discloses is a fact about their own account — they
hold `reports.view` nowhere. The nonexistent-id row is now a test, so that this stays true.

**Nothing else in the repository asserted the old 404 for a permission-less caller.** The two
existing assertions that expect 404 on these routes (`payment.controller.spec.ts`, and the browser
suite's cross-Organization read) are made by an org-wide Owner and a Manager, and the seed grants
`reports.view` to both — so the coarse filter passes them and the service still answers. Checked
against `seed.ts` rather than assumed.

### A claim of mine that the measurement corrected

The first draft of the new test's comment said that removing `@RequirePermission` while keeping the
guard would make the test fail *with 200*, "because reachability alone lets this caller through".
Executed: it fails with **404**. `PaymentService` checks `reports.view` at the restaurant itself
(ADR-043) and needs no decorator to refuse. The comment now says what the run said.

It matters beyond the wording. It is the same fact as this ADR's central one, from the other side:
**these routes were never open**, so no falsification of the guard can produce a leak — only a
change in *which layer* refuses. That is exactly what the new e2e test pins, and why 403-versus-404
is the assertion rather than allowed-versus-denied.

### What is now true, and what still is not

- A route claiming a permission with no guard in scope **fails the suite**, by name, with the two
  exits stated in the failure message.
- The `@ts-check` shape (#163) has a second instance covered rather than a second occurrence.
- **Still uncovered:** a guard that is in scope but whose `canActivate` is wrong or whose module
  cannot resolve it. The invariant reads scope, not behaviour — the e2e test is what covers that,
  for these three routes only.
- **Still true, and named in option B's price:** the helper encodes Nest's scoping rules (method,
  class, global). If `app.module.ts` ever registers a guard globally, the helper must learn it.
