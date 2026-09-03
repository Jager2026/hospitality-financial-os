---
title: ADR-065 — Operational screens read shifts; accounting gets both lists; bank reconciliation stays calendar
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-065 — Operational screens read shifts; accounting gets both lists; bank reconciliation stays calendar

**Status:** Accepted (Sprint 14), 2026-09-03. **Decision only — no code.** The Dashboard and Analytics still read the calendar; their migration is its own PR.

---

## Context

ADR-064 put **two labels on every money line**: `LedgerLine.createdAt`, the calendar instant, and `LedgerLine.shiftId`, the venue's own working day. It deliberately stopped there and estimated the migration rather than starting it.

**The question this ADR answers is not "which label wins".** Both are on every row, so nothing has to be chosen away. The question is **which reader gets which**, and the answer differs by reader in a way that is obvious once stated and expensive to get wrong: an owner asking "how did Saturday go" and an accountant filing a VAT return are asking different questions about the same money.

---

## Decision

### 1. Operational screens read SHIFTS — Dashboard, Analytics, tips

**Analytics over a period counts shifts, not calendar days.** €1,400 arriving at 01:00 during Saturday's shift belongs to **Saturday**. A report that puts it in Sunday is arithmetically defensible and operationally useless: the owner was there, the staff were there, and the till says Saturday.

This is the whole reason ADR-064 exists, applied to the screens rather than only to the schema.

### 2. The owner is additionally shown the after-midnight figure, by name

Two facts, on the operational screens, whenever they are true:

- **that the shift closed after midnight**, and
- **how much money arrived between midnight and the close.**

**This is the number that explains why the Z-report and the bank statement disagree, instead of hiding it.** The discrepancy is real, it is not an error, and it has a cause with an amount attached. Showing the amount converts *"the books do not add up at the end of the day"* — the complaint this product is sold against — into one line an owner can read and reconcile.

**Not a warning and not an exception.** A shift closing at 01:30 is normal. The figure is information, and the copy must not imply something went wrong.

### 3. Accounting gets TWO lists — by shift and by calendar day

**Both, not a choice.** The accountant is bound by law to a calendar period, and reconciles against Z-reports that are per shift. Giving one list forces them to rebuild the other by hand, which is exactly the manual work this product exists to remove.

**The cost is small and worth stating plainly: it is one query and a different `GROUP BY`.** Both labels are already on every row; nothing new is computed and nothing is derived twice. **Two lists from one source cannot disagree** — which is the property that makes offering both safe rather than confusing.

### 4. Bank reconciliation stays CALENDAR

`PaymentReconciliationService` compares our records against Stripe's, and **Stripe counts by its own days**. A shift-scoped reconciliation would compare two different partitions of the same money and report differences that are not differences.

**This is not an exception to §1; it is the same rule applied honestly.** Operational screens answer the venue's questions and use the venue's day. Reconciliation answers Stripe's question and must use Stripe's day. Accounting exports answer the state's question and must use the calendar.

---

## The rule underneath, so the next screen does not have to ask

**A figure is labelled by the day of whoever is being answered.**

- The owner and the staff are answered in **shifts** — it is their working day.
- The tax authority and the accountant are answered in **calendar days** — it is the legal unit.
- Stripe and the bank are answered in **their** calendar days — it is their ledger we are matching.

**Every screen built from here on states which day it means.** A figure whose day is ambiguous is the defect this whole line of work exists to remove, and a screen that does not say cannot be checked.

---

## Consequences

**The Dashboard and Analytics migrate to shifts** — estimated in ADR-064 §D at roughly a day and a half of engineering for the two shared window helpers plus the Dashboard, with Analytics' date ranges being a product decision before an engineering one. **This ADR does not start it.**

**The after-midnight figure needs a query nothing does yet**: money on a shift, restricted to lines whose `createdAt` falls after local midnight of the shift's own `businessDate`. Both labels are already on the row, so it is a filter, not a new column.

**Two accounting lists mean two exports**, not one export with a toggle nobody can see the meaning of. Naming is part of the work: *"by shift"* and *"by calendar day"* must be legible without a tooltip.

**Rows written before ADR-064 have no `shiftId`** (its own Consequences section). Any shift-scoped report over historical data is incomplete for that period, and no backfill can honestly repair it — there is no record of when those venues closed their days.

**Not decided here:** what a shift screen looks like, whether the after-midnight figure appears on the Dashboard or only on a shift detail view, and whether Analytics offers a calendar mode at all alongside its shift default.
