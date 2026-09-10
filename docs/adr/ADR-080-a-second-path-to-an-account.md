---
title: ADR-080 — A second path to an account, and the gate that does not know about it
version: 1.1.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-080 — A second path to an account, and the gate that does not know about it

**Status:** Accepted (Sprint 16), 2026-09-10 — **option C**, on the Founder decision recorded at
the end. The measurement below was written before anything was built and is kept in its original
tense; the Decision section says what was done and what the measurement turned out to constrain.

**The finding** is that accepting an invitation creates a `User` without consulting the pre-pilot
gate that refuses registration, and the sharper half is that closing the consent gap on
that path — done in the same pull request — changes what the hole would produce.

---

## The measurement

Established by reading every route and running the suite, not by inference.

**`assertPlatformTermsPublished` is called in exactly one place:** `AuthController.register`. Its
rule is narrow and deliberate — it refuses only when `NODE_ENV === "production"` **and** the current
platform-terms version is still the placeholder, so the test suite never has to bypass it (the
rubber-stamp decay `CLAUDE.md` names).

**`POST /memberships/invitations/accept` consults nothing.** It is public by design — the invitee
has no account yet, and the token in the emailed link is the credential — and it creates a `User`
whenever no account exists for that address.

| | creates a `User` | consults the gate |
|---|---|---|
| `POST /auth/register` | yes | **yes** — 503 `REGISTRATION_UNAVAILABLE` in production while the terms are unpublished |
| `POST /memberships/invitations/accept` | yes | **no** |

**ADR-055 exists because of exactly this shape.** Its own finding was that a gate written about the
registration *screen* protected nothing while the route kept accepting requests — *"a gate that
protects a screen protects nothing"*. The gate was moved onto the route. This is the same sentence
one step further out: a gate on **one** route protects nothing if a second route reaches the same
outcome.

## What the hole produces today, and what it produced before this sprint

**This is the part that changed under our feet, and it is why the finding is worth a document
rather than a line in a report.**

Before Sprint 16, an invitation accepted in production would have created a `User` with **no
acceptance record at all** — bad, and invisible.

Since Sprint 16 the same acceptance writes an `agreement_acceptance` row, because the consent gap
on that path was closed (ADR-049's trigger fired: *before the first venue onboards staff*). In
production, with the terms still unpublished, that row would name
`UNPUBLISHED-no-terms-document-exists-yet`.

**So the improvement sharpened the failure mode.** ADR-055's words for the thing it was built to
prevent are *"a real acceptance row naming a document that does not exist"* — which is now precisely
what this path would write. The change is right on its own terms and it is not a fix for this; the
two are independent, and reporting them together is the only honest way to describe the state.

## Is it reachable? The transitive answer, which is the same shape as OC-5

**Not today, and the protection is accidental rather than designed.** Accepting requires an
invitation; an invitation requires a caller holding `membership.invite`; that requires a
`Membership`, which requires an account — and in production the only route that mints the first
account is the one the gate closes. The path is shut one step earlier, exactly as **OC-5** records
for the Stripe-agreement route.

**Two things make that weaker than it sounds.** It rests on production holding no account with
`membership.invite` — a fact about data, not about code, and one this session could not verify from
here. And **the protection and the danger share a trigger**: publishing the platform terms opens
registration and simultaneously removes the reason this route was unreachable. On that day both
holes close only if the version constant moves at the same moment as the documents are published.

---

## Options

### A — Call the same gate on the accept route

One line, mirroring `AuthController.register`, with the same environment-scoped rule.

**Price:** the invitation flow becomes unusable in production while the terms are unpublished —
which is either the point or an outage, depending on whether anybody is meant to be onboarding staff
before the terms exist. It also refuses an accept from somebody who **already has an account**, where
no consent is recorded and the objection does not apply, unless the guard is placed after that
branch. **Buys:** the two paths that create a `User` answer the same way, and the rule stops
depending on which route somebody arrived through.

### B — Gate the consent write rather than the route

Refuse only the part that would be false: creating a `User` whose acceptance would name an
unpublished document. An existing user accepting is untouched, since nothing is written for them.

**Price:** a second rule expressing the same policy in different words, and two places to keep in
step. **Buys:** the narrowest possible refusal — it forbids the false record rather than the
feature, which is what ADR-055's reasoning is actually about.

### C — Move the gate to where a `User` is created

`AuthService.register` and `MembershipInvitationService.accept` both create one. A check at that
single point covers every present and future path by construction.

**Price:** the gate stops being a statement about whether a route is open — which is the reason
ADR-055 deliberately put it in the controller rather than the service, to keep `ConfigService` out
of a constructor eleven tests build by hand. That cost is real and was paid once already. **Buys:**
the class of defect disappears instead of being enumerated; no future third path can miss it.

### D — Nothing; the finding stays in this document

**Price:** the two routes keep disagreeing, and the day the terms are published is the day somebody
has to remember this. **Buys:** nothing to build, and no change to a flow that is unreachable today.

---

## Recommended, at the time of writing

Recorded on the Founder's instruction to show rather than decide. The recommendation, offered as
one: **C**, because it is the only option under which a third path cannot repeat this, and because
the constructor objection is a smaller cost than a rule that has to be remembered per route. **B**
if the narrower refusal is preferred and the duplication is accepted.

**Trigger, and it is a date rather than an event: the day the platform terms are published.** That
is the moment registration opens, the transitive protection disappears, and the version constant
must move — all three at once, on the same afternoon.

---

## Decided: option C — and the measurement that changed what C could be

**Accepted: the check binds to the act of creating a `User`, not to a list of routes.** The
Founder's reasoning, recorded because it is the general form rather than this incident's fix:
**A closes two known routes, C closes the class — a remedy chosen by the property of the defect
rather than by its instances.**

`assertPlatformTermsPublished` is gone from `AuthController.register` — **moved, not duplicated**,
because two copies of one rule is how the two drift — and now lives in `createUserAccount`, which
both paths call.

### First, the question that had to be answered before C could be called C

The Founder's condition was explicit: *if the check can only be attached to a list of routes and
not to User creation itself, it is not option C and must not be named one.* So the honest question
was whether a single point exists. **It was measured against the real database, not reasoned
about**, and the answer is more interesting than either yes or no:

| | result |
|---|---|
| Does a `$extends` interceptor on `user.create` fire for `tx.user.create` **inside** an interactive transaction? | **Yes — 2 of 2.** Both real call sites are exactly this shape, so the transaction was never the obstacle. |
| Does it fire for a **nested** write, `membership.create({ data: { user: { create } } })`? | **No — 0.** The `User` was created and the interceptor never saw it. |

**So there is no point in Prisma, and none in the schema, through which every creation passes.** A
runtime interceptor would have been a gate with a documented way around it — the shape `CLAUDE.md`
calls a record that looks like a mechanism. `$use` middleware was rejected for a second reason
besides: the shipped types mark it `@deprecated since 4.16.0`, it is removed in Prisma 6, and
"Prisma 5→7" is already in the backlog.

The alternative — making the injected client an extended one — would have touched 35 files and 37
injection sites to install a single rule, and would have fought the `PrismaService extends
PrismaClient` shape the whole codebase uses.

### What C is here, stated precisely

**One function is the only sanctioned way to create a `User`, and an invariant makes that true
rather than customary.** `repo-invariants.spec.ts` fails the build if a second way appears anywhere
in backend source — **both forms**, the direct `user.create` and the nested `user: { create }` that
the interceptor provably cannot see. No allowlist: the only exempt file is the one implementing the
rule, and `.spec.ts` files are excluded by construction because a fixture `User` is not a product
path to an account.

**The limit, said plainly rather than dressed up:** this is a claim about *this repository*, not
about the database. A `psql` session, a raw `$executeRaw`, or a migration writing rows directly is
outside it. That is a narrower promise than "every creation is gated", and it is the widest one that
is true.

### Falsified by execution, four ways

1. **Registration refuses in production while the terms are unpublished** — the rule survived being
   moved off the route it was written for. Asserted on the writes, not only the status: a refusal
   that still created the `User` or its acceptance row would be invisible from the code alone.
2. **Accepting an invitation refuses** — *this is the whole point; it did not before.*
3. **A caller that is neither route refuses** — `createUserAccount` called directly, the way a
   migration tool or admin import would. **An implementation gating only the two known routes lets
   this straight through**, which is the Founder's own test for whether C is really C.
4. **Removing the single gate line fails exactly those three tests**, and nothing else — the proof
   that all three bind to the act rather than each carrying their own copy.

And the invariant itself was falsified both ways: a probe file creating a `User` directly is caught
by name, and so is one using the nested form.

**The discriminating half is kept too:** outside production the same calls succeed. A gate that
refused everybody would satisfy every test above and be indistinguishable from a broken function —
the lesson #108 recorded when its own first falsification flipped a marker for a 500 rather than a
denial.

### One property that came free, and would have cost something under A

**Somebody who already has an account can still accept an invitation in production.** Nothing is
created for them and no acceptance is recorded, so there is no false record to prevent. Under option
A — the gate on the route — this case would have had to be special-cased, and a gate with a
special case is the shape that decays. Binding to creation makes the exception unnecessary rather
than allowed.

### What changed for the worse, named because it did

**Registration now refuses later than it used to** — after the password is hashed and the breach
check has run, rather than before any work. Same 503, same `REGISTRATION_UNAVAILABLE`, a little
wasted effort on a request that is refused anyway. ADR-055 put the check in the controller partly to
keep `ConfigService` out of a service constructor that eleven tests build by hand; that cost is now
avoided differently — `createUserAccount` reads `NODE_ENV` itself rather than being handed it,
because a gate a caller must remember to supply is a gate the third caller forgets.

**The trigger from the original document stands unchanged: the day the platform terms are
published.** Both holes close only if the version constant moves on the same afternoon the documents
go up.
