---
title: ADR-063 — The Dashboard is computed from the Ledger; Stripe account status is fetched separately
version: 1.0.0
status: Accepted
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-063 — The Dashboard is computed from the Ledger; Stripe account status is fetched separately

**Status:** Accepted (Sprint 14), 2026-09-03

---

## Context

`UX_API_RECONCILIATION.md` (PR #126) found that the Dashboard screen leads with a banner when Stripe onboarding is incomplete — *"Finish payment setup to start accepting cards,"* naming the specific outstanding requirement — while `GET /dashboard` returns **no Stripe status at all**: not `cardPaymentsStatus`, not `payoutsStatus`, not `requirementsDue`. Those live on `GET /restaurants/:id`.

The obvious reading is that the Dashboard response is missing three fields. **It is not.** The banner needs a second call, and this ADR records why, because the "optimisation" of folding them into one response is the kind of change that looks like tidying and arrives a month later with nobody remembering the argument against it.

---

## Decision

**`DashboardSummary` does not carry Stripe account status, and the banner takes it from `GET /restaurants/:id`.**

### Why: they are two different kinds of fact, from two different sources

**Every figure on the Dashboard is computed from our own Ledger** — `SUM(CREDIT) − SUM(DEBIT)` over `LedgerLine`, the same definition `WalletProjectionService` and `TransactionService` use (ADR-024, ADR-025, ADR-026). It is derived from rows this system wrote, inside one database transaction, and it is correct the instant it is read.

**Stripe account status is state held by Stripe**, refreshed by calling their API (ADR-009: re-fetched, never parsed from a webhook payload). It is a *cached observation of someone else's system*.

**Three consequences that do not survive being merged into one response:**

1. **Different freshness.** Ledger figures are exact as of the request. A capability status is as fresh as the last refresh, and can be stale without anything being wrong.
2. **Different failure modes.** The Ledger cannot be unreachable while the request is being served — the query is the request. Stripe can be down, slow, or rate-limiting. **Folding the status in makes the whole Dashboard fail, or hang, on Stripe's availability** — the single most-viewed screen in the product taking a dependency it has no reason to have.
3. **Different reasons to go stale.** A Ledger figure changes when money moves. A capability status changes when a person finishes a form, or when Stripe re-reviews an account days later. Nothing about one implies anything about the other.

### The rule this states, so the next person does not re-derive it

**A response computed from our own records does not carry a field observed from someone else's system.** Two sources, two freshness stories, two failure modes; the caller decides how to compose them, and can render the money while the status is still loading — which is exactly what the banner-plus-figures screen wants.

**The cost is honest and small:** one extra request on Dashboard load. The frontend already needs `GET /restaurants/:id` for the venue's own name and settings.

---

## Alternatives

**Fold the three status fields into `DashboardSummary` — rejected.** One call instead of two, and the reason it is tempting is real. It buys a request and pays for it with a shared failure mode: a Stripe outage would blank the revenue figures, which are not Stripe's to blank. **This is the "optimisation" this ADR exists to answer**, and the answer is that the call count was never the problem.

**Cache the status inside the Dashboard response with its own age field — rejected as worse than either.** It keeps the coupling *and* adds a second notion of freshness inside one payload, which every consumer then has to reason about.

---

## Consequences

**The banner is a two-call screen, by design.** `GET /dashboard` for the money, `GET /restaurants/:id` for whether the venue can take it.

**`UX_API_RECONCILIATION.md`'s finding stands, with its resolution recorded here** — it is not a gap to be closed by adding fields.

**Not decided here:** whether the Dashboard should show anything at all while the Stripe status is loading. That is a screen question, and screens are not built yet.
