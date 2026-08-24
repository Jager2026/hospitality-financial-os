---
title: INDEX
version: 1.5.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# Documentation Index

Purpose: one line per document — title, version, and what it actually contains — so any engineer (or Claude, at the start of a session) can find the right doc without opening all of them. This file is a map, not a source of truth: if it ever disagrees with the document it points to, the document wins and this line is stale.

Regenerate by hand when a doc's version bumps or a new doc is added — it isn't build-generated.

| Document | Version | What it contains |
|---|---|---|
| [MASTERPLAN.md](MASTERPLAN.md) | 2.1.0 | Product vision, business model, and scope for the Hospitality Financial Operating System — the top of the document hierarchy everything else refines. Includes "Pilot-Ready Product," two narrow, explicitly scoped exceptions to the Accounting-Integrations Out-of-Scope line (ADR-029). |
| [AI_WORKFLOW.md](AI_WORKFLOW.md) | 1.0 | The step-by-step process Claude must follow before implementing any feature — read docs in order, understand the problem, then design, then code. |
| [CLAUDE_RULES.md](CLAUDE_RULES.md) | 2.4.2 | Behavioral and values contract for Claude as AI Technical Co-Founder — engineering culture, review standards, communication rules. Byte-identical to root `CLAUDE.md` per ADR-011. |
| [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md) | 1.19.0 | The full ADR log — thirty-four accepted architecture decisions, each with context, decision, and consequences; the canonical record of *why*, including in-place revisions to earlier decisions (e.g. ADR-009, ADR-014, ADR-023, ADR-026, ADR-031). Sprint 13: ADR-032 (five THREAT_MODEL.md point fixes — ledger account reclassification, CI dependency scanning, idempotency race, breached-password check, payment reconciliation), ADR-033 (terminal staff selection replaces automatic tip recipiency), and ADR-034 (Postgres major aligned across dev/CI/production, Railway config moved into git). |
| [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | 2.3.0 | The system's components, modules, and how they fit together — the technical shape the ADRs decided into. Documents Railway production hosting, the shared `AlertService`, and `PaymentReconciliationService` (ADR-031/032). |
| [DATABASE.md](DATABASE.md) | 2.10.0 | Every entity, field, and relationship in the data model — the source `schema.prisma` is translated from. `User.display_name` and the revised `Payment.waiter_membership_id` (ADR-033). |
| [API_Contract.md](API_Contract.md) (title: API_SPECIFICATION) | 2.11.0 | Every REST endpoint — request/response shape, auth requirements, rate limits — the contract the frontend and backend both build against. New `GET /restaurants/{id}/staff`, `waiter_membership_id` on Create Payment, `display_name` on Register/Accept Invitation, `PASSWORD_BREACHED` error code (ADR-032/033). |
| [UX_MAP.md](UX_MAP.md) | 2.1.0 | Every screen, navigation path, and interaction in the product, and what changed on each screen as a result of specific ADRs. |
| [DOMAIN_GLOSSARY.md](DOMAIN_GLOSSARY.md) | 1.0.0 | One-page dictionary of project-specific terms and confusable pairs, compiled from DATABASE.md/ARCHITECTURE_DECISIONS.md/MASTERPLAN.md — never a new decision of its own. |
| [EVENT_CATALOG.md](EVENT_CATALOG.md) | 1.3.0 | The concrete catalog of `OutboxEvent` rows the codebase actually produces and their payload shapes, read directly from the code, not designed ahead of it. Notes the real ADR-031 alerting webhook alongside the pre-existing log-only alert. |
| [THREAT_MODEL.md](THREAT_MODEL.md) | 1.7.0 | Security threats considered for the platform — organized into Closed Threats, Accepted Risk, and Open, Not Answered, each citing the ADR that resolved or owns it. Sprint 13 (ADR-032/033) closes five entries (payment reconciliation, dependency scanning, breached-password check, waiter tip-recipiency, idempotency race) and reclassifies PROCESSOR_CLEARING alongside the Wallet-availability entry, both blocked on `Withdrawal`. |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | 2.6.0 | The sprint-by-sprint build plan — tasks and Definition of Done for each sprint, Sprint 0 through the current one, plus a Deferred/Not-Yet-Scheduled backlog for flagged major-version upgrades, MFA, and the off-platform backup (triggered by the first real pilot payment). |
| [SEQUENCE_DIAGRAMS.md](SEQUENCE_DIAGRAMS.md) | 1.0.1 | Prose explanation of what each sequence diagram resolves and the ADRs that came out of walking through the timing (ADR-014, ADR-015, ADR-016). |
| [SEQUENCE_ONBOARDING.md](SEQUENCE_ONBOARDING.md) | — (no frontmatter; mermaid source) | Mermaid sequence diagram for restaurant creation through Stripe Connect onboarding to first-payment readiness. |
| [SEQUENCE_PAYMENT_TIP.md](SEQUENCE_PAYMENT_TIP.md) | — (no frontmatter; mermaid source) | Mermaid sequence diagram for a customer payment plus tip, from client-side confirmation through webhook-driven Ledger/Wallet updates. |
| [SEQUENCE_REFUND_CHARGEBACK.md](SEQUENCE_REFUND_CHARGEBACK.md) | — (no frontmatter; mermaid source) | Mermaid sequence diagram for staff-initiated refunds and Stripe-initiated chargebacks, including the provisional-loss/reversal pattern. |
| [SPRINT_0_SCHEMA_AUDIT.md](SPRINT_0_SCHEMA_AUDIT.md) | 1.2.0 | Closed audit of the initial `schema.prisma` translation from DATABASE.md v2.0.0 — open questions and their resolutions, Founder-reverified. |
| [ARCHITECTURE_REVIEW_REPORT.md](ARCHITECTURE_REVIEW_REPORT.md) | 1.0.0 | Final cross-document review searching for contradictions, dead architecture, and gaps across the Sprint 0 documentation package. |
| [CONCEPT_VISION_RU.md](CONCEPT_VISION_RU.md) | 1.0 (no frontmatter) | Original Russian-language internal concept document — vision, product, business model, monetization, roadmap; the earliest-stage pitch this project grew from. |
