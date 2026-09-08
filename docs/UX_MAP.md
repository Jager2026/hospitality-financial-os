---
title: UX_MAP
version: 2.12.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
supersedes: UX_MAP v1.0 — see ARCHITECTURE_DECISIONS.md for the reasoning behind every change below
---

Purpose:
Define every screen, navigation path and interaction inside the Hospitality Operating System.

This document is the foundation for:
- UX_BIBLE.md
- DESIGN_SYSTEM.md
- API.md
- DATABASE.md
- COMPONENT_LIBRARY.md

(`API.md` and `DATABASE.md` now exist and are current — see `API_Contract.md` and `DATABASE.md`. `DESIGN_SYSTEM.md` now exists in full: Part 1 — the emotional contract, the Hierarchy Law, the caption rule, the zero-state requirement — and Part 2, the visual layer: surfaces, palette with measured contrast, type, spacing, density. `UX_BIBLE.md` and `COMPONENT_LIBRARY.md` remain outstanding, unchanged from v1.0.)

No interface should be implemented before it exists inside this document.

---

# UX MAP

> "A product is not a collection of screens. It is a collection of journeys."

---

# Product Structure

Version 1 consists of only two applications.

**Application A — Restaurant Portal**
Used by:
• Restaurant Owner
• Restaurant Manager

**Application B — Waiter Portal**
Used by:
• Waiters

**Customer**
The customer never installs an application. The customer interacts only with the payment terminal. This keeps customer friction as close to zero as possible.

---

# User Roles

Owner
↓
Manager
↓
Waiter
↓
Customer

Each role has completely different objectives. Therefore each role receives a completely different interface.

One person may now hold more than one role across more than one restaurant (ADR-005) — an Owner overseeing a whole chain, or a Waiter working shifts at two locations on the platform. This diagram still describes each role's interface; a person simply steps into more than one of these roles depending on which restaurant they're currently working with.

---

# Navigation Philosophy

Navigation should never exceed three levels.

Maximum depth: Dashboard → Feature → Details. Never more.

If navigation becomes deeper than three levels, the UX should be redesigned.

---

# APPLICATION A — Restaurant Portal

**Main Navigation**
Dashboard · Restaurants · Employees · Transactions · Analytics · Settings · Profile

*A note on naming, throughout this application:* "Employees" is what the product calls people — that never changes. The database's technical name for this relationship is `Membership` (ADR-005); no user-facing screen in this document uses that word.

---

# Getting In — the screens before the Main Navigation exists

Everything below the Main Navigation assumes a signed-in person who already has a Restaurant. This section describes how they get there. **It was missing entirely until Sprint 13's frontend review** — every screen in this document was written from the perspective of an established account, so the first thing a new owner actually sees had no description at all. The backend supported this flow the whole time; only the screens were unwritten.

The sequence is linear and one-directional. Nobody arrives at the Dashboard by any other route.

```
Register  →  Log In  →  Create Your Restaurant  →  Connect Payments (Stripe)  →  Dashboard
                                                          ↑                        │
                                                          └── can be postponed ─────┘
```

## Register

**Purpose:** turn a stranger into an account. Nothing else.

**Fields:** Email · Password · Your Name

"Your Name" is required, not optional (ADR-033) — it is what colleagues see when selecting who served a table, so an account without one is unusable to everyone but its owner.

**The agreement block (ADR-049), added in Sprint 14.** The screen collects one thing beyond the fields, and the shape of it follows from the lawful basis rather than from taste:

- **Terms of Service — an unticked checkbox.** Never pre-ticked, and never "by continuing you agree". The record this writes claims *this person accepted revision X at time T*, and that is only honest if they did something about the terms rather than about creating an account.
- **Privacy Policy — a link and a one-line notice, and deliberately no checkbox.** Our basis for processing is the **contract** with the person, not consent (ADR-049). A checkbox there would tell them they hold a withdrawal right they do not hold. The notice says so in plain words, so the absence reads as deliberate rather than forgotten.
- **Both links are separate from the checkbox label**, not inside it — a link inside a label toggles the checkbox when clicked, which is the standard way people fail to read the thing they are agreeing to.
- The version accepted is **fetched from the API**, not compiled into the screen, and submitted back. If it cannot be fetched, registration is refused with an explanation: no version means no honest record.

**Rejections that need real wording, not a generic error:**
- The password appears in a known public breach corpus (ADR-032). This is the one rejection users find insulting if worded badly: it is not a complexity rule and must not read like one. Say that this exact password is known to have leaked elsewhere and must be changed — not that it is "weak." Sprint 14 adds a third line for the reason people actually misread it: they think we are telling them *their account* was breached. It says the finding is about the password itself, seen in lists collected from other services. The mechanism (a k-anonymity lookup against HaveIBeenPwned) is never named on screen — it is an implementation detail, and naming it invites the same misreading in a new form.
- The email is already registered. **Worded vaguely on purpose**, and this is the one place the screen deliberately says less than it knows: confirming that an address has an account turns the form into an account-enumeration tool. The API already answers this case and a stale terms version with two *different* codes so the screen can tell them apart without either message being specific about the email.
- The terms changed while the page was open (409). Tell the person to reload and read them again — never resubmit silently under the new version.

**What does NOT happen here:** no Restaurant is created, no Organization exists yet, and the person has zero Memberships. That is a valid state (`DATABASE.md`, User Rules), and the next screen is what resolves it.

**Primary action:** Create account → straight into the signed-in state, no email confirmation step (none exists).

## Log In

**Purpose:** return an existing person to wherever they belong.

**Fields:** Email · Password

Rate-limited to 10 attempts per minute (ADR-028); the screen must say so plainly when it triggers, rather than showing a generic failure that reads like a wrong password.

**Where it lands** — this is the fork already described under Restaurants below, and it is decided by what Memberships the person holds, not by a setting:
- **No Memberships at all** → Create Your Restaurant (below). This is where a just-registered owner goes.
- **One org-wide Membership** → Restaurants (the list)
- **One restaurant-scoped Membership** → that Restaurant's Dashboard
- **More than one restaurant-scoped Membership, and no org-wide one** → Restaurants (the list). Added in Sprint 14; this branch was missing, and it is not hypothetical — ADR-006 explicitly supports a waiter or manager working shifts at two restaurants on the platform. Sending them to a single Dashboard would mean **the product silently choosing one of their employers for them**, on the screen where they have least context to notice. They choose.

*A note on the whole fork, because every screen in the Portal is reached from wherever it sends someone:* it lives in one pure function (`destinationAfterLogin`) rather than inside the login form, and is proved twice — by unit tests at every branch, and through a real browser end-to-end. A wrong branch here is not a login bug; it is every screen wrong at once.

**Identity on this screen (`DESIGN_SYSTEM.md`, Product Identity On Screen).** Log In carries the wordmark as its rank-1 element, and it replaces a separate "Log in" heading rather than sitting above one. This is the only screen a person sees before they know where they are — and a credential form with no identifying marks is the standard appearance of a phishing capture page, so the name is a security decision as much as a brand one. The screen's sparseness stays: one screen, one task. A missing name was never sparseness, it was a missing element.

## Create Your Restaurant

**Purpose:** the first real object. Also, invisibly, the moment an Organization comes into existence.

**Fields:** Restaurant Name · Legal Name · Company Number · VAT Number · Email · Phone · Country · Currency · Timezone · Address · Customer-facing language

**What the screen must not do:** mention "Organization." One is created automatically and the owner receives an org-wide Membership immediately (ADR-005), which is what makes adding a second location later frictionless — but a single-location owner should never learn this concept exists.

Country and Currency are **permanent**. They are fixed at Stripe account creation and cannot be changed afterwards (`DATABASE.md`, Restaurant Rules); changing either later means a new Restaurant, not an edit. The screen must say this at the point of choosing, not in a confirmation afterwards.

**On success:** a real Stripe connected account now exists, and the next screen appears immediately.

**Built in Sprint 15**, at `/onboarding/restaurant`, replacing the stub that existed only to give the login fork a destination. Four things about it are decisions rather than layout.

**Where success goes: Connect Payments, never the Dashboard.** The venue exists and cannot take a card, so a Dashboard would open on a banner saying so. Verified by hand against live Stripe, because the browser harness cannot reach the success path at all (its Stripe key is a placeholder, by design): the real path lands on `/restaurants/{id}/onboarding`.

**Which endpoint, which is the same question as which permission.** `POST /restaurants` carries **no** Permission, deliberately — a just-registered person holds zero Memberships, so there is nothing to check against, and it creates a new Organization with the caller as its org-wide Owner. `POST /organizations/{id}/restaurants` requires `restaurant.create` **in that Organization**. So the screen sends an org-wide Member through the scoped route, where the server checks them, and everybody else through the bootstrap route. **A Manager or Waiter therefore cannot add a venue to their employer** (403, asserted against the live API), while anyone may start a business of their own — which is the API's design, not an oversight.

**Two org-wide Memberships stop the screen rather than prompting a guess.** There is no organization picker anywhere in the Portal, and writing a Restaurant into the wrong business is not an edit anyone can undo. The screen says so and does nothing.

**The second agreement is collected here (ADR-049), and until Sprint 15 it was not collected anywhere.** The table has carried a `restaurant_id` subject, a `stripe_connected_account` type and a CHECK constraint enforcing that pairing since Sprint 14; the constant existed with a comment saying it is *"accepted when its Stripe connected account is created"*; and **no row had ever been written**, because the DTO had no field to carry one. A schema built for a record nobody makes is worse than no schema — it reads as though the record exists.

The shape is the one registration settled: **an unticked checkbox**, never pre-ticked; the version **fetched** from `GET /agreements/current` rather than compiled into the build, and submitted back; the server comparing it against its own constant and refusing a mismatch with 409 rather than silently correcting it. The acceptance is written **in the same transaction as the Restaurant** — a venue with a Stripe account and no record of agreeing to the agreement that account is governed by is the exact gap ADR-049 exists to close — and the refusal happens **before** the Stripe call, so a rejected request never costs a connected account nobody can reach.

**The gate question, shown rather than decided.** `CURRENT_STRIPE_AGREEMENT_VERSION` is the same placeholder string as the platform terms: `UNPUBLISHED-no-terms-document-exists-yet`. By ADR-055's own reasoning an acceptance naming a document that does not exist is **a false record, not a missing one** — so on the face of it this route deserves the same production refusal registration has. Two facts complicate that, and both are established rather than assumed:

- **The path is already closed transitively.** `assertPlatformTermsPublished` is called on `POST /auth/register` only, but nobody can create a restaurant without an account, and nobody can get an account in production while that gate stands. A false Stripe-agreement row is therefore unreachable today.
- **Stripe collects its own attestation regardless.** Two of the 18 requirements on a fresh account are `identity.attestations.terms_of_service.account.date` and `.ip` — Stripe's hosted onboarding records the account holder's acceptance itself, with a date and an IP. Our row is the record of what **we** showed them, which is what ADR-049 asks for; it is not the only record that the agreement was accepted.

So the options are: extend the existing gate to this route (a second call, and a message that currently says *"Registration is not open yet"* — wrong words for this route); write a sibling gate with its own wording; or rely on the transitive closure and record that reliance. **Not decided here.** What settles it is a decision about publishing the documents, which is what both constants are waiting on.

**A failure whose outcome is unknown offers a check, never a second attempt.** `POST /restaurants` creates the Stripe account **before** it opens its transaction, so a failure inside that transaction leaves an account with no row pointing at it — measured on 2026-09-07 by forcing the transaction to throw: HTTP 500, zero rows, and one orphaned account that took a hand-written API call to close. The API's own message on that 500 is *"please try again"*, and trying again mints a second account. So the screen distinguishes a refusal it can read (400/403/404 — nothing was created, retry is safe) from a 5xx or a lost connection (**may have succeeded**), and in the second case removes the submit button entirely, offering only to ask `GET /restaurants` what exists.

### The field count is a real cost, and the split is not decided here

Ten required fields is a lot for a new customer's first screen. **Facts before options:** `POST /restaurants` requires all ten, and Stripe's account creation uses exactly **three** of them — `email`, `name`, `country` (`stripe.service.ts`). The other seven are ours: they exist for invoicing and the company record, not for Stripe.

| Option | Price |
|---|---|
| **All ten now** (what is built) | The heaviest first screen in the product, at the moment a new owner is least committed. In exchange the venue is complete the moment it exists, and no later screen has to chase a half-filled record. |
| **Three now, seven later** | A far lighter start — but it needs a backend change (the DTO requires all ten), and it moves the missing fields into a state nothing currently models: a Restaurant that exists and cannot be invoiced. **The price the Founder named is real and specific:** Stripe's own onboarding asks for the company registration number and VAT details anyway, so deferring them here does not defer them for the owner — it splits one form into two, in two different places, one of them ours and one of them Stripe's. |

Not decided. What would settle it is evidence rather than argument: the first real owner filling this in, and whether they stop.

## Connect Payments

**Purpose:** get the Restaurant from "exists" to "can take money." A screen in its own right, not only the Dashboard banner (ADR-009).

Stripe hosts the actual identity and bank-account collection; this screen's whole job is to explain what is about to happen, hand the person off, and receive them back. It shows the current state and one action.

**States, all four of which are real and must be designed:**

| State | What the screen shows |
|---|---|
| Not started | What Stripe will ask for and why, one button: "Continue to Stripe" |
| Returned, still incomplete | Which specific requirements are outstanding, one button to resume |
| Under review | Nothing is required from the owner; say that plainly and stop asking for action |
| Active | Confirmation, then straight on to the Dashboard |

**Postponing is allowed and must be visible.** "I'll do this later" leads to the Dashboard. This is the state ADR-009 requires be handled explicitly rather than treated as an error — a Restaurant that exists but cannot yet accept cards is normal for hours or days, not a failure.

**Built in Sprint 15** at `/restaurants/{id}/onboarding`, and the four states above map exactly onto our own derived `onboardingStatus` — which is why this screen reads that field while the Dashboard banner reads the two Stripe capabilities. They answer different questions: the banner asks *can this venue take money right now*, this screen asks *where is this venue in setup*, and only the derived value separates "Stripe is waiting on the owner" (`IN_PROGRESS`) from "Stripe is reviewing" (`RESTRICTED`). Telling somebody to go and finish a form when nothing is asked of them is the worse of the two errors.

**The link is requested on a click, never on load, and that is a correctness rule rather than a preference.** A Stripe Account Link is single-use and lives about five minutes — measured against a real account (#125), not read in documentation — and mail clients that follow links to scan them burn one with nobody intending it. So "the owner has a link" and "the link still works" are different facts. Minting one per screen load would spend a budget of ten per hour on links nobody uses.

**Three refusals the screen must be able to say out loud**, because each one otherwise reads as the product being broken:

| What happened | What the screen does |
|---|---|
| Ten links already requested this hour (the route's throttle, #125) | Explains the limit and that it is a wait. The state stays readable; a rate limit is a pause, not a dead end. |
| The caller does not hold `restaurant.create` — Owner and Administrator do, Manager and Waiter do not | The action is not offered at all, and the screen says setting up payments is the owner's to do. **The browser check is presentation only**; `restaurant.service.ts` refuses the request whatever the screen showed. |
| Stripe cannot be reached, or the venue has no Stripe account yet | Says the link could not be created and that nothing about the restaurant has changed. |

**Stripe's own two return addresses are screens now.** `${FRONTEND_URL}/restaurants/{id}/onboarding/complete` and `.../onboarding/refresh` are built by the backend and handed to Stripe; neither existed in the Portal, so **finishing onboarding used to end on a 404**. `complete` re-reads the venue rather than trusting the arrival — coming back is not the same as being verified — and `refresh` is Stripe's way of saying the link is no longer usable, so it says the link expired and offers a fresh one instead of silently rendering the same page.

**"Which specific requirements are outstanding" is NOT built, and the reason changed on 2026-09-08 while the decision did not.** As written in Sprint 15 the reason was absence: `requirementsDue` held nothing anywhere — of 349 restaurants, four carried a value and all four were `[]`, written by specs with a faked Stripe — so rendering a named requirement would have meant rendering a shape the product had never received.

**That is no longer true, and it was measured rather than assumed.** Creating a venue through the real Create Restaurant screen against live Stripe produced an account carrying **18 requirement entries**. The shape is exactly what ADR-009's revision recorded, and the decisive detail is inside it:

```
description:      "configuration.merchant.mcc"        ← an API field path, not prose
impact:           { restricts_capabilities: [ { capability, configuration, deadline } ] }
minimum_deadline: { status: "past_due" }
requested_reasons:[ { code: "routine_onboarding" } ]
```

**`description` is Stripe's own field name, not something a restaurant owner can act on.** Turning eighteen of those into instructions needs a mapping from Stripe's field paths to human words that we do not have — and that Stripe's hosted onboarding already performs, which is where the person is being sent anyway. So the screen still lists what Stripe asks of every business (identity, business details, bank account), now because naming the eighteen would require inventing translations rather than because the data was missing.

### `NOT_STARTED` is unreachable, and "not started" cannot be told from "abandoned"

Established by measurement on 2026-09-08, and it changes what the four states mean.

**Where the status comes from.** `deriveOnboardingStatus` returns `NOT_STARTED` **only when both capability statuses are null**. But `POST /restaurants` requests `card_payments` at account creation, so Stripe reports `restricted` immediately and attaches its requirements — a fresh account measured through the real path came back with **18 entries** and `card_payments: restricted`. Requirements > 0 means `IN_PROGRESS`.

**So no venue created by this product is ever `NOT_STARTED`.** That value survives only on rows whose status was never refreshed — a Restaurant with no `stripeAccountId`, which today means a fixture. The state the product's own screens were written around does not occur in production, and the state a real new venue lands in is the one whose copy assumed prior work.

**Is "created, nothing started" distinguishable from "started and abandoned"? No — and the missing signal is ours, not Stripe's.** A newly created account carries nothing that separates them:

| Signal on a fresh account | Value |
|---|---|
| `requested_reasons[].code` | `routine_onboarding` — on all 18 |
| `awaiting_action_from` | `"user"` — on all 18 |
| `identity` | `null` |
| top-level fields | no onboarding-state field of any kind |

Whether those values change once somebody starts and abandons Stripe's flow is **unmeasured** — it would take an account left half-finished, which one session cannot produce.

**What distinguishes them is a fact we had and discarded — now recorded.** `Restaurant.onboardingLinkFirstRequestedAt` (Sprint 15) is written when `POST /restaurants/{id}/onboarding-link` first succeeds, and the screen reads **that**, not `onboardingStatus`, to choose between starting and continuing:

| State | Screen |
|---|---|
| no link ever minted | **Set up card payments** — what Stripe will ask, and why |
| a link was minted before | **Continue setting up card payments** |
| `COMPLETE` | nothing |

**A timestamp, not a counter.** A count answers "how often", which ADR-028's 10-per-hour throttle already bounds, and it would climb with every link burned by a mail client scanning it (#125) — measuring scanning as much as intent. It is written **after** Stripe returns a link, never before: recording a refused attempt would tell somebody to continue something they were never handed. And it is written with `UPDATE … WHERE first_requested_at IS NULL`, so two simultaneous requests cannot move it — *first*, decided by the database rather than by ordering.

**The limit of what it knows, kept in the wording.** It records that a link was handed over — not that it was opened, not that Stripe's form was reached, not that anything was typed. So the copy says *"you've been sent to Stripe for this restaurant before"* and stops there; "where you left off" stays out of the product, because we do not know that. **"Asked for a link" and "started onboarding" are different questions, and only the first is closed.**

**Still unmeasured, and it is the reason the second question stays open:** whether Stripe's own signals change once somebody starts and abandons the flow. That needs a half-finished account, which cannot be produced to order.

**The copy was corrected**, because one wording is true in both cases and the old one was false in the case that actually occurs: *"Card payments need a few more details — Stripe needs some details about this business before it can take cards"* replaces *"Finish setting up… continuing takes you back to where you left off"*. That is the only change made here; the distinction itself stays open.

## Restaurant created, payments not yet live

Not a screen — a **condition** the Dashboard carries, and the reason the previous screen may be skipped. Recorded here because it is the state a new owner spends the most time in, and the only one where the product is visibly incomplete through no fault of theirs.

While `cardPaymentsStatus` or `payoutsStatus` is anything other than `active`:
- The Dashboard leads with the banner described below, and every figure on it is legitimately zero. **Zeroes here must read as "nothing has happened yet," never as "something is broken"** — this is the single most likely moment for a new owner to conclude the product does not work.
- Inviting staff, configuring tips and editing settings all work normally. Only taking payment does not.
- The banner and the Quick Action are the route back to Connect Payments, which keeps its four states above.

---

## Dashboard

**Purpose:** Provide immediate understanding of restaurant performance.

Questions answered: How much revenue today? How many transactions? How many tips? Average tip percentage? How are employees performing? Recent activity?

If these questions cannot be answered within five seconds, the dashboard has failed.

**New (ADR-009):** if this Restaurant's Stripe onboarding isn't complete — `cardPaymentsStatus` or `payoutsStatus` is not `active` — the Dashboard leads with a single, unmissable banner instead of competing with the sections below: "Finish payment setup to start accepting cards," naming the specific outstanding requirement, with one button to resolve it. Everything else on this screen is secondary until that banner is gone.

**Built in Sprint 15, and the specification above was already right — the code had drifted from it.** The line "`cardPaymentsStatus` **or** `payoutsStatus` is not `active`" says to read both; the shipped condition read one, `payoutsStatus != null && payoutsStatus !== "active"`. For a venue whose Stripe onboarding was never started both capabilities are `null`, so the second half of that condition was false and **the venue least able to take money was the only one the Dashboard said nothing about** — while the Restaurants list, built later against the same data, said it plainly. Found by fixing the local demo fixture (#177), not by reading the code.

**Three states, three messages, and the order of the two questions is the meaning.** Cards first, because a venue that cannot charge has nothing to be paid out:

| State | What the screen says |
|---|---|
| `cardPaymentsStatus` not `active` | **Card payments are not switched on here yet** — Stripe has not finished verifying this restaurant, so no card can be taken at this venue, tips included. Completing the payment setup is what changes it. |
| cards live, `payoutsStatus` not `active` | **Payouts are not switched on yet** — cards can be taken and the money is **held at Stripe rather than lost**; it reaches the bank once Stripe finishes verifying the payout details. |
| both `active` | Nothing. Silence is the correct output, and the only one. |

**A fourth case exists and is deliberately silent: we do not know.** ADR-063 makes the Stripe status a second request, so it can fail on its own. A banner announcing that cards do not work, caused by our own failed call, would be a fabrication the reader could not tell from the real thing — so a missing answer renders nothing (`stripe-state.ts` keeps "unknown" distinguishable from "live" for anyone reading a test).

**Words, not colour** (ADR-072), and an explanation rather than a warning: a venue mid-onboarding is not in an incident, and a venue whose payouts are held has not lost anything. **What is NOT built is the button** this section promises — Connect Payments is its own screen and does not exist yet, so each message names the action in words instead of linking to a route that would 404. Naming the *specific outstanding requirement* also waits on that screen: `requirementsDue` is stored, and no screen reads it.

**Dashboard Sections:** Today's Revenue · Today's Tips · Today's Transactions · Average Bill · Average Tip · Revenue Chart · Recent Payments · Top Staff · Quick Actions

**Quick Actions:** Invite Employee · Configure Tips · View Reports · Restaurant Settings · Export Data · **Complete Payment Setup** (appears only while Stripe onboarding is incomplete)

**Section definitions — settled in Sprint 13's frontend review, because several of these were words without an agreed meaning and would have been guessed differently by whoever built them first:**

- **Today's Revenue** carries a fixed caption, **"Before platform fee deduction"** (ADR-026). Not decoration: this figure is deliberately *not* the same quantity as Transaction Details' Net Amount, which nets the platform fee out. Two screens showing two different correct numbers for the word "revenue" is exactly the situation where the difference has to be visible on screen rather than only in documentation. The caption is a fixed string the API returns, so every screen renders the identical wording rather than inventing its own.
- **Today's Transactions** is a **count**, not a list. The list is the Transactions screen; repeating it here would duplicate a whole screen inside a summary tile.
- **Average Bill** = Today's Revenue ÷ today's transaction count. Same ratio-of-sums reasoning as Average Tip (ADR-026 Decision 4) — dividing the totals, never averaging each transaction's own figure, so a €2 coffee does not weigh the same as a €200 dinner. **`null`, never `0`, when there are no transactions**: "no data yet" and "an average of zero" are different statements and the screen must not conflate them.
- **Average Tip** is a percentage, expressed in basis points by the API. **`null`, never `0`, when today's revenue is zero** — same reasoning (ADR-026).
- **Revenue Chart** — the last 7 local calendar days including today, oldest first, using the identical Today's Revenue definition for each day.
- **Recent Payments** — the 10 most recent transactions **all-time, not only today** (ADR-026). Deliberate: on a quiet morning a "today only" version of this block is empty, and an empty block answers nothing. This is the one place on the Dashboard that is not today-scoped, and it should not be captioned as if it were.
- **Top Staff** — up to 5, ranked by today's net tips. **Named "Staff", not "Waiters"** (ADR-033): the criterion is who actually served the table, which can be a Manager or the Owner, not who holds a Waiter role. Shows the person's **display name**, with email available as the unambiguous identifier — two staff members can share a name.

**Removed: "Alerts."** It was a word with no agreed meaning, and everything that might have filled it now has a real home elsewhere: operational failures (stuck Outbox events, stuck payments, a rejected Stripe credential) go to the team's own alerting channel (ADR-031/032/038) because they are ours to fix and not the owner's, and outstanding Stripe requirements are already the banner above. A section that would only ever be empty or duplicate the banner should not exist.

**Day boundaries are the Restaurant's own timezone, not the viewer's and not UTC** (ADR-026). A refund posted today against an older sale reduces *today's* figures, which is correct and can make a number negative — the screen must render that rather than clamping it to zero.

---

## Restaurants

**Purpose:** Manage restaurant locations. Visible only for multi-location businesses. Single-location businesses skip this screen completely.

**Restaurant Card contains:** Restaurant Name · Status

**Deliberately reduced (Sprint 13 frontend review).** This card previously promised Today's Revenue, Today's Tips, Employee Count and Last Activity. None of those exists as a per-restaurant figure the list can fetch: the only source is the single-restaurant Dashboard call, so a chain of ten locations would mean ten of them — each one also computing a 7-day chart and a staff ranking the list has no use for. **Founder decision: ship the list with name and status first and find out whether the aggregates are actually missed.** If they are, the answer is one purpose-built summary endpoint, not ten Dashboard calls — but that endpoint should be designed against a real complaint rather than a guess about one.

**What changed (ADR-005):** this screen is the view onto an Organization's Restaurants. Nothing about the card, or the "single-location businesses skip this completely" rule, changes — a business with one Restaurant still never sees this screen, exactly as before. What's new: an org-wide Owner (a Membership with no specific restaurant attached) lands here first after login, instead of a single Dashboard, since their role spans every location. A restaurant-scoped Manager still goes straight to that one Restaurant's Dashboard. "Add Restaurant" becomes a primary action here — adding a second location to the same Organization, not starting over.

**Built in Sprint 15, and the row is Name · Address · a payments state.** What the row shows was settled by fact rather than preference: `GET /restaurants` was called against a running backend, and it already carries `name`, `address`, `status`, `onboardingStatus`, `cardPaymentsStatus` and `payoutsStatus`. So the payments state costs **nothing** — no second call, no call per row. The two candidates that are *not* in that response are an open shift and its revenue, and each would cost a `GET /dashboard` per restaurant: exactly the ten-calls-for-ten-locations shape the Sprint 13 reduction above already refused, arriving by a different door.

**Why a payments state rather than the bare `Status` this card originally named.** The question an owner is actually asking on this screen is *which of these can take money right now* — and a venue that cannot is the one fact they would otherwise discover one click later, inside the Dashboard, as a banner. So the row says it in words: **Closed** when the venue is not `ACTIVE`, **Card setup not started** or **Cannot take cards yet** when it cannot take a card, and nothing at all when it can. A word, not a colour (ADR-072 — the accent carries no meaning): an owner whose second venue is mid-onboarding is not in an incident.

**The state is our cached view of Stripe, deliberately.** Only `GET /restaurants/{id}` re-reads Stripe (`refreshStripeStatus`); the list reads what was last stored. Same reasoning as ADR-063 — a navigation screen must not hang or fail because Stripe is slow.

**City is not a field.** `Restaurant` has a single free-text `address` (`DATABASE.md`); there is no `city` column to show, and adding one is a schema change rather than a list-screen decision. The row shows the address line that exists.

**No money is rendered here.** Nothing on this screen formats an amount, so `formatMoney` / `venueMoneyLocale` (`lib/money.ts`) remain the *single* place that does — the one fixed in Sprint 15 after a Lithuanian venue was shown American-shaped money. If a revenue column is ever added, it calls that; it does not grow a second formatter.

**No restaurants at all leads somewhere.** A brand-new owner sees an invitation to create their first restaurant, linking to `/onboarding/restaurant` — never an empty list, which would be the worst possible first screen of the product: nothing to read, nothing to do, and no evidence that signing up worked. In practice this state is a safety net rather than the main path, because the login fork already sends a User with zero Memberships straight to `/onboarding/restaurant`; the empty list is what a person reaches by navigating here deliberately.

**The "single-location businesses skip this screen completely" rule above is not what happens for an org-wide Owner, and that divergence is open rather than resolved.** `destinationAfterLogin` sends *every* org-wide Membership here regardless of how many Restaurants the Organization holds, so an owner of one venue signs in and reads a list of one. A restaurant-scoped Membership does skip it, exactly as documented. Both answers have a real price and neither was chosen while building the list — they are recorded, with their costs, in `IMPLEMENTATION_PLAN.md` under "Deferred, Not Yet Scheduled".

**Restaurant Details:** Overview · Employees · Transactions · Analytics · Settings

---

## Employees

**Purpose:** Manage restaurant staff.

**Screen Sections:** Employee List · Invite Employee · Deactivate Employee · Employee Details · Permissions · Search · Filters

**What changed (ADR-005):** Invite Employee gains one new choice — **This Location Only** or **All Locations** — whether the invitation grants access to just this Restaurant or every Restaurant in the Organization. Single-location businesses never see this choice; it only appears once a second location exists, keeping the common case exactly as simple as before.

**What changed (ADR-044, Sprint 14) — the Role picker now has a data source, and it was unbuildable before.** `POST /memberships` has required a `roleId` since Sprint 4 and nothing returned one; `GET /roles` is that list.

**Each option shows its name and its description, and the description is not optional decoration.** "Manager" in a dropdown, with nothing saying how it differs from "Administrator", asks an owner to guess at a permission grant — on the one screen where guessing wrong hands someone else control of the business. The descriptions are real seeded data (`prisma/seed.ts`), not text invented for the screen.

**The list is shorter than the set of Roles that exist, and the screen must not explain why.** `Administrator` is ours — platform-level, every Permission — and a Restaurant may never grant it. It is absent, silently: naming a Role the owner cannot choose would only prompt the question of how to get it. Refused elsewhere as *"Role not found"* for the same reason (ADR-044).

**Employee Details:** Profile · Position · Wallet · Tip History · Performance · Activity · Permissions · Status

**What changed (ADR-006):** Wallet, here, reflects only this Restaurant's earnings for this person. If the same person also works at another Restaurant on the platform, that is a second, separate Wallet, visible in their own Waiter Portal — never merged into this view, since two employers' money should never appear as one balance (see Waiter Portal Wallet, below).

**Reachable as of ADR-039.** This section had been listed since v1.0 and was, until now, unbuildable: the rule permitting a Manager or Owner to view it has existed since ADR-024, but no route led to it — a permission with nothing addressable behind it, unnoticed for six sprints because no screen existed to try. It is now reached through the Membership this screen is already showing.

**Pending Balance reads zero here too**, for the same reason as in the Waiter Portal — nothing is withdrawable yet (ADR-024). Present it as inactive rather than as a real zero, or an owner will read it as money already paid out.

---

## Transactions

**Purpose:** Complete financial visibility.

**Transaction Card:** Amount · Tip · Staff Member · Time · Status

**Transaction Details:** Restaurant · Staff Member · Gross Amount · Net Amount · Tips · Processing Fee · Reference ID · Audit Events

**Three fields removed here, for two different reasons (Sprint 13 frontend review):**

- **"Customer" is gone.** The product has no customer identity by design — no account, no registration, no profile (`MASTERPLAN.md`, Registration Philosophy). The field could only ever have been blank, and listing it invited someone to go and build the concept in order to fill it.
- **"Receipt" is gone from this screen**, and the word needs care wherever it survives. It appeared here and in the customer Payment Flow meaning two different things, and neither exists: there is no receipt entity in the API or the schema. The customer flow's own "Receipt" step is Stripe's, shown on the terminal at the moment of payment — not something this portal can retrieve later.
- **"Payment Method" is gone from the card.** It is server-set to `"card"` on every row today and never varies, so a column that always reads the same word is noise. It comes back when a second method does.

**"Staff Member," not "Waiter"** (ADR-033) — the person recorded is whoever was selected as having served the table, which may be a Manager or the Owner. **This field is a known backend gap, not a design decision:** the payment records who was selected, but the transaction endpoints do not yet return it — today it exists only as a filter input. The screen is right and the API needs to catch up; scheduled ahead of the other gaps because a transaction list without the person attached answers almost nothing for an owner.

**"Timeline" removed, "Audit Events" kept.** They were two names for one idea, and only one of them is buildable: every mutating action is already recorded (ADR-010), including who did it. Reading that back has no endpoint yet — a real gap, and a scheduled one, since an audit log nobody can read is the expensive half of an audit log.

**New (ADR-008):** a Refund / Chargeback status, shown only when one exists on this Transaction — status, amount, and whether the tip was refunded. No action is available here for MVP; refunds are initiated through Stripe, not this screen (see `API_Contract.md`). This exists so an owner is never left wondering why a number changed. Every figure here — Net Amount, Tips, Processing Fee — reflects the current state after any Refund/Chargeback activity, not a snapshot frozen at the moment of capture, which is exactly why this exists: "why did this number change" always has an answer on this screen.

**Processing Fee is unavailable in MVP (Sprint 8) — shown as "—", never a false `0`:** distinct from `Tax` (also unavailable, but only because no code writes it yet). Fact-checked against ADR-014's own Direct Charge + `fees_collector: "stripe"` configuration: Stripe deducts its own processing fee directly from the Restaurant's connected-account balance, a fact our `payment_intent.succeeded` webhook never observes — the real figure exists only via a separate Stripe `balance_transaction` API call (with the `Stripe-Account` header), which is out of this Sprint's scope ("breakdown computed from `LedgerLine`," `IMPLEMENTATION_PLAN.md`). `MASTERPLAN.md` names Processing Fee and Platform Fee as two distinct concepts — this screen keeps them as two distinct fields rather than collapsing the unavailable one into the one we do have, even though Platform Fee is real and shown correctly today.

### Built in Sprint 15 — and two of this section's promises could not be kept

The screen exists at `/restaurants/{id}/transactions`, with the card at `.../transactions/{id}`. It is reached from **under the Dashboard's figures**, deliberately rather than from a navigation entry: nobody opens a transaction list for its own sake, they open it because a figure did not match what they expected.

**What the row shows: time · amount · tip · status.** Four fields, because four is what `GET /transactions` returns for a row. The time is rendered in the **venue's own timezone**, not the reader's — a payment at 01:30 belongs to the venue's night (ADR-064), and an owner checking from another country must see the time their staff would name.

**Why there is a card at all.** The row answers *which payment*; the card answers *where the money went* — the split into the venue's share, the tip, our fee, tax, and any refunds or chargebacks. That is a second request and a genuinely different question, so it is a page with its own address: it is what an owner forwards when an accountant queries a figure, and a link can be forwarded.

**Pagination, not infinite scroll**, because that is what the endpoint does (`page`/`limit`, with a `meta` carrying `total` and `pages`). Inventing a second paging model over the first would be a choice the API does not support — and it is the wrong one here anyway, since somebody checking a figure wants to be able to say which page they were on.

**Two empty states, and keeping them apart is the point.** A venue that has taken nothing and a filter that matched nothing look identical if both render an empty list, and they mean opposite things. The first explains that nothing has happened yet; the second says the venue may well have taken payments and this question excluded them, and offers to clear the filter.

#### Two promises this section makes that the API cannot keep

**1. "Staff Member" is not on the row, and cannot be.** `TransactionListEntry` carries no membership and no display name. The *filter* accepts a `membership` uuid — so the API can narrow to one person while the rows cannot name anyone, which is a filter whose result nobody can read. It is therefore not offered on this screen. Closing this needs a field on the list entry.

**2. The list is not shift-scoped, and cannot be.** ADR-065 puts operational screens on shifts. `Transaction` has no `shiftId` and no relation to `Shift`; `Payment` has none either; only `LedgerLine` does. `transactionListQuerySchema` accepts `restaurantId`, `status`, `membership`, `page`, `limit` — no shift and no date. **So this list is every payment at the venue, newest first, and the screen says so in a line of its own** rather than letting a reader assume it is the open shift. The Dashboard remains the screen that follows the shift.

Both are recorded in `UX_API_RECONCILIATION.md`. Neither is closed here: the axis of this slice was the screen, and both fixes are backend changes.

#### One thing found while reading the routes, not fixed here

`GET /transactions/{id}` carries `@RequirePermission("reports.view")` **without `@UseGuards(PermissionsGuard)` on the method**, and `PermissionsGuard` is deliberately not global (`permissions.guard.ts` says so). The decorator on that route is therefore **inert**. The route is not open — `TransactionService.findOne` performs the same permission check itself, and a Waiter is refused — so this is a claimed second layer that does not exist rather than a hole. Worth naming because the contract invariant keys on the decorator's *presence*: the route is documented as permission-guarded while its guard is not wired.

---

## Analytics

**Purpose:** Transform transactions into business insights.

**Sections:** Revenue · Tips · Staff · Performance · Reports · Exports

**Corrected to match ADR-027, which this document had fallen behind by three sprints.** The decision was made when Analytics was built; only the map was never updated, so it still promised screens that were deliberately never created:

- **"Time Analysis" and "Growth" were one thing, and it is called Performance.** Period-over-period comparison: the chosen range against the immediately preceding range of the same length. Two separate sections would have been two views of the same numbers.
- **"Payments" is gone.** It was never built and never decided on — a section name with no definition behind it. Payment-level detail is the Transactions screen.
- **"Employees" is "Staff"** — same ADR-033 reasoning as everywhere else in this document.

**Every section takes an explicit date range** (`from`/`to`, interpreted in the Restaurant's own timezone), capped at 366 days. The cap is deliberate and the screen should present it as a normal bound rather than an error.

**Reports is a short fixed list, not a report builder.** One report exists today — a period summary. A second is a second entry, not a query interface; nothing here should be designed as though arbitrary report construction is coming.

**Exports: five, one per section, all CSV** — Revenue, Tips, Staff, Performance, Reports. **They are gated by a separate permission (`data.export`) from the one that lets a person read the screens (`reports.view`)**, and the two are genuinely independent: someone may be able to read every figure here and still not be allowed to take the data out of the building. The UI must reflect that split rather than assuming that a visible screen implies an available export.

---

## Close A Venue

**Not built yet.** The wording is settled here first, deliberately: this is a destructive-looking action, and the copy next to a destructive button is the copy most likely to be written in a hurry by whoever builds the screen.

**The action is "close", never "delete" (ADR-054).** Restaurants close; they are not deleted, and the accounting for the years they traded is still needed. The backend has always behaved this way — `DELETE /restaurants/{id}` sets `deleted_at` and `status = INACTIVE` and nothing else — so this is the screen catching up with the system, not a change to it.

**Never "permanently".** Reopen is planned as its own change (seasonal closure is ordinary in Lithuanian hospitality — a venue that closes in November and cannot come back in April loses its history and leaves). Copy that forecloses reopen would have to be rewritten the week it ships.

**Three things the screen must say, and the third is the one that matters:**

1. **What stops.** The venue stops trading through the platform: it leaves the owner's list, stops taking payments, and nobody can be invited to it.
2. **What does not.** Payments, transactions and reports are untouched. Closing never changes what a venue earned.
3. **What happens to Stripe — stated plainly, because a person could otherwise believe we switched off their ability to take money.** The connected account belongs to the owner: they are merchant of record and hold their own Stripe Dashboard login (ADR-014). Closing here ends *our* routing of payments through it. **The account stays open, and only they can close it, by contacting Stripe directly.**

Point 3 is written as fact with no legal characterisation, and **it says the same thing as the Terms of Service.** Two texts describing one behaviour in different words will drift, and the one a person is most likely to act on is the screen. Whoever edits either must edit both.

---

## Settings

Restaurant Information · Business Details · Tip Configuration · Payment Configuration · Users · Permissions · **Tax Information** *(blocked — see below)*

**What changed (ADR-009):** Payment Configuration now includes the Stripe connection itself — connected account status, `cardPaymentsStatus`, `payoutsStatus`, and any outstanding requirements. This is the permanent home for what the Dashboard banner and the Connect Payments screen link to.

**Removed (Sprint 13 frontend review): Notifications · Integrations · Security.** None of the three exists, none is planned for MVP, and none had a definition — three headings that would each have opened an empty screen. They return when there is something to put in them.

*(The account-level "Security" a person actually needs — changing their own password — belongs on Profile, not here, and is a real backend gap noted there.)*

**Tax Information stays listed, and stays blocked.** Not an oversight and not deferred for convenience: what to display depends on the waiter's employment classification for Lithuanian income-tax purposes, which is a legal question no line of code can answer on the platform's behalf. ADR-029 makes this explicit — **no rate, no bracket and no computation gets built until the Founder has a written answer from a Lithuanian tax consultant.** It is listed here so nobody re-derives the need and quietly implements a guess.

**Permissions is read-only for now.** Roles and their permission sets are seeded, not editable, and no endpoint exposes them — a real gap, scheduled behind the more pressing ones. The screen should show what each role can do; changing it is not MVP.

---

## Profile

Owner Information · Company Information · Language · Security · Logout

**What changed (ADR-005):** for an org-wide Owner, "Company Information" is Organization-level; for a Manager scoped to one Restaurant, it stays Restaurant-level, exactly as before.

**Removed (Sprint 13 frontend review): Subscription · Billing.** No billing concept exists anywhere in the product — not in the API, not in the schema, not in MVP scope. `MASTERPLAN.md` places monetisation in a later phase, and two headings promising a paid relationship that has never been designed are worse than absent.

**"Theme" removed** — nothing persists it, and a preference that resets every session is a bug wearing the costume of a feature. It returns when there is somewhere to store it.

**Security here means one thing: changing your own password.** This is a genuine backend gap — no endpoint exists — and it is scheduled, because a product people sign into with a password and cannot change it is an obvious hole rather than a missing nicety.

**Language is the only editable field on this screen today.** Owner Information is otherwise read-only: name and email cannot yet be changed. Worth stating plainly rather than letting the screen imply otherwise.

---

# APPLICATION B — Waiter Portal

**Navigation:** Home · Wallet · Transactions · Profile · Settings

---

## Home

**Purpose:** Give the waiter immediate understanding of today's work.

**Sections:** Today's Earnings · Today's Tips · Today's Transactions · Average Tip · Recent Payments · Quick Statistics

**What changed (ADR-006):** for a waiter with more than one active Membership — working shifts at more than one restaurant on the platform — every figure here is a combined total across all of them by default, with a lightweight filter to view one restaurant on its own. A waiter with only one Membership never sees the filter; the screen looks exactly as it did before.

---

## Wallet

**Purpose:** Show available earnings.

**Sections:** Current Balance · Pending Balance · Lifetime Earnings · Withdrawal History · Transaction History · Future Withdrawals

**What changed (ADR-006):** this is now, technically, one-or-more Wallets — one per restaurant employing this person. With only one, nothing changes. With more than one, this screen shows a combined total up top, with each restaurant's balance broken out underneath. The money itself stays separate per employer underneath — different legal entities, potentially different payout timing — only the display is combined.

**Wallet Card:** Available · Pending · Total · Trend · Last Payment · **Restaurant** (shown only when this person has more than one active Wallet, so a combined view never hides which balance came from where)

**Pending Balance is always zero today, and the screen must not imply otherwise** (ADR-024). Not a bug and not an oversight: nothing can be withdrawn from a Wallet at all yet, so "available" and "pending" would be two labels on the identical, equally-uncashable number. The split becomes meaningful when withdrawals exist. Until then this figure should be presented as inactive rather than as a real zero balance a waiter might be waiting on.

**Transaction History is Ledger-derived, not a copy.** Every line is reconstructed from the underlying accounting entries rather than stored separately (ADR-002/024) — which is why a balance can be rebuilt from scratch and still match exactly. Each row carries its own direction, amount, restaurant and the entry type that caused it, so a waiter can always answer "why did this number change."

**A tip can go down.** A chargeback opened after a tip was allocated reverses that credit, and the balance correctly drops (ADR-023). This is the one place in the Waiter Portal where a number moving backwards is expected behaviour, and the history is what has to explain it — silently showing a smaller total is exactly the situation that destroys trust in a wallet.

---

## Transactions

**Purpose:** Complete history.

**Transaction Card:** Restaurant · Time · Tip · Total Bill · Status · Reference Number

This screen already showed which Restaurant each transaction came from — it needed no change for multi-restaurant waiters. It was ready for this from the start.

**Transaction Details:** Restaurant · Timestamp · Bill · Tip · Wallet Change · Payment Status · Receipt

---

## Profile

Personal Information · Employment · Statistics · Achievements (Future) · Language · Security

**What changed (ADR-005):** Employment now lists every active Membership — every restaurant this person currently works at, and their role at each — rather than assuming exactly one.

---

## Settings

Notifications · Language · Theme · Security · Privacy · Logout

---

# CUSTOMER EXPERIENCE

No application. No account. No registration. No profile.

---

## Payment Flow

Terminal → Bill Display → **Select Staff Member** → Choose Tip → Review Total → Card Payment → Payment Processing → Receipt → Finished

Target completion time: less than 30 seconds.

The Ledger, Idempotency-Key, and Outbox mechanics behind "Card Payment" and "Payment Processing" (ADR-002, ADR-003, ADR-004) are invisible to the customer by design — that is the entire point of them.

**"Select Staff Member" is new here (ADR-033), and its absence from this document was a real gap:** the interaction was decided, built and shipped on the backend while the map of screens still described a flow without it. See below — it is a staff-facing step inside a customer-facing flow, which is precisely why it was easy to leave out of both maps.

---

## Select Staff Member

**Who touches this: staff, not the customer.** It happens on the same terminal, before it is handed over. That dual audience is the whole design problem — it must be fast enough not to delay the customer, and it sits inside the one flow this product promises to keep under 30 seconds.

**Interaction:** three-dot menu → list of staff → tap a name → one confirmation tap. No PIN, no password.

**The list is everyone who can be reached at this Restaurant, with no filter by role** (ADR-033). A Manager or the Owner who personally served a table is exactly as valid a recipient as a Waiter — the criterion is *who served this table*, not *who holds which role*. Each entry shows the person's display name, with their role beside it to tell apart two people with similar names.

**This is explicitly not a security control, and the interface must not pretend otherwise.** Anyone with the terminal can select anyone. The confirmation tap guards against a mis-tap and nothing more — a deliberate decision, not an oversight. It must not be dressed up as authentication: no lock icons, no "verify identity" language, nothing that implies a check is being performed. What actually protects against misuse is that both facts are recorded afterwards — who was logged in, and who was selected, as two independent entries in the audit trail (ADR-033). Forensic, not preventive.

**Required whenever a tip is left.** A payment with a tip and nobody selected is rejected before it ever reaches Stripe, so the terminal must not allow the flow to continue past the tip step without a selection. With no tip, no selection is needed — there is nobody to attribute.

**The list is never empty in practice.** A Restaurant always has at least the Owner or Manager who created it, so "no staff yet" is not a state a real terminal reaches. Handle it defensively; do not design a screen for it.

---

## Tip Selection

**Preset Values:** 10% · 15% · 20% · Custom

**Requirements:** One tap selection. Large touch targets. Immediate total calculation. No unnecessary confirmations.

---

## Payment Success

Large success icon. Payment confirmed. Tip confirmed. Receipt option. Finish.

No advertisements. No promotions. No unnecessary screens.

---

## Payment Failure

Clear explanation. Friendly language. Retry button. Alternative payment. Call staff button (Future).

---

# Universal UX Rules

Every screen must answer: Where am I? What can I do? What happens next?

Users should never guess.

---

# Screen Rules

Every screen contains: Purpose · Primary Action · Secondary Actions · Navigation · Empty State · Loading State · Error State · Success State · Analytics Events · Accessibility

---

# Interaction Rules

**Primary Action:** One per screen.
**Secondary Actions:** Maximum three.
**Dangerous Actions:** Always require confirmation.

---

# Animation Rules

Animations communicate state. Never decoration.

Examples: Loading · Success · Error · Navigation · Payment

Animations should complete within 300 milliseconds whenever possible.

---

# Accessibility

Minimum touch target: 44x44. Readable typography. High contrast. VoiceOver support. Keyboard navigation (Desktop). Accessible colors.

No information communicated by color alone.

---

# Golden Rule

If a first-time user cannot complete the task without explanation, the interface is wrong.

Never train users. Design software that teaches itself.
