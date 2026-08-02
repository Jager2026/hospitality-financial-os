---
title: UX_MAP
version: 2.0.0
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

(`API.md` and `DATABASE.md` now exist and are current — see `API_Contract.md` and `DATABASE.md`. `UX_BIBLE.md`, `DESIGN_SYSTEM.md`, and `COMPONENT_LIBRARY.md` remain outstanding, unchanged from v1.0.)

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

## Dashboard

**Purpose:** Provide immediate understanding of restaurant performance.

Questions answered: How much revenue today? How many transactions? How many tips? Average tip percentage? How are employees performing? Recent activity?

If these questions cannot be answered within five seconds, the dashboard has failed.

**New (ADR-009):** if this Restaurant's Stripe onboarding isn't complete — `charges_enabled` or `payouts_enabled` is false — the Dashboard leads with a single, unmissable banner instead of competing with the sections below: "Finish payment setup to start accepting cards," naming the specific outstanding requirement, with one button to resolve it. Everything else on this screen is secondary until that banner is gone.

**Dashboard Sections:** Today's Revenue · Today's Tips · Today's Transactions · Average Bill · Average Tip · Recent Payments · Top Waiters · Alerts · Quick Actions

**Quick Actions:** Invite Employee · Configure Tips · View Reports · Restaurant Settings · Export Data · **Complete Payment Setup** (appears only while Stripe onboarding is incomplete)

---

## Restaurants

**Purpose:** Manage restaurant locations. Visible only for multi-location businesses. Single-location businesses skip this screen completely.

**Restaurant Card contains:** Restaurant Name · Status · Today's Revenue · Today's Tips · Employee Count · Last Activity

**What changed (ADR-005):** this screen is the view onto an Organization's Restaurants. Nothing about the card, or the "single-location businesses skip this completely" rule, changes — a business with one Restaurant still never sees this screen, exactly as before. What's new: an org-wide Owner (a Membership with no specific restaurant attached) lands here first after login, instead of a single Dashboard, since their role spans every location. A restaurant-scoped Manager still goes straight to that one Restaurant's Dashboard. "Add Restaurant" becomes a primary action here — adding a second location to the same Organization, not starting over.

**Restaurant Details:** Overview · Employees · Transactions · Analytics · Settings

---

## Employees

**Purpose:** Manage restaurant staff.

**Screen Sections:** Employee List · Invite Employee · Deactivate Employee · Employee Details · Permissions · Search · Filters

**What changed (ADR-005):** Invite Employee gains one new choice — **This Location Only** or **All Locations** — whether the invitation grants access to just this Restaurant or every Restaurant in the Organization. Single-location businesses never see this choice; it only appears once a second location exists, keeping the common case exactly as simple as before.

**Employee Details:** Profile · Position · Wallet · Tip History · Performance · Activity · Permissions · Status

**What changed (ADR-006):** Wallet, here, reflects only this Restaurant's earnings for this person. If the same person also works at another Restaurant on the platform, that is a second, separate Wallet, visible in their own Waiter Portal — never merged into this view, since two employers' money should never appear as one balance (see Waiter Portal Wallet, below).

---

## Transactions

**Purpose:** Complete financial visibility.

**Transaction Card:** Amount · Tip · Waiter · Time · Status · Payment Method · Receipt

**Transaction Details:** Restaurant · Employee · Customer · Gross Amount · Net Amount · Tips · Processing Fee · Reference ID · Timeline · Audit Events

**New (ADR-008):** a Refund / Chargeback status, shown only when one exists on this Transaction — status, amount, and whether the tip was refunded. No action is available here for MVP; refunds are initiated through Stripe, not this screen (see `API_Contract.md`). This exists so an owner is never left wondering why a number changed.

---

## Analytics

**Purpose:** Transform transactions into business insights.

**Sections:** Revenue · Tips · Employees · Payments · Time Analysis · Growth · Reports · Exports

---

## Settings

Restaurant Information · Business Details · Tax Information · Tip Configuration · Payment Configuration · Users · Permissions · Notifications · Integrations · Security

**What changed (ADR-009):** Payment Configuration now includes the Stripe connection itself — connected account status, `charges_enabled`, `payouts_enabled`, and any outstanding requirements. This is the permanent home for what the Dashboard banner links to.

---

## Profile

Owner Information · Company Information · Subscription · Billing · Language · Theme · Security · Logout

**What changed (ADR-005):** for an org-wide Owner, "Company Information" is Organization-level; for a Manager scoped to one Restaurant, it stays Restaurant-level, exactly as before.

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

Terminal → Bill Display → Choose Tip → Review Total → Card Payment → Payment Processing → Receipt → Finished

Target completion time: less than 30 seconds.

Nothing about this flow changes. The Ledger, Idempotency-Key, and Outbox mechanics that now sit behind "Card Payment" and "Payment Processing" (ADR-002, ADR-003, ADR-004) are invisible to the customer by design — that is the entire point of them.

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
