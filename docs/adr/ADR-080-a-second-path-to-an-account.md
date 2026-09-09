---
title: ADR-080 — A second path to an account, and the gate that does not know about it
version: 1.0.0
status: Proposed
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-080 — A second path to an account, and the gate that does not know about it

**Status:** Proposed (Sprint 16), 2026-09-10. **Measured and shown; nothing changed and nothing
gated.** The finding is that accepting an invitation creates a `User` without consulting the
pre-pilot gate that refuses registration, and the sharper half is that closing the consent gap on
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

## Not decided

Recorded on the Founder's instruction to show rather than decide. The recommendation, offered as
one: **C**, because it is the only option under which a third path cannot repeat this, and because
the constructor objection is a smaller cost than a rule that has to be remembered per route. **B**
if the narrower refusal is preferred and the duplication is accepted.

**Trigger, and it is a date rather than an event: the day the platform terms are published.** That
is the moment registration opens, the transitive protection disappears, and the version constant
must move — all three at once, on the same afternoon.
