---
title: ADR-064 — The Shift is the restaurant's working day, and it is not the calendar day
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-064 — The Shift is the restaurant's working day, and it is not the calendar day

**Status:** Accepted (Sprint 14), 2026-09-03. Model and migration only; no screens, and the Dashboard and Analytics still read the calendar.

---

## Context

**The Founder's fact, four years working in restaurants: a restaurant's day and a calendar day are different things.** The venue closes its day with a Z-report — usually before midnight, and regularly after it. **A payment at 01:30 on a shift nobody has closed belongs to that shift**, not to the next day.

Everything in this system counts by the calendar: `getLocalDayWindow` over `LedgerLine.createdAt` (ADR-026), for the Dashboard and for Analytics. That is correct for accounting and wrong for the floor.

**The consequence is not academic.** Our "today" and the venue's Z-report diverge on exactly the after-midnight payments — which is the discrepancy this product exists to remove. Shipping a dashboard that disagrees with the till at 01:30 reproduces the pain in the pitch.

---

## Decision

### 1. Every money operation carries TWO labels, and neither is derived from the other

`LedgerLine.createdAt` stays exactly as it is: **the calendar instant**. Accounting and tax are calendar-bound and always will be; nothing here weakens that.

`LedgerLine.shiftId` is added: **the operational label** — which of the venue's own working days this money belongs to.

**On `LedgerLine`, not on `Transaction`**, because that is where every figure is already aggregated (ADR-024, ADR-025, ADR-026). A shift-scoped total is then the same query with a different filter, not a second way of counting that could disagree with the first.

**Resolved inside `postJournalEntry`, in the posting transaction.** A shift closing concurrently with a payment cannot put half of one entry in each. The one-way dependency is Ledger → Shift; Shift knows nothing about the Ledger, so there is no cycle to break later.

**Shifts open lazily**, on the first operation at a venue with none. No operation is ever shift-less, and a venue that never presses "open" still gets correct books.

### 2. Two ways to close, and they are not equal

- **The BUTTON is the main path.** A person decided the day is over.
- **The configured TIME is the safety net.** It fires only if nobody pressed.

**A button press at 03:00 with the setting at 05:00 means the shift closed at 03:00**, and the sweep never touches it. This is enforced *by construction, not by comparison*: once `closedAt` is set the shift is not open, and the sweep only selects open shifts. There is no rule anywhere that compares the two times, and so no rule that can be got wrong.

`Shift.closeReason` records which of the two happened, permanently. An owner reading a week of shifts can see which nights ended with someone pressing the button and which simply timed out — and those are different facts about how a venue is run.

**`closedBy` is NULL for a scheduled close.** No invented "system user": an actor that is not a person should be absent, not fabricated, or every audit read has to know which id means "no one".

### 3. The setting belongs to the Restaurant, not the Organization

`Restaurant.shiftAutoCloseMinutes` — minutes after local midnight, in the venue's own timezone. **Different venues keep different hours**, and a chain with a bar and a lunch cafe would otherwise have to pick one answer that is wrong for one of them.

**Not nullable, and the default is deliberate:** a safety net that can be switched off is not a safety net, and NULL would let a shift run forever with nothing to notice. A database CHECK keeps it inside `0..1439`, because a value outside the day is not a late close — it is the net silently absent.

**`300` (05:00 local) is a placeholder chosen so the net is never missing. The number itself is the Founder's** — see the open questions.

### 4. What the database enforces rather than the service

- **One open Shift per Restaurant**, as a partial unique index. `resolveOpenShift` reads-then-creates; two concurrent first payments would both read "none" and both insert. That is the same non-atomic race `global-setup.ts` already documents for seeding, which was real. The loser now fails the insert and retries into the winner's shift, instead of silently producing two open shifts that split one evening's takings.
- **A closed shift must say how it closed**, as a CHECK. Two nullable columns with a rule about when each applies is a convention until the database enforces it.

---

## Open questions — shown, not decided

### A. A shift that closes neither by button nor by schedule

The sweep is an `@Interval` in the API process. **If it does not run — a crash, a deploy gap, a scheduler that silently stops — a shift stays open indefinitely**, and every operation keeps joining it. Nothing today notices.

| Option | What it costs |
|---|---|
| **Close on read**: any query for the current shift also closes an overdue one | No scheduler dependency at all. But a *read* now writes, which breaks the expectation that reporting is side-effect-free — and two concurrent reads race. |
| **Alert on an overdue open shift** (ADR-045's channel) and leave it open | Cheapest, and honest: a human decides. Adds nothing to the money path. Does not fix anything on its own, and depends on somebody reading the alert. |
| **Hard cap**: force-close at N hours regardless of the setting | Bounded by construction, no scheduler trust required. Picks an arbitrary N, and a venue with a genuinely long event gets its books split by a number nobody agreed. |
| **Health check on the sweep itself** — assert it ran within the last N minutes | Fixes the actual failure (the scheduler stopped) rather than its symptom. More machinery, and it is the ADR-038 liveness-probe pattern applied to a second thing. |

**Recommendation withheld deliberately** — the choice depends on whether the pilot's operational reality is "the owner is on the floor and will notice" or "nobody looks until the numbers are wrong".

### B. Reopening a closed shift

Probably no, and here is the price of both answers.

**If reopening is impossible:** a shift closed by mistake at 21:00 leaves the rest of the evening in the *next* shift. The books are correct — every operation carries the shift it was actually posted in — but the venue's own two working days disagree with its own two Z-reports for that night, and nothing can repair it.

**If reopening is possible:** `closedAt` becomes editable, and with it the meaning of every figure computed from it. A report run at 22:00 and the same report run at 23:00 can disagree, with nothing in the data saying why. **The Ledger's own discipline is that corrections are new rows, never edits to history** (ADR-002) — reopening is an edit to history in the one dimension that decides which day money belongs to.

**The middle option, if the mistake case turns out to matter:** never reopen, but allow an explicit *merge* — a new record saying "shift B is a continuation of shift A" — which is additive, auditable, and leaves both original rows intact. Costs a new entity and a rule for every screen that groups by shift.

### C. A shift longer than a day, and what the owner sees

With the safety net at 05:00 a shift cannot normally exceed ~29 hours. **But under question A it can, and there is no upper bound today.**

`businessDate` is taken at `openedAt` and never moves, so a 40-hour shift is still called by the day it started — which is right, and which means **an owner looking at "the shift of 2 September" may be looking at a total that includes most of 3 September.** Nothing on screen says so today, because there are no screens.

**What a screen will have to show, when there is one:** the shift's own open and close times next to its name, and something visibly different about a shift still open past its due time. **Not decided here**, and named so the first shift screen does not quietly render a 40-hour total as an ordinary day.

### D. How this lands on the Dashboard and Analytics — estimate, not a rewrite

Both compute over `LedgerLine.createdAt` windows via `netForRestaurantWindow` and `netTipsByMembershipForRestaurantWindow` (`restaurant-ledger-window.util.ts`). **Neither is touched by this change**, and both keep working exactly as before.

**The shape of the move, and why it is small:** the shared helpers take `(restaurantId, accounts, start, end)`. A shift-scoped variant takes `(shiftId, accounts)` — the same `groupBy`, a different `where`. The aggregation logic does not change at all; what changes is which rows are selected.

**Estimated cost:**

| Piece | Estimate |
|---|---|
| Shift-scoped variants of the two window helpers | **~half a day**, including tests |
| Dashboard reading a shift instead of a calendar day | **~1 day** — every figure, plus the 7-day chart, whose buckets stop being calendar days and become the last 7 shifts |
| Analytics date ranges | **larger, and it is a product question first** — a range like "1–7 September" is a calendar concept; whether the owner means seven calendar days or seven shifts is not answerable by engineering |
| Deciding which screens stay calendar-based | **The real work.** Accounting exports must stay calendar; operational screens should move; the middle cases are decisions |

**Not started, deliberately: the model first, then the screens.** Moving screens before the model has run against real data would mean rebuilding them when the model changes.

---

## Consequences

**Every `LedgerLine` written from now on carries a Shift.** Rows written before this migration have `shiftId = NULL` — a real and permanent gap in any shift-scoped report over historical data, and one no backfill can honestly close: **there is no record of when those venues actually closed their days.** A backfill would have to invent shift boundaries, which is worse than an absence.

**One extra query per posting**, indexed, inside a transaction that was already open.

**`postJournalEntry` now depends on `ShiftService`.** Every spec that constructed `LedgerService` directly now provides the real service through `test/fixtures/shift-for-tests.ts` — the real one, not a stub, because a stub returning a fixed id would let those specs pass against an implementation that never opens a shift at all.

**Not built here:** the button's HTTP route, any screen, and the migration of Dashboard or Analytics.
