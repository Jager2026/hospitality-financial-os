---
title: MASTERPLAN
subtitle: Hospitality Financial Operating System
version: 2.4.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
repository: Hospitality Operating System
supersedes: MASTERPLAN v1.0 — see ARCHITECTURE_DECISIONS.md for the reasoning behind every structural change below
---

This document is the single source of truth for product scope, vision, and business philosophy.
`ARCHITECTURE_DECISIONS.md` is the single source of truth for *how* the architecture implements that scope.
If any documentation contradicts this document on scope, MASTERPLAN.md takes precedence. If any documentation contradicts ARCHITECTURE_DECISIONS.md on architecture, the ADR takes precedence.

---

# MASTERPLAN

*"We are not building software.*
*We are building financial infrastructure for the hospitality industry."*

---

# Table of Contents

1. Document Hierarchy
2. Founder Letter
3. Executive Summary
4. The Opportunity
5. The Problem
6. Why Existing Solutions Fail
7. Our Solution
8. Product Vision
9. Product Positioning & Restaurant Value Proposition
10. Company Philosophy
11. Product Philosophy
12. Business Philosophy
13. Technical Philosophy
14. MVP
15. Future Vision
16. Engineering Principles
17. AI Governance
18. Success Metrics
19. Long-Term Mission

---

# Document Hierarchy

Two other documents in this project describe a broader long-term vision: an internal business-concept document (POS fleet management, supplier network, investment products, corporate structure) and an earlier CTO Operating Manual. Both remain valid as long-term vision and Phase 3–5 reference material. **Neither defines current scope.** This document's own MVP Definition and Out-of-Scope sections are the only authoritative statement of what is being built right now. Where the two ever disagree, this document wins.

The former CTO Operating Manual has been retired (ADR-011): its content is merged into `CLAUDE_RULES.md`, the single canonical source for how the AI Technical Co-Founder operates. This document's own AI-related chapter has been trimmed accordingly — see "AI Governance" below.

---

# Founder Letter

Every successful company begins with a simple observation.

Someone notices a problem.

Not a feature.

Not an opportunity.

A problem.

This company exists because hospitality businesses spend too much time managing technology instead of serving people.

Restaurants purchase software to simplify operations.

Instead they receive:

Multiple subscriptions.
Disconnected systems.
Complicated integrations.
Manual accounting.
Complex payment flows.
Scattered analytics.
Poor reporting.
Expensive infrastructure.

Technology became another operational burden.

That should never have happened.

Hospitality should be about people.

About experiences.

About memories.

About conversations.

Not software.

This company exists to restore that balance.

Technology should disappear into the background.

Hospitality should remain at the center.

Everything we build should move the industry toward that future.

---

# Executive Summary

Hospitality Operating System is a financial technology platform built specifically for **restaurants, cafés, and bars** — table-service businesses where a customer pays a bill and may leave a tip.

Hotels, and other hospitality formats with materially different operational models — room folios, front-desk billing, PMS integration, housekeeping/concierge service norms rather than table service — are part of the long-term vision, not this document's scope. Supporting them well requires additional entities (property, room, folio) that don't exist in this architecture yet. This is a deliberate scope decision, not an oversight: attempting both models at once would compromise the depth of either.

Unlike traditional restaurant software, we are not solving one isolated problem. We are creating an ecosystem.

Our platform begins with a simple payment experience. Over time it evolves into the financial operating system of the hospitality industry.

The platform will connect:

Guests.
Restaurants.
Employees.
Suppliers.
Payment providers.
Banks.
Accounting systems.
Artificial Intelligence.
Marketing.
Embedded finance.

Everything becomes connected.

Everything becomes intelligent.

Everything becomes simple.

---

# Our Mission

Our mission is to eliminate operational friction from hospitality through intelligent financial infrastructure.

Every feature.

Every API.

Every service.

Every workflow.

Should remove complexity instead of adding it.

We are not creating more software.

We are removing unnecessary software.

---

# The Opportunity

Hospitality represents one of the largest industries in the world.

Millions of businesses.

Billions of transactions.

Trillions in annual revenue.

Yet many hospitality businesses still operate using fragmented technology stacks.

Restaurant owners often manage:

Payment terminals.
POS systems.
Payroll.
Accounting.
Reservation software.
Marketing platforms.
Loyalty systems.
Inventory software.
Supplier portals.
Banking applications.

Each product solves one problem.

None solve the whole business.

The future belongs to integrated ecosystems.

---

# The Problem

Today's restaurant workflow often looks like this:

Guest arrives.
↓
Orders food.
↓
Receives bill.
↓
Payment terminal.
↓
Separate tip process.
↓
Separate accounting.
↓
Separate payroll.
↓
Separate reporting.
↓
Separate banking.
↓
Manual reconciliation.
↓
Manual tax calculations.
↓
Manual exports.
↓
Lost time.
↓
Higher costs.
↓
More mistakes.

Every step introduces unnecessary friction.

Restaurants deserve better.

---

# Why Existing Solutions Fail

Existing platforms focus on isolated functions.

Some specialize in payments.

Others specialize in POS.

Others provide analytics.

Others handle reservations.

Others focus on loyalty.

As businesses grow, complexity grows with them.

Instead of one platform...

Restaurants end up managing ten.

The result is:

More subscriptions.
More integrations.
More maintenance.
More employee training.
More operational risk.

We reject this model.

---

# Our Solution

Instead of building another hospitality application...

We are building hospitality infrastructure.

The first version focuses on one critical experience:

Fast payments.
Digital tipping.
Restaurant dashboard.
Waiter wallet.

Everything else grows from that foundation.

Each new module strengthens the ecosystem.

Nothing exists in isolation.

---

# Product Vision

Imagine entering any restaurant.

You finish your meal.

The waiter brings the payment terminal.

You tap your card.

Before payment completes, the terminal asks:

"Would you like to leave a tip?"

You choose:

10%
15%
20%
Custom Amount

Payment completes in seconds.

Receipt appears instantly.

The restaurant immediately records revenue.

The waiter immediately receives a virtual tip balance.

The owner instantly sees updated analytics.

No paperwork.

No manual calculations.

No reconciliation.

Everything simply works.

That is Version One.

---

# Business Philosophy

Businesses do not buy software.

They buy outcomes.

Restaurant owners do not wake up thinking:

"I need another dashboard."

They wake up thinking:

"I need more customers."
"I need higher profits."
"I need fewer mistakes."
"I need my employees to work faster."
"I need to spend less time solving operational problems."

Software is simply a tool.

Therefore every feature we build must answer one question:

**Which business problem disappears because this feature exists?**

If we cannot answer that question clearly...

The feature should not be built.

---

# Our Core Belief

Restaurants should not need to become technology companies.

Technology companies should build technology so good that restaurants barely notice it.

Our software should disappear into daily operations.

Hospitality remains visible.

Technology becomes invisible.

---

# Product Philosophy

We reject feature-driven development.

We embrace problem-driven development.

Adding features is easy.

Removing friction is difficult.

Our competitive advantage will never be:

The biggest feature list.

Instead it will be:

The smallest amount of friction.

---

# Every Feature Must

Reduce clicks.
Reduce waiting.
Reduce mistakes.
Reduce employee training.
Reduce operational costs.
Reduce management effort.
Reduce stress.
Increase confidence.
Increase transparency.
Increase trust.
Increase speed.
Increase profitability.

If a feature cannot achieve at least one of these objectives...

It should not exist.

---

# Simplicity Wins

Complexity naturally grows.

Simplicity requires discipline.

When two solutions solve the same problem...

Choose the simpler one.

Always.

Simple software:

Scales easier.
Costs less.
Contains fewer bugs.
Requires less support.
Creates happier customers.

Complexity should exist only inside the engineering layer.

Never inside the user experience.

---

# Our Competitive Position

Many companies solve hospitality problems.

Toast. Lightspeed. Square. SumUp. Stripe. Oracle Micros. Clover.

Each of them is excellent in its own category.

We are not trying to replace them overnight.

Instead...

We are building something different.

---

# What Makes Us Different

Others build products. We build infrastructure.

Others optimize individual workflows. We optimize the movement of money.

Others stop after payment. We begin with payment.

Our long-term vision extends far beyond accepting cards.

Payments become the foundation.

Financial infrastructure becomes the destination.

---

# Product Positioning & Restaurant Value Proposition

**This is a strategic specification, not marketing copy.** It exists so that sales material, pitch decks and screen copy are derived from one agreed set of claims rather than invented per conversation. **Nothing here is written to persuade.** Where a statement cannot currently be supported, it is labelled a hypothesis and says what would settle it.

---

## Core positioning

> **"You don't need another payment system.
> You need to know where every euro goes."**

---

## Business model

**Model B — the tip belongs to the waiter — is the single target model.** Not one of two supported modes: the target.

**The "two payout modes" hypothesis is CLOSED, not deferred.** The product will not offer a restaurant a choice between tips settling to the venue and tips settling to the individual. Two modes would mean two tax positions, two reconciliation paths, two support stories and two versions of every screen that shows a tip — permanently, and for a distinction the customer never asked for. **Closed as a decision. This is the first document to record it: no canonical document previously carried the hypothesis, so its closure is recorded here rather than struck from somewhere else.**

**Model A is the current state of the implementation and is to be replaced.** It is not a fallback and not a rejected alternative — it is what can be built and put in front of a real restaurant while the question gating B is answered by people who are not us. Its full reasoning, and what specifically blocks B, are in **ADR-053**.

**The consequence for positioning: no external material may describe Model A as the product.** It is the bootstrap the pilot runs on.

---

## Value to the restaurant

**The order below is deliberate and is itself part of the specification.** It is ordered by defensibility, not by how well each item demonstrates. Material derived from this section must not promote items 6-8 above items 1-2 — that is the order in which every competitor already describes itself.

### Tier 1 — what competitors do not have

**1. Trust layer: the restaurant and the waiter read one financial history.**

Immutable double-entry accounting; attribution through Membership rather than through a name typed on a screen; projections rebuilt from the entries rather than stored and hoped to match. **Auditable and deterministic** — a balance can be recomputed from scratch and must land on the same number.

**Qualification, and it belongs in the specification rather than a footnote: this is a lead in time, not a barrier to entry.** Double-entry accounting is well understood and copyable by any competent team. What is expensive to copy is not the ledger — it is the ledger *wired into* refunds, disputes and payouts, so that a reversal months later lands correctly in both parties' view of the same history. **The advantage is the wiring, and the lead is measured in engineering months, not in structural protection.** Any claim of a durable moat here is unsupported.

**2. Tips by name.** Not a shared pool divided afterwards, but a specific waiter, fixed at the moment of payment — and paid at once, with no holding period. **A refund returns the bill; the tip stays with the waiter** (ADR-062). That is industry practice, not something this product invents, and it is why no withdrawal window exists. The person recorded is whoever was selected as having served the table — which may be a Manager or the Owner, not only someone holding a Waiter role.

### Tier 2 — strong, and reproducible by a competitor

**3. Automatic reconciliation** of payments, bills, tips, commissions, refunds and payouts.

**4. Transparency for staff** — both sides look into one system, rather than the venue holding the record and the waiter holding a belief.

**5. Payout administration.**

### Tier 3 — parity with the market, not differentiation

**6. Modern terminals and instructions for using them.**

**7. Refunds that work.**

**8. Support during the restaurant's own working hours** — subject to the SLA section below, which is currently undefined.

**These three are table stakes.** They must be true, and none of them is a reason to switch.

---

## Taxes — a hypothesis, not a promise

**The permitted formulation is exactly this, and no stronger:**

> **"as much of the payout and tax administration as legally and technically possible."**

**Until there is a written answer from VMI, tax handling is not marketed as automated.** Not "automatic tax", not "we handle the tax", not "compliant by default". The verbs carry more risk than the nouns: *administers* is defensible, *automates* is not.

**Why this is a hard boundary rather than caution.** For Model A the position is settled — tips distributed by the employer are employment income and the restaurant is the tax agent. **For Model B nobody has an answer**, including us (ADR-053). A claim of automated tax handling made before that answer would be a claim about Lithuanian tax law made by a company that has not obtained one.

---

## Switching cost — the central GTM constraint

**A restaurant's terminal is tied to its acquirer.** Connecting to this platform requires moving to compatible payment infrastructure.

**Integration with a restaurant's existing third-party terminals has not been established as possible, and no pitch may rest on it.** Not "not yet built" — *not established*. Until it is demonstrated against a real device and a real acquirer, any material implying a venue can keep its current terminal is claiming something unverified.

**This is the primary obstacle to sales, not a footnote.** It is the first question a solvent, interested restaurant will ask, and the honest answer costs the deal more often than any feature gap will. Every go-to-market plan derived from this document must state how it handles that answer, rather than discovering it in the first meeting.

---

## Pilot limitations — what cannot be promised

**None of the following may appear in pilot material, in any softened form.**

- **Reconciliation against the till DOES NOT WORK. There is no POS integration.** The complaint *"the X/Z reports do not add up"* is **not solved by the pilot** — and it is exactly the pain a hospitality buyer will assume this product addresses. It must be ruled out explicitly rather than left unmentioned.
- **Compatible payment infrastructure is mandatory** (see Switching cost).
- **Withdrawal does not exist.** A waiter cannot take money out. Balances are visible and uncashable.
- **The Waiter Portal is not built.**
- **A refund and dispute procedure must exist before a live pilot.** The mechanism partly exists; the operational procedure does not.
- **Waiter onboarding and KYC must be defined before Model B launches**, and are not.

---

## Support SLA

**SLA IS NOT DEFINED.**

No hours and no target response time have been set by the Founder, so none is recorded here.

**This is written as an absence on purpose.** A vague formulation — "responsive support", "we are there when you need us" — reads as a guarantee in a pitch and is then measured against whatever the reader imagined. **An undefined SLA stated plainly is honest; a soft one is a promise nobody agreed to make.** No support commitment may appear in external material until this section carries numbers.

**Two figures are needed to close this section:**

1. **Support hours** — specific, and aligned to the restaurant's operating window rather than to office hours.
2. **Target response time** within those hours.

**Scaling threshold: ALSO NOT DEFINED.** The number of venues up to which founder-led support remains feasible has not been established. It is required, because it is the point at which either support quality falls or hiring must already have happened — and both are decisions that must be made before the threshold arrives rather than at it.

---

## Open questions — Model B

**Three architectural questions with no answer. They block design, not merely implementation** — each changes the shape of what gets built rather than the order it gets built in.

**1. When does a waiter complete onboarding — at invitation, or later?**
At invitation, every new hire faces an identity check before their first shift, and a venue short-staffed on a Friday feels that immediately. Later, the platform holds money for a person who is not yet verified — which is question 2.

**2. What happens to tips earned before KYC is complete?**
They exist, they are attributable, and they cannot be paid out. Whether they accrue against the person, are held by the venue, or are refused at the point of payment is undecided, and each answer produces a different Ledger shape.

**3. One waiter working at two restaurants — one Stripe account or two?**
One account is a single identity across employers with one payout stream; two are separate relationships that never merge. This is not only technical: it decides whether that person's earnings across two employers are ever visible as one figure, and to whom.

**None of these is answered by ADR-053**, which settles who owns the tip, not how the recipient comes to exist.

---

# The Financial Network

Every business depends on money moving efficiently.

Today: Customer → Restaurant → Bank → Accounting → Payroll → Suppliers → Marketing → Taxes → Reports → More software

Tomorrow: Customer → Hospitality OS → Restaurant → Waiter → Supplier → Accounting → Analytics → AI → Marketing

Everything connected.

---

# Why We Start With Tips

Some people may believe this is a tip application.

It is not.

Digital tipping is our entry point.

Why? Because it naturally places us inside the payment flow.

Once payment infrastructure exists...

Everything else becomes easier: Analytics. Accounting. Payroll. Supplier payments. Financial services. Artificial Intelligence.

Digital tipping is not the business.

It is the beginning of the ecosystem.

---

# Our Long-Term Product

Imagine one platform where a restaurant owner can:

Accept payments. Track revenue. Manage employees. View analytics. Pay suppliers. Run marketing campaigns. Analyze customer behavior. Receive AI recommendations. Forecast demand. Generate accounting reports. Manage taxes. Monitor multiple locations. Receive financing. Purchase inventory.

Everything. Inside one ecosystem. No integrations. No duplicated data. No manual exports.

---

# Product Principles

Every module should satisfy six principles.

1. Solve one meaningful problem extremely well.
2. Integrate naturally with existing modules.
3. Require almost no learning.
4. Generate measurable value.
5. Remain globally scalable.
6. Be invisible whenever possible.

---

# Customer Experience

Our customer experience should feel effortless.

The best compliment a customer can give is: "I didn't have to think."

Guests should never wonder: Where do I click? What happens next? Why is this slow? Why does this require registration?

Instead, everything should feel natural.

---

# Registration Philosophy

The less information required, the better.

For customers paying a bill: No account. No password. No registration. No application download. No unnecessary questions.

Pay. Leave a tip. Receive receipt. Done.

The faster we finish, the happier the customer.

---

# Restaurant Philosophy

Restaurant owners are extremely busy. Therefore:

Configuration should take minutes, not days.

Onboarding should require almost no training.

Every dashboard should answer questions immediately.

Reports should explain themselves.

Owners should spend more time running restaurants. Less time learning software.

**For owners of more than one location:** the Restaurant Portal includes a lightweight switcher between locations (technically, an Organization owning multiple Restaurants — ADR-005). A single-location owner never sees this concept; it only appears once a second location exists.

---

# Employee Philosophy

Employees should not fear technology. Good software reduces stress.

Waiters should instantly understand: Current earnings. Today's tips. Payment history. Withdrawal availability. Performance.

No spreadsheets. No manual calculations. No uncertainty.

*A note on language:* the data model's technical name for a person's role at a restaurant is `Membership` (ADR-005) — this is an engineering term for the database, not a change to how the product talks to people. To an owner, a manager, or a waiter, they are still "your team," "your manager," "your waiter." Nothing about this document's user-facing language changes.

---

# AI Philosophy

Artificial Intelligence should never replace hospitality. AI exists to support decisions. Not make decisions.

Examples: Recommend promotions. Detect unusual activity. Forecast busy hours. Estimate staffing needs. Suggest menu improvements. Predict revenue. Highlight business risks.

AI should quietly improve operations without disrupting them.

---

# What We Refuse To Build

We refuse to build features because competitors have them.

We refuse unnecessary settings.

We refuse interface clutter.

We refuse engineering shortcuts that compromise quality.

We refuse technical debt without documentation.

We refuse sacrificing trust for rapid growth.

Long-term reputation always wins.

---

# Our Definition of Success

Success is not measured by: Funding. Valuation. Downloads. Press coverage. Awards.

Success is measured by: Restaurant owners recommending the platform. Employees trusting the platform. Guests enjoying the payment experience. Developers enjoying the architecture. Partners trusting our infrastructure.

If trust increases, everything else follows.

---

# MVP Definition

> "A successful MVP is not the smallest product you can build. It is the smallest product capable of proving the business."

## Purpose of the MVP

The purpose of Version 1 is **NOT** to build a complete restaurant operating system. It is **NOT** to compete with Toast. It is **NOT** to replace Stripe. It is **NOT** to support every restaurant workflow.

We need to validate five assumptions:

1. Restaurants are willing to adopt our payment flow.
2. Customers willingly leave digital tips.
3. Waiters value a digital wallet.
4. Restaurant owners see measurable operational benefits.
5. The payment infrastructure can become the foundation of a much larger ecosystem.

If these five assumptions are validated, the company has permission to continue building. Everything else comes later.

## MVP Principles

1. Build the minimum amount of software.
2. Deliver maximum customer value.
3. Avoid unnecessary architecture.
4. Never compromise security.
5. Every feature must be measurable.
6. Every module must support future expansion.

## Core Product

The MVP contains only six major modules:

Restaurant Portal → Staff Portal → Customer Payment → Digital Tips → Wallet → Dashboard

Nothing else.

### Restaurant Portal

The owner should be able to: Create an account → Create a restaurant → Configure restaurant information → Configure tipping percentages → Invite employees → View dashboard → View transactions → View reports.

Onboarding should take less than fifteen minutes. For owners with more than one location, adding a second restaurant offers to attach it to the existing Organization rather than starting over (ADR-005).

### Staff Portal

Every waiter receives an account. The waiter can: Login → View today's earnings → View total tips → View transaction history → View payment history → View wallet balance → Request withdrawal (future).

The interface should require almost no training.

### Customer Payment Experience

The customer receives the payment terminal → Terminal displays bill amount → System asks "Would you like to leave a tip?" → Available options: 10% / 15% / 20% / Custom → Customer confirms → Total amount displayed → Card payment → Receipt → Finished.

Payment should feel natural. Never complicated.

### Digital Tips

Digital tips are our first financial product. Every successful payment generates: Restaurant revenue → Waiter tip allocation → Transaction log → Analytics update → Dashboard update → Reporting update.

The waiter should never wonder "Did I receive my tip?" Everything should happen automatically. (For the technical mechanism, see DATABASE.md and ADR-007 — the product experience described here does not change regardless of which allocation strategy runs underneath.)

### Wallet

The wallet is not a bank account. It is a digital balance representing available earnings.

The wallet stores: Current Balance. Pending Balance. Transaction History. Tip History. Daily Earnings. Monthly Earnings. Future Withdrawals.

Future versions may introduce: Instant payouts. Bank transfers. Cards. Multi-currency.

### Owner Dashboard

The dashboard answers one question: How is my business performing today? Without opening multiple reports.

The first screen should display: Today's Revenue. Today's Tips. Average Tip %. Transactions. Staff Earnings. Payment Success Rate. Top Employees. Recent Activity.

Nothing more. Complex dashboards create confusion.

### Analytics

Version One analytics should remain intentionally simple: Revenue Today. Revenue This Week. Revenue This Month. Average Bill. Average Tip. Tip Distribution. Payment Success Rate. Daily Transactions. Employee Performance.

No advanced BI. No AI predictions. No forecasting. That belongs later.

### Administration

Owners can: Add employees. Deactivate employees. Edit restaurant profile. Configure tips. Manage permissions. View activity. Export reports.

Nothing more. Administration should remain lightweight.

### Authentication

Two authentication flows exist.

Restaurant Users: Email → Password → 2FA (future)

Customer: No registration → No account → No password → Card payment only

Reducing customer friction is a product priority.

### Receipts

Every successful payment produces: Digital receipt → Restaurant copy → Financial log → Audit record → Analytics event.

Receipts should always remain accessible.

## Out Of Scope

The following features are intentionally excluded:

QR Ordering. Menu Management. Kitchen Display. Reservations. Inventory. Supplier Marketplace. Marketing Platform. AI Recommendations. Accounting Integrations (two narrow exceptions — see "Pilot-Ready Product" below). Payroll. Invoices. Subscriptions. Financing. Cross-border Payments. Loyalty. Gift Cards. Coupons. Split Bills. Table Management.

**Hotel-specific workflows** — room folios, front-desk billing, PMS integration — are excluded for the same reason: the current model assumes table-service tipping, and hotels need a different operational shape (see Executive Summary).

We are not saying these features are unimportant. We are saying they are **not required to validate the MVP**.

## Pilot-Ready Product — Beyond MVP, Before Phase 2

*(ADR-029)*

The MVP Definition above answers one question: what is the smallest build that tests the five original hypotheses? That is a narrow question, and its answer stays narrow on purpose.

A second, different question — what a real restaurant needs to see before it will actually pay and switch providers — has a slightly broader answer. Both questions are legitimate; conflating them either shrinks the pitch or bloats the MVP. This section keeps them separate.

Two items move from the "Out of Scope" wording to an explicit **Pilot-Ready** tier — narrowly, not the whole "Accounting Integrations" line, which otherwise stays out of scope as written:

**Accountant-ready export.** Every module already produces a Ledger-derived export (Transaction/Analytics CSV, ADR-025/027). Pilot-Ready extends this into a shape an external accountant can actually use — no new financial logic, no accounting software, no filing. This is a decision about the shape of the data, not an expansion of what the Ledger computes.

**Tip tax estimate — display only, never withholding.** By MASTERPLAN's own promise ("the waiter should never wonder how much they're owed"), showing the *gross* tip total without the tax a waiter will actually lose is an unfinished promise, not a kept one. Pilot-Ready therefore includes computing and displaying an estimated tax figure alongside the gross/net tip amounts.

This explicitly **does not include**: actually withholding funds, remitting anything to VMI/Sodra, or the platform (or the restaurant, through the platform) acting as a formal tax agent. That remains Phase 3 ("Automated Accounting. Tax Reporting.") exactly as already written, and requires a formal legal/tax opinion first.

**A blocking dependency, not a development task:** the correct rate, the correct legal basis, and who is actually the tax agent all depend on the waiter's employment-status classification — a question this document cannot answer and code cannot decide on its own. No rate, no bracket, and no computation logic gets implemented until the Founder has a written answer from a Lithuanian tax/payroll consultant. Until then, this item stays flagged, not built — see `THREAT_MODEL.md`, "Open, Not Answered."

### Restaurant branding on the terminal — a Pilot-Ready *candidate*, gated on pilot evidence

**Not committed, and deliberately not built now.** Recorded here with its reasoning so the decision is not re-argued from scratch, and so the one thing it requires of us today actually happens.

**Why the idea is right.** The customer terminal is the only surface a **guest** ever sees — and they see it *inside the interior*. A tablet carrying a visually foreign interface is a foreign object on the table; one that sits in tone with the room reads as part of the restaurant. That distinction is not cosmetic: it changes how much a guest trusts the device being handed to them to take their money, which is a payment-conversion and tip-size question, not a taste question. It is also something the restaurant genuinely wants — they have invested in that interior for years, and every other supplier's hardware ignores it.

**Why the originally proposed mechanism — owner uploads a photo, AI generates a personal design (colours *and* layout), owner accepts or keeps the default — is dangerous in that full form.** Three separate reasons, each sufficient on its own:

1. **It contradicts a rule we have just written, on the worst possible screen.** `DESIGN_SYSTEM.md` establishes that accent colour never carries importance, with the test that removing the accent entirely must leave the hierarchy intact. An arbitrary owner-chosen palette does not honour that rule — and it would be applied to the **terminal**, the one screen where a second of a stranger's confusion costs an actual payment (`DESIGN_SYSTEM.md`, *One Product, Two Visual Systems*).
2. **An AI can extract a palette from a photograph; it cannot extract a composition.** Layout follows from the data and from the Hierarchy Law, not from the room. A feature that promises "a personal design" and delivers "your colours" has a disappointment built into it at the moment of delivery, which is worse than never having offered it.
3. **We have zero screens.** The correct order is one good terminal first, put in front of ten real restaurants, and then listen for whether customisation is asked for at all. It is entirely possible the answer is "put our logo on it" and nothing more — and that is a much cheaper feature than the one being designed around here.

**The decision: constrained customisation with guaranteed legibility.** A logo, **one** accent colour chosen from a palette we have pre-verified for contrast, and a light or dark surface. Not "paste any hex" — a choice among verified options. **The design system stays ours; customisation lives inside its rules rather than on top of them.**

**The AI part survives, as a chooser rather than a generator.** Photograph of the room → extract its palette → propose the nearest accent *from ours*: "this one will suit your room." The same moment of magic for the owner, none of the risk, and roughly a tenth of the implementation.

**The gate:** revisit after the first pilot restaurants have used a real terminal, and only if they ask. This is a demand question, and we do not have the evidence yet.

**What this requires of us now — the only part that is not deferred.** The accent must be **a token from the first line of CSS, never a hardcoded colour**. That is a free decision today and an expensive rewrite later, and it is the single thing that stops this feature from requiring the interface to be rebuilt. Recorded as a binding requirement in `DESIGN_SYSTEM.md` rather than only here.

## User Journey

**Restaurant Owner:** Registers → Creates Restaurant → Invites Staff → Configures Tips → Starts Accepting Payments

**Waiter:** Receives Invitation → Creates Password → Logs In → Receives Tips → Views Wallet

**Customer:** Receives Payment Terminal → Chooses Tip → Pays → Receives Receipt → Leaves Restaurant

## Technology Goals

The MVP should be: Reliable. Fast. Simple. Secure. Maintainable. Scalable. Readable. Developer-friendly.

No unnecessary complexity should be introduced before product-market fit.

## Definition of Success

The MVP succeeds when: A restaurant can onboard itself without assistance. A waiter can receive digital tips automatically. A customer completes payment in less than one minute. The owner understands business performance immediately. The architecture supports future expansion without major rewrites. A refund processes correctly and the Ledger stays balanced (ADR-008).

## What We Learn

The MVP is not the destination. It is an experiment. It should answer questions, not assumptions.

Every customer interaction becomes feedback. Every payment becomes data. Every restaurant becomes a learning opportunity.

The purpose of Version One is to discover what Version Two should become.

---

# Technical Philosophy

> "Architecture is the foundation upon which every future feature will be built."

The quality of our architecture determines the speed of future development. Poor architecture creates technical debt. Great architecture creates leverage.

We are not building software that should survive one year. We are building infrastructure that should continue evolving for decades.

## Architecture Goals

1. Simple enough for a small team.
2. Powerful enough to scale internationally.
3. Modular enough to add new products.
4. Secure enough for financial transactions.
5. Readable enough for future engineers.
6. Independent from specific frameworks whenever possible.

## Architecture Principles

Every component should have one responsibility. Every module should solve one business problem. Every service should expose a clean API. Every dependency should be justified. Every database table should exist because a business entity requires it. Nothing should be built "just in case."

## Monolith First

For the MVP we intentionally choose a Modular Monolith. Not microservices.

Why? Premature distribution creates unnecessary complexity. A modular monolith provides: Fast development. Simple debugging. Easy deployment. Lower infrastructure costs. Simpler testing. Future migration path.

When the business requires microservices, we will already know where natural service boundaries exist. Until then, simplicity wins.

## Technology Stack

**Frontend:** Next.js, TypeScript, TailwindCSS, React Query, React Hook Form, Zod

**Backend:** NestJS, TypeScript, Prisma ORM, REST API, PostgreSQL, Redis

**Authentication:** JWT, Refresh Tokens, Role Based Access Control, Future OAuth

**Infrastructure:** Docker, GitHub Actions, DigitalOcean / Railway (MVP), Cloudflare, S3 Compatible Storage

**Monitoring:** OpenTelemetry, Grafana, Prometheus, Structured Logging, Sentry

**Payments:** Stripe Connect (or equivalent licensed provider). Future providers integrated through an abstraction layer.

## Why TypeScript Everywhere

One language. Entire stack. Frontend. Backend. Shared Types. Reduced bugs. Faster development. Simpler onboarding. Consistency creates velocity.

## Folder Structure

The project follows feature-based organization:

```
apps/
  frontend/
  backend/
packages/
  shared/
  ui/
  config/
  types/
docs/
```

Each business capability remains isolated.

## Business Modules

The core modules are: Organization & Restaurant → Membership → **Ledger** → Payments → Tips → Wallet → **Refunds & Disputes** → Transactions → Dashboard → Analytics.

This updates the v1.0 list (ADR-005, ADR-002, ADR-008) — see SYSTEM_ARCHITECTURE.md for what each module owns and how they depend on each other.

Each module owns: Controllers. Services. Database Models. Validation. Tests. Documentation. Nothing leaks between modules unnecessarily.

## Database Philosophy

The full data model — every entity, field, relationship, and rule — lives in `DATABASE.md`. The short version: the database represents business reality; tables exist because the business requires them, never because code finds them convenient.

## API Philosophy

The full API contract lives in `API_Contract.md`. The short version: APIs describe business actions, not implementation (`POST /restaurants`, not `/createRestaurant`); the API should feel predictable, simple, versioned, documented, consistent.

## Clean Architecture

Business rules should never depend on frameworks. Frameworks change. Business survives.

Presentation → Application → Domain → Infrastructure

The Domain Layer contains the company's knowledge. Everything else serves it.

## Security First

Every endpoint assumes hostile input. Validate everything. Escape everything. Authorize everything. Log everything important. Never trust client data. Never expose internal errors. Never store secrets in code.

Security is part of engineering, not a separate phase.

## Performance Philosophy

Performance is a product feature. Pages should load quickly. Queries should remain optimized. Indexes should exist intentionally. Caching should be measurable.

Avoid premature optimization. Never ignore obvious bottlenecks. Measure, then optimize.

## Error Handling

Every error should answer: What happened? Why did it happen? How can it be fixed?

Users receive friendly messages. Developers receive detailed logs. The two audiences are different. Serve both.

## Logging

Logs exist for engineers, not customers. Every critical business event should be logged: Authentication. Payments. Refunds. Withdrawals. Permission Changes. Restaurant Creation. Employee Invitations.

Logs should never expose sensitive information.

## Testing Strategy

Every feature should include: Unit Tests. Integration Tests. End-to-End Tests (critical flows). Payment Flow Tests. Authorization Tests. Regression Tests.

A feature is not finished until it is tested.

## Documentation Driven Development

Before implementing a feature: Understand the business problem. Review the documentation. Confirm architecture. Discuss trade-offs. Only then write code.

Documentation exists to reduce mistakes, not create bureaucracy.

## AI Development Rules

All AI/engineering behavioral rules — how the AI Technical Co-Founder should think, challenge, and build — live in `CLAUDE_RULES.md` (ADR-011). See that document. This Masterplan no longer restates them.

## Definition of Good Code

Good code is: Readable. Predictable. Maintainable. Secure. Documented. Tested. Extensible. Simple.

Good code should explain itself. Comments should explain intent, not implementation.

## Technical Debt

Technical debt is allowed. Ignoring technical debt is not.

Whenever debt is introduced: Document it. Explain why. Estimate removal cost. Create a follow-up issue.

Technical debt should always be intentional, never accidental.

## Code Review Philosophy

Every Pull Request should answer: Does this solve the correct problem? Can it become simpler? Is it secure? Is it tested? Is it documented? Would another engineer understand it in six months?

If not, continue improving.

## Final Engineering Principle

Every line of code becomes part of the company. Write code that future engineers will thank you for, not code they will need to rewrite.

Architecture compounds, just like interest. Every good decision makes future development faster. Every poor decision makes future development harder. Choose carefully.

---

# AI Governance

> "Artificial Intelligence is not here to replace engineers. It is here to amplify engineering excellence."

Artificial Intelligence is a permanent member of this company, participating in architecture, product design, engineering, documentation, code review, planning, research, and testing.

**All of the substance of this relationship — Claude's role, first principle, when and how to challenge the Founder, what Claude must never do, what Claude should optimize for, the working relationship, the AI review checklist — now lives in one canonical document: `CLAUDE_RULES.md` (ADR-011).**

Before v2.0.0, this content was duplicated across four documents (this Masterplan, the CTO Operating Manual, CLAUDE_RULES, and AI_WORKFLOW) — which is exactly how earlier drafts of these documents ended up describing two different MVPs without anyone noticing. That duplication is now closed. Read `CLAUDE_RULES.md` for the rules. Read `AI_WORKFLOW.md` for the day-to-day process those rules operate inside. This chapter exists only to point there.

---

# PRODUCT ROADMAP

> "Do not build everything. Build the right thing at the right time."

One of the biggest reasons startups fail is not because they build too little. They fail because they build too much.

Every new feature introduces: More code. More bugs. More maintenance. More support. More documentation. More testing. More complexity.

The purpose of this roadmap is to ensure that we build only what the company needs at each stage of growth.

## Product Evolution

The platform will evolve through five major phases:

Phase 1 — Payment Infrastructure
↓
Phase 2 — Restaurant Platform
↓
Phase 3 — Financial Ecosystem
↓
Phase 4 — Hospitality Network
↓
Phase 5 — Global Financial Infrastructure

Each phase validates assumptions before expanding further.

## PHASE ONE — Payment Infrastructure

Mission: Validate product-market fit. The first version should solve one problem exceptionally well: restaurant payments, digital tipping, waiter wallet, owner dashboard. Nothing more.

### Core Modules

Authentication · Organization & Restaurant · Membership · **Ledger** · Payments · Tips · Wallet · **Refunds & Disputes** · Transactions · Dashboard · Analytics · Audit Logs

(Updated from v1.0 per ADR-002, ADR-005, ADR-008 — Ledger and Refunds & Disputes are now explicit core modules, not implicit.)

### Success Criteria

100 successful payments. 1000 successful payments. 10 restaurants. 50 restaurants. 100 waiters. Positive customer feedback. Restaurant owners requesting additional functionality.

Only after these milestones should new modules be considered.

## PHASE TWO — Restaurant Platform

Once payment infrastructure proves valuable, the platform expands.

New capabilities: Menu Management. QR Payments. Table Management. Reservations. Kitchen Dashboard. Notifications. Employee Management. Business Reports. AI Insights. Restaurant Settings. Customer Database. Role Management.

This phase transforms the platform from a payment tool into an operational platform.

## PHASE THREE — Hospitality Financial Ecosystem

Money becomes the center of the ecosystem.

New modules: Supplier Payments. Business Wallets. Restaurant-to-Restaurant Transfers. Invoice Payments. Financial Reports. Automated Accounting. Tax Reporting. Expense Tracking. Multi-Currency. Cross-Border Settlements. Embedded Banking.

This is where our long-term differentiation begins.

## PHASE FOUR — Hospitality Network

The platform becomes a marketplace. Restaurants connect with suppliers. Suppliers connect with restaurants. Customers discover businesses. Marketing becomes integrated.

Capabilities: Supplier Marketplace. Advertising Platform. Restaurant Promotions. Loyalty Platform. Recommendation Engine. Review System. Restaurant Discovery. Business Partnerships. AI Marketing Assistant. Demand Forecasting.

## PHASE FIVE — Financial Infrastructure

The platform evolves beyond hospitality software into financial infrastructure.

Capabilities: International Payments. Embedded Finance. Working Capital. Business Credit. Treasury Services. Investment Products (where legally appropriate). Bank Integrations. Global Settlement. Real-Time Transfers. International Expansion.

At this point the company no longer competes with restaurant software. It competes as financial infrastructure. (This is also where the corporate structure described in the internal business-concept document — Holding / TechCo / PaymentsCo-EMI / Sales / Investment Partner — becomes relevant; see Document Hierarchy above.)

## Development Priorities

Every future feature should satisfy, in order: Customer Value → Business Value → Engineering Simplicity → Security → Scalability → Implementation.

If this order changes, development priorities are incorrect.

## Feature Evaluation Matrix

Before adding a feature ask: Does this solve a real customer problem? Will restaurants actively use it? Does it strengthen the ecosystem? Does it generate measurable value? Can it become a platform capability? Can AI improve it? Can it scale internationally? Does it increase trust?

If most answers are "No," the feature should not be built.

## Things We Intentionally Delay

Cryptocurrency. NFT Loyalty. Investment Products. Restaurant Loans. Supplier Financing. Business Credit Scores. Advertising Marketplace. Recommendation Engine. Inventory Forecasting. Advanced AI Automation. **Tip pooling / shift / percentage-based allocation** — the Ledger and Tip schema are already designed to support these (ADR-007); the allocation logic itself waits for a real restaurant that needs it.

These ideas remain part of our vision. They simply do not belong in the MVP.

## Build Order

Foundation (Auth, Ledger, Outbox, Idempotency, Audit) → Organization & Restaurant → Membership → Payments & Ledger → Tips → Wallet → Transactions → Dashboard → Analytics → Reporting → AI → Marketplace → Financial Network.

Skipping layers creates unnecessary technical debt. See `IMPLEMENTATION_PLAN.md` for the actual sprint-by-sprint sequence — this list shows the *order of layers*, not sprint numbers.

## Long-Term Product Philosophy

The platform should grow horizontally, not vertically. Instead of making one module increasingly complicated, we introduce new independent modules. Each module remains: Simple. Focused. Reusable. Connected.

## Success Definition

The roadmap is not a checklist. It is a guide. Success is solving real problems while maintaining trust, simplicity and engineering excellence. If at any point the roadmap no longer serves customers, the roadmap changes. The mission does not.

## Final Roadmap Principle

Technology evolves. Markets evolve. Customers evolve. The roadmap must remain flexible. Our destination stays constant. The path may change. We adapt. We improve. We continue building. One valuable module at a time.

---

# MONEY FLOW & FINANCIAL INFRASTRUCTURE

> "Money is the bloodstream of the platform. Every transaction must be traceable, secure and intentional."

## Introduction

Our company is not merely processing payments. We are orchestrating the movement of money between participants in the hospitality ecosystem.

The platform must always know: Who owns the money. Where the money currently is. Why it moved. When it moved. Who approved it.

Every movement of funds must be transparent, auditable and reproducible. Money should never "disappear" inside the system.

## The Fundamental Rule

The platform should never hold customer money unless legally licensed and strategically justified. Whenever possible, regulated financial institutions or licensed payment partners should hold customer funds.

Our responsibility is orchestration, not custody. This significantly reduces legal complexity during the early stages of the company.

## Participants

Customer. Restaurant. Waiter. Platform. Payment Processor. Bank. Government (Taxes). Future Supplier. Future Financial Partners.

Each participant has a defined role.

## Payment Journey

Customer → Payment Terminal → Payment Processor → Merchant Account → Settlement → Restaurant → **Ledger Entry** → Tip Allocation → Waiter Wallet → Reporting → Analytics → Audit Log

Every stage generates events. Every event becomes part of the permanent financial history.

## Example Transaction

Restaurant Bill €100. Customer chooses 15% Tip → Tip €15 → Total Charge €115.

Internally, this is never stored as `100.00` or `115.00` — it is stored as `10000` and `11500` minor units (ADR-001), so rounding and percentage math stay exact.

Platform records: Gross Amount. Restaurant Amount. Tip Amount. Fees. Taxes (where applicable). Transaction ID. Timestamp. Waiter ID. Restaurant ID. Settlement Status. Receipt ID.

Nothing should require manual calculation.

## Financial Ledger

Every financial movement creates a Ledger entry. The Ledger is immutable — records are never deleted; corrections are compensating entries. The exact schema (`JournalEntry`, `LedgerLine`, the chart of accounts) is defined in `DATABASE.md` and ADR-002. This section states the *why*; that document states the *what*.

## Waiter Wallet

The wallet represents a virtual balance. It is not a bank account. It stores: Available Balance. Pending Balance. Total Lifetime Tips. Transaction History. Withdrawal History. Adjustment History.

The wallet is a *projection* of the Ledger, not an independently-editable balance (ADR-002, ADR-006) — see `DATABASE.md`. Future functionality may include instant withdrawals, bank transfer, debit card, multiple currencies, international payouts.

## Restaurant Balance

Restaurant revenue belongs to the restaurant. The platform records: Sales. Tips. Refunds. Chargebacks. Processing Fees. Platform Fees. Settlement Status.

Like the Wallet, this is a Ledger-derived projection (`DATABASE.md`). Owners always understand exactly where their money is.

## Platform Revenue

The platform should generate revenue transparently. Potential revenue streams: Platform Subscription. Payment Processing Margin (where applicable). Premium Analytics. Advanced AI Features. Advertising. Supplier Marketplace. Embedded Finance. Financial Services.

No hidden fees. Transparent pricing builds trust.

## Financial Events

Every important event creates a permanent record: Payment Authorized. Payment Captured. Payment Failed. Refund Created. Chargeback Initiated. Tip Added. Tip Reversed. Settlement Completed. Withdrawal Requested. Withdrawal Approved. Restaurant Registered. Employee Added.

These events power analytics, reporting and auditing — delivered via the Transactional Outbox (ADR-003, see SYSTEM_ARCHITECTURE.md).

## Reporting

Every participant sees only what their role requires.

Restaurant Owner: Revenue. Tips. Transactions. Settlements. Employees. Refunds.

Waiter: Today's Tips. Lifetime Tips. Wallet. History.

Platform Administrator: System Health. Payment Volume. Merchant Activity. Fraud Indicators. Operational Metrics.

## Refund Philosophy

Refunds are real from MVP, not future functionality (ADR-008). Every refund must answer: Who requested it? Who approved it? What amount was refunded? Was the tip refunded? Why?

Every refund creates: Financial Event. Ledger Entry (a compensating one — the original is never edited). Audit Log. Customer Notification. Restaurant Notification.

## Chargebacks

Chargebacks are treated as exceptional events. The platform records: Chargeback Status. Reason. Evidence. Timeline. Resolution. Restaurant Impact.

Historical analysis helps reduce future fraud.

## Fraud Prevention

The platform should detect unusual activity: Repeated failed payments. Abnormal refund frequency. Large tip anomalies. Suspicious employee behavior. Repeated payment attempts. Rapid account creation.

AI may recommend investigation. AI should never automatically accuse customers or employees. Humans make final decisions.

## Financial Integrity

Every financial report should reconcile: Ledger → Transactions → Settlement → Wallet → Reports → Analytics.

If numbers disagree, something is wrong. Integrity is mandatory — see `DATABASE.md`'s Financial Integrity section for the exact invariant this checks.

## International Expansion

The architecture should support future expansion: Multiple Countries. Multiple Tax Systems. Multiple Currencies. Multiple Languages. Multiple Payment Providers. Multiple Banking Partners.

Country-specific logic remains isolated. Core business logic remains global (ADR-012).

## Money Movement Principles

Every financial movement must be: Secure. Auditable. Immutable. Transparent. Recoverable. Scalable. Understandable.

There should never be "hidden money."

## Financial Philosophy

Money is not only revenue. Money represents trust. Restaurants trust us. Employees trust us. Customers trust us. That trust is more valuable than any transaction fee.

Every engineering decision involving money must prioritize accuracy over speed. Every decimal matters. Every cent matters. Every transaction matters.

## Final Principle

Our platform should eventually become the financial nervous system of hospitality — not because we move the most money, but because we move it with the greatest transparency, reliability and trust.

Financial infrastructure is built one correct transaction at a time. Never compromise accuracy. Never compromise trust.

---

# DEVELOPMENT STRATEGY

> "Do not build software. Build foundations."

## Introduction

One of the most common startup mistakes is building too much software before validating the business. Another mistake is validating the business with software that cannot evolve.

Every sprint. Every feature. Every module. Must strengthen the future platform. Never weaken it.

## Development Philosophy

Development happens in layers, never randomly, never based on excitement, never because a competitor launched something.

Foundation → Core Platform → Business Validation → Expansion → Optimization → Infrastructure

Skipping layers creates technical debt.

## Layer 1 — Foundation

Nothing customer-facing should be built before the foundation exists.

Foundation includes: Repository. Documentation. Architecture. Development Environment. Authentication. Authorization. Database. **Ledger schema. Transactional Outbox. Idempotency.** CI/CD. Logging. Monitoring. Configuration. Secrets Management. **Audit Logging. Rate Limiting.**

(The bolded items are new relative to v1.0 — ADR-002/003/004/010 moved them here from a later "Security" phase; see `IMPLEMENTATION_PLAN.md` Sprint 1.)

These systems are invisible. But every future feature depends on them.

## Layer 2 — Core Business

Once the foundation exists, the company begins solving business problems.

First modules: Organization & Restaurant. Membership. Payments & Ledger. Tips. Wallet. Transactions. Dashboard. Reports.

These modules define Version One.

## Layer 3 — Validation

Software is useless without users. The goal is not to release. The goal is to learn.

Questions: Do restaurants understand the product? Can onboarding happen without assistance? Do waiters trust digital tips? Do owners understand analytics? Would customers use the payment flow again?

Every answer influences future development.

## Layer 4 — Expansion

Only after validation, never before.

Possible expansion: QR. Reservations. Kitchen. Inventory. Marketing. AI. Supplier Network. Notifications. Loyalty.

Each new module must solve a real problem discovered during validation. Never assumptions.

## Layer 5 — Financial Infrastructure

The final stage transforms the platform: Restaurant → Supplier → Accounting → Taxes → Payments → Credit → International Transfers → Financial Services.

At this stage the platform becomes infrastructure, not software.

## Sprint Philosophy

Every sprint should produce visible value.

The full, current sprint-by-sprint plan lives in `IMPLEMENTATION_PLAN.md`. (An earlier version of this section carried its own illustrative sprint example that no longer matched the real plan — that duplication is removed here; `IMPLEMENTATION_PLAN.md` is the only place sprint numbers live.)

## Definition of Done

A feature is **not** finished when it compiles. A feature is finished only when: Business logic works. Security reviewed. Tests pass. Documentation updated. Edge cases handled. Logging added. Errors handled. Code reviewed. Performance acceptable. Naming consistent. **For any money-moving feature: the Ledger stays balanced (debits = credits) after the change.**

Only then, done.

## Build Once

Whenever solving a problem, ask: Can another module reuse this?

Authentication should never be rewritten. Notifications should never exist twice. Permissions should be centralized. **Money calculations must exist in exactly one place — the Ledger Module (ADR-002).**

Duplication creates bugs. Reuse creates platforms.

## The 80/20 Rule

Twenty percent of the code creates eighty percent of the business value. Focus there: Payment Flow. Tip Distribution. Restaurant Dashboard. Owner Experience.

Do not spend weeks polishing secondary functionality.

## Technical Quality

Never sacrifice architecture for speed. Never sacrifice readability for cleverness. Never sacrifice maintainability for deadlines. The product will live longer than any sprint. Code accordingly.

## Product Quality

Every release should improve one of four things: Speed. Reliability. Trust. Simplicity.

If a release improves none of them, question why it exists.

## Feature Acceptance Checklist

Before implementing: Is there a business reason? Is the problem validated? Does the architecture support it? Can it scale? Can it be tested? Can it be documented? Will customers understand it?

If not, redesign.

## Release Philosophy

Release early. Release safely. Release often. Measure everything. Listen carefully. Improve continuously.

The market becomes part of the development team.

## Failure Philosophy

Mistakes are expected. Hidden mistakes are unacceptable. Every failure should produce: Learning. Documentation. Better architecture. Improved testing.

Failure without learning is wasted experience.

## Success Philosophy

Success is not launching quickly. Success is creating software that restaurants continue using five years later. Longevity is the ultimate product metric.

## Final Principle

Every sprint builds software. Every release builds trust. Every decision builds the company. Never forget which one matters most.
