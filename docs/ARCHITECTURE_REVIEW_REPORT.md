---
title: ARCHITECTURE_REVIEW_REPORT
version: 1.0.0
status: Final
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
scope: ARCHITECTURE_DECISIONS.md, DATABASE.md, API_Contract.md, SYSTEM_ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, MASTERPLAN.md, UX_MAP.md
---

# ARCHITECTURE REVIEW REPORT

> Priority 12 of the Sprint 0 documentation refactor: search for contradictions, dead architecture, unused entities, unused APIs, broken user flows, duplicated concepts, missing relationships, and future migration risks, across the completed package.

---

## 1. What Was Reviewed

Seven documents, all now at version 2.0.0 except the new `ARCHITECTURE_DECISIONS.md`:

`ARCHITECTURE_DECISIONS.md` · `DATABASE.md` · `API_Contract.md` · `SYSTEM_ARCHITECTURE.md` · `IMPLEMENTATION_PLAN.md` · `MASTERPLAN.md` · `UX_MAP.md`

Three source documents were retired or reduced to a pointer rather than rewritten: the Russian business-concept document and the CTO Operating Manual remain valid long-term vision (Document Hierarchy, `MASTERPLAN.md`); `CLAUDE_RULES.md` becomes the sole canonical AI-behavior document (ADR-011).

## 2. Method

Before this pass, every original source file referenced across this project was re-read directly from disk — not reconstructed from earlier summaries in this conversation. This mattered in practice: several of these "PDFs" turned out to be plain text files with a `.pdf` extension, which made a direct line-by-line comparison possible rather than approximate.

Result: every specific claim made earlier in this process — entity names, field lists, sprint task lists, the Tests-missing-from-Sprints-5/7/8/9/10 pattern, the Ledger-Entry-referenced-but-never-defined gap, the four-way AI-rules duplication, the CTO Operating Manual's triplicated paragraphs — checked out exactly against the real source. Nothing already delivered required correction on that basis.

## 3. The Twelve Decisions, In One Table

| ADR | Decision | Status |
|---|---|---|
| 001 | Money as BIGINT minor units, ISO 4217 exponent table, largest-remainder rounding | Accepted |
| 002 | Ledger (double-entry, not event-sourced) is the source of truth; Wallet/Restaurant balance/Analytics are projections | Accepted |
| 003 | Event delivery via Transactional Outbox, polling worker, no broker for MVP | Accepted |
| 004 | Idempotency as a stateful record (fingerprint + stored response), not a bare unique constraint | Accepted |
| 005 | Organization → Restaurant → Membership → User, replacing flat Restaurant + Employee | Accepted |
| 006 | Wallet scoped to Membership, not User — never commingles two employers' money | Accepted |
| 007 | Tip is a gross event; distribution is Ledger lines; only Individual implemented in MVP | Accepted |
| 008 | Refunds/Chargebacks real from MVP — compensating entries, webhook-driven, no self-service UI required | Accepted |
| 009 | Stripe Connect fields on Restaurant; connected account attached per-location for MVP | Accepted |
| 010 | Audit Logging and Rate Limiting belong to Foundation (Sprint 1), not a later Security sprint | Accepted |
| 011 | `CLAUDE_RULES.md` is the sole canonical AI-behavior document | Accepted |
| 012 | Launch market/currency is a founder decision, gating Sprint 3 | Accepted (Lithuania, EUR) |

## 4. Findings From This Pass (Found and Fixed)

Four real, if minor, inconsistencies surfaced from comparing the five rewritten documents against each other rather than against the originals. All four are already corrected in the files you have:

1. **Terminology drift on one module name.** `SYSTEM_ARCHITECTURE.md` called it "Refunds & Disputes Module" in the Business Layer section but "Refunds & Chargebacks" in its own Domain-Driven Design section two paragraphs later — an inconsistency within a single document. `MASTERPLAN.md` used "Refunds & Disputes" twice more. `API_Contract.md` and the `Chargeback` entity in `DATABASE.md` both said "Chargebacks." Standardized everywhere to **Refunds & Chargebacks**, matching the entity name.

2. **A referenced screen that didn't exist yet.** `DATABASE.md`, `API_Contract.md`, and `IMPLEMENTATION_PLAN.md` (Sprint 3) all treat currency selection as a real step during restaurant creation, but `UX_MAP.md` never said where. Added one line to the Restaurants screen tying it to `GET /currencies` and noting it's fixed afterward, same as the Stripe country constraint.

3. **An unstated cardinality.** `DATABASE.md`'s `Refund` entity related to `Transaction` without saying whether more than one Refund could exist per Transaction. The schema already allowed it; the rule just wasn't written down. Added: a Transaction may have more than one Refund, each independent, each its own compensating entry.

4. **A genuine missing relationship.** Nothing specified what Membership the creating Owner receives the moment their Organization is auto-created alongside their first Restaurant — org-wide, or scoped to that one Restaurant? Left unstated, this would have silently reintroduced the exact friction ADR-005 exists to remove: adding a second location later would have required a separate access grant for the Owner. Fixed: the creating User receives an org-wide Membership at that same moment, before a second Restaurant ever exists.

No unused entities, no dead endpoints, and no broken navigation paths were found. Every entity introduced by an ADR (`Organization`, `Membership`, `JournalEntry`, `LedgerLine`, `Refund`, `Chargeback`, `Adjustment`, `OutboxEvent`, `IdempotencyKey`, `Currency`, `RolePermission`) is referenced by at least one other document — none is defined in isolation.

## 5. What Remains Open

Nothing. **ADR-012 — launch market and currency** — was the one item needing a founder decision rather than engineering judgment; it is now resolved (Lithuania, EUR), verified against Stripe's current country availability. One operational nuance carries forward into Sprint 3: Lithuania's VAT treatment of restaurant/catering services changed on 1 January 2026 (now 12%, not the 21% standard rate) — worth confirming the alcohol treatment with a local accountant before that gets encoded into Tax Information.

## 6. Verdict

The seven-document package is internally consistent: cross-checked against original sources and against each other, with four small findings identified and corrected in place, and the one open founder decision now resolved. All twelve ADRs are Accepted. `IMPLEMENTATION_PLAN.md` Sprint 0 can start.
