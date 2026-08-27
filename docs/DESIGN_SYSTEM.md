---
title: DESIGN_SYSTEM
version: 0.1.0
status: Partial — Part 1 (structure, hierarchy, state) complete; Part 2 (palette, typography, density) not yet written
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# DESIGN SYSTEM — PART 1

> "A design system is not a set of colours. It is a set of decisions that stop being re-argued."

---

# What This Document Is, And What It Is Not

`UX_MAP.md` has named this file as one of its foundations since v1.0 and it did not exist. This is the first half of it.

**Part 1 — this document — covers what does not change when the palette changes:** what the product is emotionally for, which element on a screen wins when two compete for attention, how a figure that needs a caveat carries it, and what every component owes its own empty and broken states. These are structural decisions. A different colour scheme, a different typeface, a tighter grid — none of them invalidate a single rule below.

**Part 2 — not yet written — covers palette, typography, spacing scale, density, motion, and elevation.** It will be written on top of this, once the reference folder is complete. Part 2 must not contradict Part 1; where it seems to need to, that is a signal Part 1 was wrong and should be revised explicitly, not quietly worked around.

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
- **Three of the four are dark; one is light. That is not yet a decision.** Dark is defensible here on ergonomics rather than fashion — restaurants are dim, and a bright screen at a service pass is genuinely unpleasant. But it is a Part 2 decision, and it must be made *per surface*, not once for the product (see *One Product, Two Visual Systems*).

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

**The backend already draws this distinction, and the frontend must honour it rather than re-flatten it.** `averageTipBasisPoints` is deliberately `null`, never `"0"`, when there is no revenue — because `0%` is a real, meaningful, *bad* tip rate, and reporting it when nothing has happened is a lie (ADR-026, following ADR-025's precedent). That is the model. **The API already refuses to say "zero" when it means "nothing yet"; the interface must refuse the same way, on every figure, not just the one that happens to be nullable.**

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

**Raised for the Founder's decision, not decided here.**

We have two surfaces with genuinely different physical constraints, and the reference folder addresses only one of them:

- **The Portals** (Restaurant, Waiter) — signed-in, repeat users, sessions of minutes, indoor and usually dim, on a device the user controls. Everything in this document and every reference supplied is about these.
- **The customer payment terminal** — a stranger, ten seconds, one interaction, **possibly in direct sunlight on a terrace**, on a device they have never seen and will never see again. It is also the one surface where a moment's confusion costs an actual payment.

A dark interface in direct sunlight is materially harder to read, and the terminal is the screen least able to afford that. Meanwhile the terminal has no dashboard, no hierarchy problem, and no emotional contract — it has one job and needs maximum legibility and zero ambiguity.

**My recommendation: one shared foundation — spacing scale, type scale, component shapes, motion, and every rule in this document — with the terminal permitted its own surface treatment, decided on legibility rather than on matching the portals.** Sharing tokens keeps them from drifting; forcing one appearance across both optimises the wrong screen for the wrong environment. The alternative — two fully independent systems — is worse: they diverge, and then a fix applied to one silently doesn't reach the other.

This needs deciding before Part 2 fixes a palette, because Part 2's answer differs depending on it.

---

# What Part 2 Must Decide

Recorded so these are answered deliberately rather than settled by whoever writes the first component:

1. **Light or dark, per surface** — pending the decision above.
2. **The accent colour, and its budget.** Every reference rations accent severely. Part 2 should state where accent is permitted (actions, status) and where it is banned (money figures), rather than only naming a hex value.
3. **The numeric typeface, specifically.** This product is read as numbers. Tabular figures are non-negotiable — proportional digits make a column of money jitter and are the single most common typographic mistake in fintech interfaces. Part 2 should name the face and confirm it has a tabular set.
4. **The type scale, anchored to the hero figure.** The Hierarchy Law is only enforceable if the gap between rank 1 and rank 2 is defined numerically; "bigger" is not a specification.
5. **Density.** Related to, and constrained by, the two-surface question: a terminal wants far lower density than a dashboard.
6. **How money is formatted** — currency placement, decimal treatment, and grouping, per locale. `DATABASE.md` stores minor units as `BIGINT` (ADR-001) and the API returns strings; the interface layer decides presentation. Worth settling once, in Part 2, rather than per component.

---

# Review Items

Design work is reviewed against these the same way code is reviewed against `CLAUDE.md`. Each is a question with a factual answer, not a matter of taste:

- **Hierarchy:** does one element clearly win this screen, and is it the one that answers the screen's question?
- **Equal cards:** did this layout collapse into a grid of same-sized boxes?
- **Caption:** does every figure whose meaning is narrower than its label carry that narrowing visibly and permanently, without a tooltip and without warning styling?
- **Four states:** are populated, never-populated, temporarily-empty, and failed each designed — and are the three empty cases distinguishable from one another?
- **Honesty:** does any state achieve calm by withholding or softening a fact?
- **Accent:** is accent colour carrying importance that size and space should be carrying instead?
