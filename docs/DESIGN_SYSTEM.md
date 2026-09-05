---
title: DESIGN_SYSTEM
version: 2.0.0
status: Active — Part 1 (structure, hierarchy, state) and Part 2 (surfaces, palette, type, spacing, density) both written
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# DESIGN SYSTEM

> "A design system is not a set of colours. It is a set of decisions that stop being re-argued."

---

# What This Document Is, And What It Is Not

`UX_MAP.md` has named this file as one of its foundations since v1.0 and it did not exist. This is it, in two parts.

**Part 1 covers what does not change when the palette changes:** what the product is emotionally for, which element on a screen wins when two compete for attention, how a figure that needs a caveat carries it, and what every component owes its own empty and broken states. These are structural decisions. A different colour scheme, a different typeface, a tighter grid — none of them invalidate a single rule in it.

**Part 2 covers surfaces, palette, type, spacing, density and elevation.** It sits on top of Part 1 and may not contradict it; where it seems to need to, that is a signal Part 1 was wrong and gets revised explicitly rather than quietly worked around. That has happened once already, and the retraction is left visible on purpose — see *The Portal's Surface*.

The split is deliberate and worth stating, because it is the usual failure mode of a design system: teams start with a colour palette, then discover six months later that no one ever decided what the product is supposed to *feel* like, and the palette turns out to be load-bearing for an argument it was never designed to settle.

**Nothing in this document is implemented yet.** No frontend screen exists in this codebase. This is documentation-first per `CLAUDE.md`, written before the first component rather than reverse-engineered from it.

---

# The Emotional Contract

The Founder was asked what the Dashboard is for, and answered: **"today is a good day."**

That is a complete product decision, and every rule in this document descends from it. It settles a question that would otherwise be re-litigated on every screen:

**The Restaurant Portal Dashboard answers "how are we doing?", not "is anything wrong?"**

Those are different products. An operational dashboard is scanned for anomalies; its job is to be boring when things are fine and loud when they are not. An emotional dashboard is opened because the owner *wants to look* — the same reason people open a banking app when they already know the balance. It rewards attention rather than demanding it.

This choice buys something real: an owner who opens the product because they enjoy it uses it daily, and daily use is what makes the data worth having. It also costs something real, and the cost is severe enough that it gets its own first-order section below.

**Where this contract does not apply:** the customer-facing payment terminal, and any screen whose purpose is to report a failure. A refund, a failed payment, a Stripe requirement blocking payouts — these are operational moments and must be designed as such. Applying a reassuring register to a genuine problem is not warmth, it is dishonesty, and this document forbids it explicitly (see *The Mirror Risk*).

---

# Reading The References Honestly

Four references were supplied: a dark orange fintech landing page (QPAY), a dark consumer banking app (analytics / cards / settings), a dark card-management app, and a light mint-and-black banking app (login / accounts / currency detail).

**What they genuinely agree on, and what we should take:**

1. **One number dominates, without competition.** `$8,987.00`, `11 989,99 EUR`, `$1738.00`, `109,99 USD`. In every product reference the hero figure is set several times larger than anything else on screen and is given empty space on all sides. Nothing shares its rank. This directly corroborates the Founder's instruction that revenue and tips dominate rather than sitting in a grid of equal cards — and it is worth knowing the convention already exists in the category rather than being our invention.
2. **Accent colour is rationed.** QPAY is an orange design that uses orange on roughly two elements. The mint reference uses its green almost entirely as ground and one promotional card, never on data. In all four, *the numbers themselves are neutral* — accent marks actions and status, not money. This is a rule Part 2 must inherit: **accent colour is not how importance is expressed; size and space are.**
3. **Labels are quiet.** Every caption sits well below its value in both size and contrast. The eye lands on the figure and only then finds out what it is.
4. **Soft, self-contained cards on a plain ground.** Content groups into rounded containers with generous internal padding; the background does almost nothing.

**What they do not tell us, and where copying them would hurt:**

- **All four are consumer products showing a person their own money.** `$8,987.00` is *yours*, to spend, with no explanation owed. Our hero figure is a business's gross sales, from which a platform fee has not yet been deducted, displayed next to tips that legally and morally belong to *staff, not the viewer*. The emotional register of "your balance" cannot be transplanted onto a number that is neither the viewer's to keep nor final. This is not a stylistic difference; it is the reason the caption problem below exists at all.
- **QPAY is a marketing landing page, not a product.** Its layout, its hero card render, its "Trusted by" logo row and its stat badges answer "should I sign up?" — a question none of our screens ask. Its useful contribution is the accent-restraint lesson and nothing else. Recorded plainly so it is not mined later for layout ideas it cannot supply.
- **All four are phone-first, single-column, one-hand, at leisure.** The Restaurant Portal is used by an owner on a laptop or tablet between service peaks, and the Waiter Portal by someone standing on a floor mid-shift. Session length, lighting, and attention budget all differ. Consumer polish transplanted wholesale produces a product that photographs well and performs badly at 11pm in a dim room.
- **Three of the four are dark; one is light. That is still a Part 2 decision** — but it is now settled that it is made **per surface**, not once for the product (see *One Product, Two Visual Systems*). An earlier version of this line claimed dark was defensible for the Portals "on ergonomics rather than fashion — restaurants are dim, and a bright screen at a service pass is unpleasant." **That claim has been withdrawn; see *The Portal's Surface* below.** It is worth leaving the retraction visible rather than quietly deleting the sentence: it is a clean example of an aesthetic preference arriving dressed as an ergonomic argument, which is the failure mode this whole document exists to catch.

---

# Product Identity On Screen

**Found by the Founder on the first screen this system produced: the login page did not say what product it was.** The gap was not the login screen's — it was this document's. Everything here described surfaces, tokens, hierarchy and semantic state, and nothing said how the product names itself. Log In was simply the first screen to need it.

**The product is called PlainTabs.** (`plaintabs.com` is registered; `ARCHITECTURE_DECISIONS.md` already refers to it in ADR-035.)

## Why this is not decoration

Log In is **the only screen a person sees before they know where they are.** An owner opening a link from an email has no confirmation it leads to the product someone described to them. Every other screen is reached from somewhere, and the somewhere carries the identity.

There is a second reason, and it is a security one rather than a brand one: **a credential form with no identifying marks is the standard appearance of a phishing capture page.** Teaching people that our real login looks anonymous teaches them to trust anonymous credential forms. On a financial product that is a habit we cannot afford to build.

## The distinction that must not be lost

**The login screen's sparseness is correct and stays.** One screen, one task, and the empty space works for it — that is the Hierarchy Law doing its job, not an unfinished page.

**A missing name is not sparseness. It is a missing element.** These look identical to someone glancing at a screenshot and are opposites in intent. Recorded explicitly because without the distinction, the reasonable next move is to start "filling in" a screen that is correctly empty.

## The wordmark is typographic, and it is not the accent

There is no logo, and inventing one is not a design-system decision to make in passing. The wordmark is therefore **type: IBM Plex Sans, 700, tracking −0.02em, set as "PlainTabs".** One face, because it is the only face this system has — reaching for a second one purely to set a wordmark would be a dependency with no reason behind it.

**The wordmark is never the accent colour.** It renders in `--text`, the same neutral ink as everything else. That follows from *Accent Colour Never Carries Importance*: accent marks actions and status, and a wordmark is neither. It has a useful second consequence — the restaurant-branding candidate (`MASTERPLAN.md`) lets a restaurant own the accent, and this rule means **it can never recolour our name**, which is the correct boundary. A restaurant brands the surface it paid for; it does not rebrand us.

**The wordmark is not a dictionary entry.** `ADR-040`'s `t()` covers translated strings; a product name is not translated. It lives as a constant.

## Where the name appears, and at what size

| Surface | Treatment |
|---|---|
| **Entry screens** — Log In, Register, Accept Invitation | The wordmark is the screen's **rank-1 element**, at `hero-2` (30px). It is the confirmation the person came for. |
| **Inside the Portal** | Persistent chrome, at `label` size. Orientation rather than confirmation — by then they know where they are. |
| **The guest terminal** | **Absent during the payment flow.** Present once, quietly, on the completion state. See below. |

**A rule that follows from the table and is worth stating on its own: every screen reachable before authenticating carries the wordmark.** That is the whole set of screens where a person cannot yet tell where they are.

**On entry screens the wordmark replaces a separate page heading rather than sitting above one.** "Log in" above a form containing an email field, a password field and a button labelled "Log in" is a heading that tells nobody anything. The name is the thing that does. One rank-1 element per screen, and on these screens it is the name.

## Why the terminal is different

The terminal is the one surface where **the user is not ours** (*One Product, Two Visual Systems*): ten seconds, a stranger, no reason to try again. What that person needs to trust is **the restaurant whose table they are sitting at** — and the branding candidate exists precisely so the device reads as part of that room.

An unfamiliar brand name adds nothing to that trust and costs attention the screen does not have. So it is not on the payment step.

**It appears once, on the completion state, at `micro` size.** After the money has moved, a guest who wants to know who processed the payment has somewhere to find it — a refund question, a card statement line they do not recognise. Before the money moves it is noise; after, it is an answer to a question someone may actually have.

---

# Accent Colour Never Carries Importance

**A rule in its own right, taken from the references and binding on Part 2.**

In all four references, *the numbers themselves are neutral*. Accent marks actions and status — a button, a state, a change — and never money. Importance is expressed by **size and space**: the hero figure wins its screen because it is several times larger than everything else and has emptiness around it, not because it is coloured.

**Part 2 must inherit this, and stating it here is what makes that enforceable.** A palette that starts colouring figures by importance immediately begins arguing with the Hierarchy Law: two systems then claim to rank the same screen, they disagree the first time a red loss figure sits beside a larger neutral revenue figure, and the reader is left to guess which ranking is the real one. Colour is the weaker of the two and will win anyway, because the eye finds hue before it measures size — which is precisely why it must not be given the job.

**What this permits, and what it forbids:**

- **Permitted:** accent on actions and interactive affordances; semantic colour for genuine state — a failed payment, a refund, a requirement blocking payouts. Semantic colour is a separate register from the brand accent and is not spent on ranking.
- **Forbidden:** accenting a figure because it is important, tinting the hero number to make it feel bigger, or colour-coding a set of figures so the palette re-ranks what the layout has already ranked.

The practical test: **if the accent were removed entirely, the hierarchy of the screen must survive unchanged.** If it collapses, colour was carrying weight that size and space should have been carrying.

## Three rules that are one decision, and must be re-opened together

These were written weeks apart, for unrelated problems, and they turned out to be the same decision seen from three sides. Recording the link explicitly, because **each is individually reversible-looking and jointly load-bearing** — changing one silently invalidates the other two.

1. **Accent never carries importance.** (This section.) Ranking is done by size and space.
2. **The accent is one swappable token, and a restaurant may own its value.** (*The accent is a token from the first line of CSS*, and `MASTERPLAN.md`'s branding candidate.)
3. **The wordmark is never the accent.** (*Product Identity On Screen*.)

The chain: (2) is only safe *because* of (1) — if accent ranked anything, letting a restaurant change it would let a restaurant change what a screen means. And (3) falls out of (1) rather than being a separate aesthetic preference: accent marks actions and status, and a wordmark is neither.

That last derivation produced something nobody set out to design: **the boundary between what a restaurant owns and what we own.** A restaurant brands the surface it paid for; it cannot recolour our name, because our name was never eligible for the accent in the first place. That answer was not available when any of the three rules were written — it emerged from them.

**So the trigger is joint, not individual: if accent ever starts ranking, all three are re-opened on the same day.** Not "revisit the accent rule" — the customisation feature stops being safe, and the identity boundary stops being derived from anything. A future engineer changing (1) needs to know they are changing three things.

## The system is a monochrome base plus one accent token (Founder decision)

**This is not "we picked a palette."** Three directions were built and compared on identical screens — a monochrome one, a warm-paper-and-green one, and a warm one with amber. The correct reading of the result, and the Founder's own: **the monochrome base *is* the system, and the three "directions" were one system with three values of a single token.** The first was that system with the accent set to black; the other two set it to a colour.

So there was only ever one question — **what the default value of that token is** — and the answer is **a darkened amber, `#9A5D14`**.

**Green was rejected, and the reason outlives the decision.** A brand accent and the semantic "succeeded" state cannot be the same colour: on the terminal, a guest would not be able to tell *press this* from *this worked*. That is a structural constraint on any future accent value, not a preference about green — it applies equally to whatever a restaurant later chooses under the branding candidate, and it is why the pre-verified palette Part 2 defines must exclude the semantic hues rather than merely avoiding them by taste.

**Amber is recorded darkened, with the measurement, because the measurement is the finding.** The amber first reached for (`#B5701F`) measured **3.87:1** against the pay button's own text — below the 4.5:1 minimum, on the one screen where a stranger gets ten seconds and no second attempt. At `#9A5D14` it measures **5.19:1** and passes with headroom. The conclusion worth carrying forward is not the hex: **a light amber is structurally unavailable to us — this hue only qualifies pushed towards brown.** Any later proposal to "brighten it up" is re-opening a contrast failure, not a taste debate.

## The accent is a token from the first line of CSS, never a hardcoded colour

**Binding from the first component, and the one part of a deferred feature that cannot be deferred.**

`MASTERPLAN.md` records a Pilot-Ready *candidate* — letting a restaurant put its logo and **one** accent colour on the guest-facing terminal, chosen from a palette we have pre-verified for contrast. It is gated on evidence from real pilots and is not being built. But it fixes one requirement on the interface today: **the system must be able to swap exactly one accent value without touching anything else.**

Doing that from the start costs nothing — a variable instead of a literal. Retrofitting it costs a sweep of every component, and the kind of sweep that misses three places and leaves a restaurant's terminal with our colour in the corner nobody checked.

Three consequences that follow from the rule above and make this cheap to keep true:

- **Exactly one accent value is swappable.** Not a theme engine, not an arbitrary palette. One token, chosen from verified options.
- **Because accent never carries importance, changing it can never change what a screen means.** A swappable accent is only safe *because* of the rule in this section — the two are the same decision seen from either end. If accent ever starts ranking, customisation stops being safe on the same day.
- **Semantic colour is not customisable, ever.** A failed payment must look failed in every restaurant. Semantic state belongs to us; the brand accent is the only thing a restaurant may own.

---

# The Hierarchy Law

Three of the Founder's four Dashboard instructions are hierarchy instructions. They are stated here as one rule with a reason, so that the next screen — Transactions, Analytics, Employee Details — can be laid out without asking again.

**The rule: rank by how much meaning the element carries per second of attention, not by how much data it contains.**

Applied to the Dashboard, this produces the Founder's ordering, and explains it:

| Rank | Element | Why it ranks here |
|---|---|---|
| **1** | `todayRevenue`, `todayTips` | The answer to the question the screen exists to ask. Everything else is support. |
| **2** | `revenueChart` (7 days) | **A number alone carries no emotion.** €1,240 is meaningless in isolation — is that a good day? The chart answers instantly, without arithmetic. It is not decoration; it is what converts the hero figure from data into a feeling, and it is the single most under-ranked element in most dashboards. |
| **3** | `topStaff` | "Who did well today" — part of the mood, and read as faces and names, not as a table. Uses `displayName` (`email` may sit beside it as the disambiguator when two people share a name, never as the primary label). |
| **4** | `recentPayments` | Reassurance that the system is live and the numbers above are real. Scanned, rarely read. |
| **5** | `averageTipBasisPoints` | A quality metric, interesting on reflection, never the reason anyone opened the screen. |

**Two consequences that will be tempting to violate:**

- **`revenueChart` outranks `topStaff` and `recentPayments`, and must be given the space that implies.** The instinct will be to shrink it into a sparkline in a corner because it is "just a chart." That inverts its purpose.
- **A grid of equal cards is forbidden on this screen.** Equal size communicates equal importance, which is precisely the claim we are refusing to make. If a layout ends up as four cards of the same size, the hierarchy has been lost regardless of what the colours do.

**Generalising beyond the Dashboard:** on any screen, name the one question it exists to answer before laying it out. The element that answers it gets rank 1 and no competitor. If two elements both seem to deserve rank 1, the screen is doing two jobs and should probably be two screens (`UX_MAP.md`'s three-level navigation rule exists for the same reason).

---

# The Caption Problem

ADR-026 requires `todayRevenueNote` — the fixed string **"Before platform fee deduction"** — to appear with `todayRevenue`. It is a constant returned by the API, not client-side text, precisely so this explanation can never drift or be quietly dropped.

The Founder's instruction is that it must not compete with the hero figure for attention. The design answer is more specific than "make it small":

**The caption is part of the number, not an annotation on it.** The hero figure is a three-line composition — label above, value, caption below — that is designed, spaced, and reasoned about as a single unit. The caption is set at caption weight and low contrast, close enough that the eye takes it in on the way out of the figure rather than as a separate stop.

**What is forbidden, and why:**

- **A tooltip, an asterisk, an ⓘ icon, or a "learn more".** All four are the same move: hiding a caveat behind an interaction, which means most viewers never see it. We use those devices when we wish the caveat weren't there. Here the caveat is *what makes the number honest* — an owner who reads €1,240 as money they keep has been misled by our screen, and the fee will surprise them later, which is exactly the moment trust is lost in a financial product.
- **Warning styling.** It is not a warning. Amber text, a caution icon, or a bordered callout would make a routine, permanent, correct fact look like a problem — and would then compete for attention far harder than the plain caption ever could, achieving the opposite of the instruction.

**The general rule this establishes:** *any figure whose meaning is narrower than its label suggests carries that narrowing visibly, permanently, and quietly.* This will recur — `netRestaurantRevenue` on Transaction Details (ADR-025) is a different quantity from `todayRevenue` under a word that looks the same, and the Founder has already ruled that such differences must be explicit on screen rather than only in documentation.

---

# The Zero State Is A First-Order Requirement

This section is the most important in the document, and it exists because the emotional contract has a cost that must be paid deliberately rather than discovered.

**A screen designed to convey "today is a good day" conveys "today is a bad day" far more forcefully than a neutral operational screen ever could, when the figures are zero.** The design amplifies whatever it is given. A giant €0.00, a flat line where the chart should be, and an empty "who did well today" list is not a neutral screen — it is three separate emotional failures stacked in the exact order of the hierarchy above. Every property that makes the screen good at its job makes it worse at this.

`UX_MAP.md` already contains the correct instruction — *"zeroes must read as 'nothing has happened yet', never as 'something is broken'"* — but it was written as an onboarding detail. Under the emotional contract it is promoted here to a **first-order requirement of the entire product**, and it changes what the frontend has to build.

## The rule, in its general form

**The API already refuses to say "zero" when it means "nothing yet". The interface must refuse the same way — on every figure on every screen, not only on the figure that happens to be nullable.**

That is the governing rule of this section, and it is stated in general form deliberately, because the evidence for it is one specific field and the obligation is not.

The evidence: `averageTipBasisPoints` is deliberately `null`, never `"0"`, when there is no revenue — because `0%` is a real, meaningful, *bad* tip rate, and reporting it when nothing has happened is a lie (ADR-026, following ADR-025's precedent). The backend drew that distinction once, in one place, for one figure.

The obligation is wider. Most of our figures are not nullable — `todayRevenue` really does come back as `"0"`, because zero revenue and no revenue are the same integer. **The backend's type cannot carry the distinction for those, so the interface has to.** Reading `"0"` and rendering `€0.00` is technically faithful and still a lie, in exactly the way `0%` would have been. Wherever the type stops distinguishing, the composition must — which is what the four states below are for.

Corollary, so this is not mistaken for licence: **the answer is never to hide the figure.** A zero that is genuinely a zero is shown, in context that explains it. See *The Mirror Risk*.

## Three zero states, not one

Conflating these is the actual bug. They are different situations that need different screens:

**1. Nothing has ever happened.** A new restaurant; possibly payments not yet live (`card_payments_status` ≠ `active`). Forward-looking and instructional. This is the state a new owner spends the most time in and where the product is visibly incomplete through no fault of theirs. The screen's job here is to explain what will appear and what makes it appear — the hierarchy above is *replaced*, not rendered with zeros.

**2. Nothing has happened *yet today*.** A Tuesday at 10am; the kitchen opens at five. **This is the state that will occur every single day, forever, and it is the one nobody designs.** It is completely normal and must read as such — ideally by leaning on context the screen already has: yesterday's figure, the 7-day chart (which is *not* empty and carries the reassurance on its own), the time of day. This is the strongest argument for `revenueChart`'s rank 2 that exists: **at the start of every day it is the only element on the screen carrying any signal at all.**

**3. Data should exist and does not.** A real failure — a broken integration, a stalled outbox, a reconciliation gap. Must be visually distinct from both of the above and must not be reassuring.

## The Mirror Risk

The instruction "make zeros feel fine" taken literally would remove our ability to raise an alarm. If every empty screen is warm and reassuring, a genuine outage looks exactly like a quiet morning, and the owner finds out from a customer instead of from us. That failure is worse than the one this section is written to prevent, because it costs money rather than mood.

**The resolution: reassurance comes from explanation, never from suppression.** We never hide a zero, soften a real figure, or show a placeholder in place of a fact. We state what the figure is and why it is what it is. "No payments yet today — service usually starts around 17:00" and "We haven't been able to reach Stripe since 14:20" are both honest, and they feel completely different because they *are* completely different. A design system that achieves calm by withholding information has chosen the wrong tool, and in a financial product it will eventually be the reason someone stops trusting us.

## The rule this imposes on every component

**Every component declares four states as first-class designs, not fallbacks: populated, never-populated, temporarily-empty, and failed.** A component whose empty state is "itself, rendering zero" is incomplete and must not be considered done. This applies to `COMPONENT_LIBRARY.md` when it is written, and it is a review item, not a guideline.

---

# One Product, Two Visual Systems

**Decided (Founder). One shared foundation — spacing scale, type scale, component shapes, motion, and every rule in this document — with the customer terminal permitted its own surface treatment, chosen on legibility rather than on matching the Portals.**

We have two surfaces with genuinely different constraints, and the reference folder addresses only one of them:

- **The Portals** (Restaurant, Waiter) — signed-in, repeat users, sessions of minutes, indoors and usually dim, on a device the user controls. Everything in this document and every reference supplied is about these.
- **The customer payment terminal** — a stranger, ten seconds, one interaction, on a device they have never seen and will never see again.

## The reason that decides it: on the terminal, the user is not ours

Every other surface is used by someone with a stake in us. An owner and a waiter *learn* the product: they build habits, they tolerate an awkward control the second time because they understood it the first, and they have a reason to work past a moment of friction. That tolerance is real, and it is what lets the Portals carry an emotional contract at all.

**The guest has none of it.** They see this screen once in their life, for ten seconds, with no interest in understanding it and no reason to try again. There is no second impression, no learning curve to amortise the design against, and no goodwill to spend.

**Optimising that screen for consistency with the Portals means paying for our own internal tidiness with money that never arrives.** Every other trade-off in this document is between two things we own; this one is between how our product feels to us and whether a payment completes. It is not a close call, and it is a stronger reason than the ergonomic one below — which is why it is stated first.

## The ergonomic reason, which is not a small one either

A dark interface in direct sunlight is materially harder to read, and the terminal is the screen least able to afford it. In Lithuania (ADR-012 — launch market) this is not an edge case: **the summer terrace is a substantial share of a restaurant's revenue, and a significant share of all payments will be taken there.** A surface treatment chosen for a dim dining room, applied unexamined to a device held over an outdoor table in July, degrades exactly where the money is densest.

The terminal also has no dashboard, no hierarchy problem and no emotional contract. It has one job, and needs maximum legibility and zero ambiguity.

## The Portal's surface — a withdrawn justification, and what replaces it

> **REVERSED 2026-09-04 (ADR-072). The Portal is dark, and there is no light Portal.** Founder decision. The text below is kept in full and unedited, because it is the argument the new decision replaces, and a reversal is only readable next to what it reversed. Two things in it are worth carrying forward rather than discarding: the reconciliation argument was *sound* and is now simply outranked by a Founder call on the product's own appearance, and the reframe underneath it — **surface is a token set, not an identity** — is what made this change cheap: one file, no screen touched.
>
> What did NOT survive: the amber accent, the light/dark pair, and `prefers-color-scheme` as a Portal mechanism. What did: the terminal's white, chosen on legibility rather than on house style.

**Decided (Founder): light by default, dark as a supported preference. Both defined in Part 2.** *(Superseded — see the note above.)*

This document previously justified a dark Restaurant Portal as ergonomics: *restaurants are dim, a bright screen at a service pass is unpleasant.* The Founder challenged it as an argument from a surface we do not build. Checked rather than defended, it is worse than that:

- **`UX_MAP.md` specifies no device and no environment for either portal.** Not for the Restaurant Portal, not for the Waiter Portal. The dim room was not read from any document — it was assumed and then written down as though it had been established.
- **There is no screen at a service pass in this product at all.** The Restaurant Portal belongs to the owner and manager, the Waiter Portal to the waiter, the terminal to the guest. A kitchen screen was reasoning about a surface that does not exist.

So the justification is withdrawn entirely. Not softened — withdrawn. What can be said instead, and checked:

- **The content is financial documents.** Figures, tables, exports. What an owner checks our numbers against — a bank statement, an accountant's spreadsheet, an invoice — is light. That is not fashion; it lowers the cost of comparing, which is the actual job.
- **Dark-for-long-reading is folklore.** For sustained reading at normal vision, light-on-dark performs slightly *worse* — the pupil opens and thin type haloes. Dark's genuine advantages are low ambient light and certain visual conditions: a per-person preference, not a product default.
- **A light Portal collapses two surface treatments into one**, since the terminal is already decided light. That is the same argument that ruled out two independent design systems, applied one level down.

**The argument the Founder accepted as decisive was the first one, and it is worth keeping in that form: reconciliation is the owner's actual work with this product, not a side activity.** Forcing the eye to re-adapt on every comparison between our screen and a statement raises the cost of the primary task. Everything else above supports that; nothing else needed to carry it.

The reframe that makes this cheap rather than dramatic — **surface is a token set, not an identity**, exactly as the accent turned out to be. The monochrome base is the system; light and dark are two values of the surface token, and Part 2 defines both.

The Founder also withdrew their own supporting argument ("evening work with reports") on the same ground the original claim failed: it supports *matching the ambient light*, which is a personal preference, not a property of the product. Recorded because a decision is only as good as the arguments left standing under it.

## Why not two independent systems

Rejected for the reason that applies to any duplicated decision in this codebase, and the same one ADR-039 records for access checks: **they diverge, and the fix applied to one silently never reaches the other.** Shared tokens are what stop that. What the terminal gets is a different *surface* on a shared foundation — not a second design system with its own spacing scale, its own type scale and its own slow drift.

---

# PART 2 — THE VISUAL LAYER

**Status: written.** Part 1 decides what a screen means; this decides what it looks like. Nothing here may contradict Part 1 — where it seems to need to, Part 1 was wrong and gets revised explicitly.

## The standard every value here meets

**Measured, or it does not exist.** Founder's requirement, and the same standard `CLAUDE.md` applies to tests: a test that would pass against a wrong implementation proves nothing, and a colour that "looks like enough contrast" is decoration of the same kind. Every value below carries its measured ratio against the ground it actually sits on. WCAG 2.1 AA — 4.5:1 for text — is the floor, not the target.

The standard earned its place immediately. The first neutral ramp drafted for this section put muted text at `#7A756D`, which looks unmistakably like readable grey and measures **4.38:1** — under the floor. Corrected to `#726D64` (**4.92:1**) before anything was written down. Judged by eye it would have shipped.

## Why this was transcribed in full before anything consumed it

**A document turned into code starts arguing back.**

That sentence is the real justification for writing the whole token layer — every ramp step, both surfaces, the complete type scale — before a single screen used a third of it. The usual argument is "otherwise the design system gets authored by its first screen," which is true but abstract. The concrete version is what actually happened on the day of transcription: turning these tables into `tokens.css` and `tokens.contrast.spec.ts` produced **three objections to this document that no amount of re-reading it would have raised.**

- The Hierarchy Law's constant was **0.62**, rounded down from the pair it was derived from — so the rule forbade its own example, since 30 ÷ 48 = 0.625. Invisible in prose; a failing assertion on the first run.
- `--rule` on light was given as `#D8D5CF`, **a value that was not on the ramp at all.** The table read fine. Making the ramp the single source made the gap immediate.
- Light could only be inherited from `:root`, never pinned on a subtree — found by *rendering* the specimen on a dark machine, where the card meant to demonstrate the light default came out dark.

None of the three is a typo. Each is a place where prose was internally inconsistent in a way prose cannot show. Executable form is not a nicety here; it is the review pass this document could not perform on itself.

## Surfaces — the Portal is dark, and there is no light Portal (ADR-072)

**Superseded 2026-09-04.** Everything below this heading was rewritten when the Founder replaced the palette. The reasoning that was withdrawn is kept above, under *The Portal's surface*, marked rather than deleted — a decision is only readable if the argument it replaced is still there.

| Surface | Ground | Why |
|---|---|---|
| **Portal** | `#161615` | The only Portal appearance. Not a default with a preference behind it — one surface set, always. |
| **Terminal** | `#FFFFFF` | Unchanged. Pure white for maximum luminance on a screen that may be read on a terrace in July. Chosen on legibility, and that reason did not change when the Portal did. |
| Print and export | — | The only other light surfaces this product will have. **Not defined yet**, deliberately: nothing prints, and a token set with no consumer is what later drifts from reality. It arrives with the first such screen. |

**The Portal's ladder — four surfaces, deepening as things stack:**

```
#161615   ground
#1E1E1C   --surface
#262624   --surface-2
#30302D   --surface-3   ← the deepest surface text can land on
```

### The floor is measured from the deepest surface, not from the ground

**Every text value must clear 4.5:1 against `#30302D`, not against `#161615`.** This is the rule that changed, and it is the one worth understanding: measuring against the ground certifies a value that fails on the very card it is most likely to be used in. A muted grey that reads perfectly on the page background can be unreadable inside a raised panel three levels up, and nothing would have caught it.

| Token | Value | On ground | **On `#30302D`** |
|---|---|---|---|
| `--text` | `#EFECE4` | 15.34 | **11.21** |
| `--text-muted` | `#BDBAB1` | 9.33 | **6.82** |
| `--text-faint` | `#9E9B94` | 6.53 | **4.77** |
| `--rule` | `#3C3C38` | 1.63 | — |

The enforcement checks every text level against **every** surface, not only the deepest, so the binding measurement is whichever is hardest — and a value that passes on the ground and fails deeper breaks the suite. That was verified by substituting such a value and watching it fail, not by reading the test.

### There is no fourth text level, and there will not be

`--text-faint` clears the floor at **4.77** — by **0.27**. A fourth level would have to fit between that and 4.5 itself. Anything in that band differs from `--text-faint` by less than a third of a ratio point: **one token with a typo, not two roles.**

The 0.27 is asserted, not described. If the deepest surface were ever lightened the headroom would grow, the assertion would fail, and this decision would have to be re-read rather than quietly reversed.

## The neutral ramp — the terminal's material only

Warm-neutral, and now trimmed to the five steps the terminal actually uses. The other eight served the light Portal, which no longer exists; a ramp step nobody points at is a value with no measurement behind it.

```
n-0   #FFFFFF     n-500 #726D64
n-50  #F4F3F0     n-600 #5C5852
n-100 #ECEBE7     n-950 #0F0E0C
```

| Token | Terminal | Measured |
|---|---|---|
| `--text` | `#0F0E0C` | 19.29 on ground |
| `--text-muted` | `#726D64` | 5.14 on ground · **4.63 on `--surface`** |
| `--text-faint` | `#5C5852` | 7.06 on ground · 6.37 on `--surface` |
| `--rule` | `#ECEBE7` | 1.19 |

**The terminal has no deeper surfaces, and that is a decision.** It is a single-purpose payment screen: one amount, one action, nothing stacked three levels down. `--surface-2` and `--surface-3` are pinned to `--surface` there so nothing inside a terminal can inherit a Portal-dark value.

**One measured warning for whoever adds a third terminal surface:** `--text-muted` clears the floor on `#F4F3F0` by only **0.13**, and on the next step down (`#ECEBE7`) it measures **4.31 and fails**. A third terminal surface requires moving `#726D64` to `#5C5852` in the same change.

## Accent — one value, and one ink that may sit on it

**`#FFE500`. One value, on every surface.** The amber is abolished entirely — not deprecated, not kept as an alternate.

| | Measured |
|---|---|
| Accent on the Portal ground | **14.19** |
| Accent on `#30302D` | **10.38** |
| `--on-accent` (`#161615`) on the accent fill | **14.19** |
| `--text` (`#EFECE4`) on the accent fill | **1.08 — invisible** |

**Text on an accent fill is `#161615` and nothing else.** `#EFECE4` on `#FFE500` measures 1.08 — that is not "low contrast", it is not there. The rule is enforced **by ratio rather than by equality**, so any wrong value fails, not only the light one that prompted it. The 1.08 is itself asserted, because someone will eventually propose light text on the yellow for looking calmer, and a number ends that conversation without an argument.

**The accent still never carries importance and never touches a money figure.** That rule is in Part 1 and it outlived the palette: it was never about which colour.

**One measurement that has no answer yet.** On the terminal's white ground the accent fill measures **1.28** — the pay button's own text is fine at 14.19, but its *boundary* against the page is not, and WCAG asks 3:1 for a control's edge. Recorded rather than solved: no terminal screen exists, and inventing a border token for a button nobody has drawn is how a token layer starts being authored by an imaginary screen.

### The five-value branding palette no longer describes this

`accent-palette.ts` still holds five verified values with a light/dark pair each, for the restaurant-branding candidate (`MASTERPLAN.md`, ADR-039). **Its whole shape assumes two Portal appearances, and its default is the abolished amber.** It is left in place — that feature has not shipped and this change's axis was tokens — but it governs nothing today, and the test suite asserts the disconnection so nobody reads it as if it still did.

The hue exclusion it encodes survives on its own merits: no green and no red at any lightness, because an accent colliding with `--success` or `--error` makes *press this* and *this worked* indistinguishable on the terminal, where a guest gets ten seconds.

## Semantic colour — reserved, never customisable

| | Value | On ground | On `#30302D` |
|---|---|---|---|
| `--success` | `#7BD68F` | 10.22 | 7.47 |
| `--error` | `#FF8A7A` | 7.91 | 5.78 |

**There is still no warning colour, and that rule outlived the palette change** — which is the test of whether it was ever about colour. The two places one would be reached for are both places Part 1 explicitly forbids alarming: the platform-fee caption (a routine, permanent, correct fact — *The Caption Problem*) and an empty dashboard (*The Mirror Risk*). A system that owns the token will use it in exactly those two places within a month.

States that are neither success nor failure — "under review", "requirements outstanding", "nothing yet today" — are carried by **words and position**, in neutral. That is Part 1's explanation-over-suppression rule expressed in the palette.

**These tokens are enforced, not merely written down.** `apps/frontend/src/styles/tokens.contrast.spec.ts` re-derives every ratio on this page from `tokens.css` itself and fails on drift — a text value that passes on the ground and fails deeper, light text on the accent fill, a fourth text level, a `--warning` token appearing, a re-ordered surface ladder that would make "deepest" a lie, or the terminal being scoped somewhere it could be repainted.

## Type

**IBM Plex Sans**, with **IBM Plex Mono** for identifiers — ledger references, transaction ids, invitation tokens. Chosen for one specific reason rather than for character: its numerals are unambiguous and `1`/`l`/`7` do not collide. That matters more here than in most products, because our figures get read aloud, compared against a bank statement, and typed into someone else's system. Plex Mono is not decoration either: an id is a string to be copied exactly, and a monospaced face is what makes a transposition visible.

**`font-variant-numeric: tabular-nums` on every figure.** Non-negotiable — proportional digits make a column of money jitter as values change, and it is the most common typographic mistake in financial interfaces.

| Role | Size | Weight | Tracking |
|---|---|---|---|
| Hero figure (rank 1) | 48px | 700 | −0.03em |
| Hero secondary | 30px | 600 | −0.02em |
| Section title | 20px | 600 | −0.01em |
| Body | 16px | 400 | 0 |
| Small | 14px | 400 | 0 |
| Label / caption | 12px | 500 | +0.12em, uppercase |
| Micro | 11px | 500 | +0.10em |

**Terminal overrides:** bill amount 56px, primary action label 18px, tip options 18px. A stranger at arm's length is not reading a dashboard.

**The Hierarchy Law, made numeric — this is what makes it enforceable rather than advisory:**

- The hero figure is **at least 3× body size**.
- **No other text element on that screen may exceed 0.625× the hero** (48 → 30). A second element at rank 1 becomes arithmetically impossible, which is the point: "make it bigger" is not a specification, and a review can now fail on a number.

**Corrected during transcription, and worth recording as an example of why the rule is a test.** This constant was first written as **0.62**, rounded down from the pair it was derived from — which made the document forbid its own example, since 30 ÷ 48 = 0.625. Nobody reading the prose would have noticed; the test that turns the rule into arithmetic failed on its first run. The document was corrected to match the arithmetic rather than the arithmetic bent to match the prose.

## Spacing, radius, elevation

**4px base.** Scale: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96`. Nothing off the scale.

**Radius:** 8px portal, 12px terminal — larger targets read softer, and the terminal's are larger.

**Elevation carries layering, never importance.** A shadow means something is genuinely above something else — a modal, a menu. Raising a card to make it feel important is the same error as colouring a figure to make it feel important, and *Accent Colour Never Carries Importance* applies unchanged. Size and space rank; nothing else does.

## Density — two, matching the two audiences

| | Portal | Terminal |
|---|---|---|
| Row height | 44px | — |
| Primary action | 40px tall | **≥ 56px tall** |
| Other targets | ≥ 40px | ≥ 48px |
| Card padding | 20–24px | 24px |
| Section gap | 24–32px | 16–24px |

`UX_MAP.md` sets an absolute floor of 44×44 for touch targets. The terminal goes well past it deliberately: the Portal is used by someone who has learned where things are, the terminal by someone who has not and never will.

## Money formatting

Locale-driven, from the Restaurant's own locale, never hardcoded. `DATABASE.md` stores minor units as `BIGINT` (ADR-001) and the API returns strings; the interface decides presentation and never arithmetic. Grouping, decimal separator and symbol placement follow the locale (`1 240,00 €` in `lt-LT`, `€1,240.00` in `en-*`). Always two decimals for EUR, always tabular, and **never abbreviated** — no `€1.2k` anywhere a real amount is meant. Someone reconciling against a bank statement needs the figure, not a summary of it.

---

# What Part 2 Deliberately Leaves Open

- **The accent palette is four alternates, not a final catalogue.** It grows when the branding candidate is actually built, by the same rule: measured against both grounds, no semantic hues, or it does not enter the table.
- **Motion.** Nothing here needs it yet. When it arrives it must respect `prefers-reduced-motion` and carry no meaning not also carried by text or position.
- **Charts beyond the 7-day bar.** `revenueChart` is specified by rank, not by charting library. Anything further waits for a screen that needs it.
- **Illustration and empty-state art.** Part 1 requires four designed states per component; it does not require pictures, and the never-populated state should be attempted in words and layout first.

---

# Review Items

Design work is reviewed against these the same way code is reviewed against `CLAUDE.md`. Each is a question with a factual answer, not a matter of taste:

- **Hierarchy:** does one element clearly win this screen, and is it the one that answers the screen's question?
- **Equal cards:** did this layout collapse into a grid of same-sized boxes?
- **Caption:** does every figure whose meaning is narrower than its label carry that narrowing visibly and permanently, without a tooltip and without warning styling?
- **Four states:** are populated, never-populated, temporarily-empty, and failed each designed — and are the three empty cases distinguishable from one another?
- **Honesty:** does any state achieve calm by withholding or softening a fact?
- **Accent:** remove the accent entirely — does the hierarchy of this screen survive unchanged? If it collapses, colour is carrying weight that size and space should carry.
- **Whose user:** on a customer-facing surface, was any choice here made for consistency with the Portals rather than for a stranger who gets ten seconds and no second chance?
