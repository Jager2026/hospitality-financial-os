---
title: SYSTEM_ARCHITECTURE
version: 2.0.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
supersedes: SYSTEM_ARCHITECTURE v1.0 — see ARCHITECTURE_DECISIONS.md for the reasoning behind every change below
---

# SYSTEM ARCHITECTURE

> "Architecture is not about today's software. It is about tomorrow's company."

---

# Introduction

This document defines the complete architecture of the Hospitality Financial Operating System.

The architecture must support:
• Millions of users
• Thousands of restaurants
• Multiple countries
• Multiple payment providers
• Multiple currencies
• Future financial products

while remaining simple enough for a small engineering team to maintain, and correct enough that every financial figure the system shows can be traced back to a Ledger entry (see ARCHITECTURE_DECISIONS.md, ADR-002).

---

# Architecture Philosophy

The company is not building software. The company is building financial infrastructure.

Infrastructure must be: Reliable · Predictable · Modular · Observable · Secure · Scalable · Maintainable.

Everything else is secondary.

---

# Architectural Principles

1. Business before technology.
2. Modularity over complexity.
3. Composition over duplication.
4. Security by default.
5. Documentation before implementation.
6. Events before polling.
7. Explicit over implicit.
8. Simple before clever.
9. Measure before optimizing.
10. Developer Experience matters.

---

# System Overview

Client Layer ↓ API Layer ↓ Business Layer ↓ Infrastructure Layer

Each layer has a single responsibility. No layer should know unnecessary details about another.

---

# Client Layer

Applications: Restaurant Portal · Waiter Portal · Future Admin Portal · Future Mobile Apps · Future Public API.

Clients never communicate directly with databases. Everything passes through the API.

---

# API Layer

Responsibilities: Authentication · Validation · Authorization · Serialization · Rate Limiting · Logging · Request Routing · Idempotency-Key resolution (ADR-004 — checked before a request reaches the Business Layer).

The API layer contains no business logic. Business decisions belong elsewhere.

---

# Business Layer

This is the heart of the application.

Contains:
- **Organization & Restaurant Module**
- **Membership Module** — renamed from Employee (ADR-005)
- **Ledger Module** — owns `JournalEntry` and `LedgerLine`. The only module permitted to write a double-entry posting (ADR-002). Every other module that needs to move money calls into it rather than reimplementing debit/credit logic.
- **Payment Module**
- **Wallet Module** — a projection consumer of Ledger, not an independent source of balance (ADR-006)
- **Tips Module** — implements an allocation-strategy interface; Individual is built, Pool / Shift / Percentage / Role-based are designed but not implemented (ADR-007)
- **Refunds & Disputes Module** — webhook-driven; writes only compensating Ledger entries, never edits history (ADR-008)
- **Analytics Module**
- **Settings Module**
- Future Notification Module
- Future AI Module

Every module owns its own business rules. Modules communicate through well-defined interfaces.

---

# Infrastructure Layer

Contains external integrations: Database · Redis · Stripe · Cloud Storage · Email · Logging · Monitoring.

No external message broker is required for MVP. The Transactional Outbox (ADR-003) is delivered by a polling worker running inside the backend process — a scheduled task, not new infrastructure. If a broker is ever justified by volume, it replaces only the publisher; the outbox table and the Ledger itself don't change.

Infrastructure should never contain business rules.

---

# Modular Monolith

The MVP uses a Modular Monolith.

Why? One deployment. One database. One repository. Fast development. Simple debugging. Low operational cost. Easy onboarding. A future migration path — the module boundaries above (especially Ledger's) are drawn so that extraction later doesn't require a redesign.

Microservices are intentionally postponed.

---

# Module Structure

Every module follows identical internal architecture: Controllers · DTOs · Services · Repositories · Entities · Validators · Policies · Tests · Documentation.

Every module should be understandable in isolation.

---

# Domain Driven Design

Business domains define architecture. Not technical layers.

Domains: Authentication · Organization · Restaurant · Membership · **Ledger** · Payments · Wallet · Tips · Refunds & Chargebacks · Analytics · Settings · Audit · Future Supplier · Future Marketplace · Future Finance.

Ledger is the domain every other financial domain depends on. Wallet, Restaurant balance, and Analytics all read from it; none of them is a second source of truth for money (ADR-002). Every domain owns its own data.

---

# Clean Architecture

Presentation ↓ Application ↓ Domain ↓ Infrastructure

The Domain Layer never depends on frameworks. Frameworks may change. Business logic should survive.

---

# Repository Structure

```
apps/
  backend/
  frontend/
packages/
  shared/
  ui/
  config/
  types/
docs/
scripts/
.github/
docker/
```

Everything has one location. No duplicate responsibilities.

---

# Backend Architecture

Framework: NestJS · Language: TypeScript · ORM: Prisma · Database: PostgreSQL · Cache: Redis · Authentication: JWT · Validation: Zod · Logging: Pino · Testing: Vitest.

The backend exposes REST APIs. Future GraphQL remains optional.

The Outbox polling worker runs as a scheduled task inside the same NestJS process for MVP (e.g. via a cron-style scheduler module) — it does not require separate deployment or infrastructure.

---

# Frontend Architecture

Framework: Next.js · Language: TypeScript · UI: TailwindCSS · State: TanStack Query · Forms: React Hook Form · Validation: Zod · Charts: Recharts.

The frontend contains no business rules. Business belongs on the server.

---

# Database

Primary: PostgreSQL · Secondary: Redis · Future: Read Replicas, Analytics Warehouse.

All monetary columns use `BIGINT` storing minor currency units — never `FLOAT`, never an unscaled `DECIMAL` (ADR-001). Never optimize before metrics justify complexity.

---

# Caching Strategy

Two different things were previously both called "caching." They need different rules.

**Real caching (Redis, TTL-based):** Dashboard aggregates, Analytics reports, Restaurant Settings, Permissions. Safe to serve briefly stale; invalidated on write or expiry.

**Projections (Postgres, Outbox-updated — not Redis):** Wallet balance, Restaurant balance. Not a cache in the TTL sense — a materialized view of the Ledger, kept current by the Outbox consumer (see Event Delivery), consistent within the Outbox's processing latency, and rebuildable from zero at any time by re-aggregating `LedgerLine`.

Never serve a financial balance from Redis. The Ledger-derived projection tables already fill that role, correctly.

---

# Authentication

JWT · Refresh Tokens · Role Based Access Control · Future MFA · Future SSO · Future OAuth.

Authentication is centralized. No module implements authentication independently.

---

# Authorization

Permissions → Roles → RolePermission → Policies → Controllers.

A policy check resolves through the current User's Memberships: does the User hold a Membership — either scoped to this specific Restaurant, or org-wide (`restaurant_id IS NULL`) within that Restaurant's Organization — whose Role carries the required Permission (ADR-005). Every request passes this check server-side. Never trust frontend permissions.

---

# Payments

Payment abstraction layer. Current: Stripe Connect. Future: Adyen, Mollie, Checkout.com, Worldpay.

Every payment provider implements the same interface. Changing providers should require minimal code changes.

---

# Idempotency

Idempotency-Key handling sits at the API Layer boundary, resolved before any Business Layer module is invoked — see API_Contract.md and ADR-004. No Business Layer module implements its own ad hoc duplicate-prevention logic; there is exactly one place this is handled.

---

# Event Delivery

Previous versions of this document referenced domain events (RestaurantCreated, PaymentCompleted, TipCreated, WalletUpdated, TransactionRecorded) without specifying how they were delivered. This gap is closed by ADR-003.

**Mechanism — Transactional Outbox.** Every database transaction that writes a `JournalEntry` / `LedgerLine` also inserts a matching row into `outbox_event`, in the *same* transaction. If the transaction commits, the event is guaranteed to exist; if it rolls back, so does the event. There is no window where a Ledger write succeeds but the event is lost, or vice versa.

**Publishing.** A lightweight polling worker — a scheduled task inside the backend process, not separate infrastructure — periodically reads unpublished `outbox_event` rows and dispatches them to the owning module's projection handler: Wallet Module updates the affected Wallet's cached balance, Restaurant Module updates the affected Restaurant's cached balance, Analytics Module updates its read models, Notification Module (future) sends alerts. Each handler must be idempotent, since retries are expected.

**Failure and retry.** If a handler fails, the row's `attempts` counter increments and `published_at` stays null; the next poll retries it. A row failing repeatedly beyond a threshold becomes an operational alert, not an infinite retry loop.

**Why not full event sourcing, why not Kafka/Debezium yet.** The Ledger itself is directly queryable (ADR-002) — state is never reconstructed by replaying events; only projections are updated by them. A CDC-based relay adds real operational complexity (schema registries, broker infrastructure, on-call burden) not justified at this scale. The outbox table plus polling worker gets the same delivery guarantee with one new table and no new infrastructure. If volume ever makes polling latency a real bottleneck, migrating the *publisher* — not the Ledger, not the outbox table — to a message broker is a contained, later change; consumers don't need to know the difference.

---

# Observability

Every request receives a Request ID, Trace ID, and Correlation ID. Every important action is measurable. No invisible failures.

---

# Logging

Structured JSON Logs: Request Logs · Payment Logs · Security Logs · Audit Logs · Application Logs.

Logs are searchable. Logs are immutable. Sensitive information is never stored.

---

# Error Handling

Errors follow one format: Validation ↓ Business ↓ Infrastructure ↓ Unknown.

Customers receive friendly messages. Developers receive detailed diagnostics.

---

# Security

HTTPS · JWT · RBAC · Encryption · Hashing · Secrets Management · Audit Logging · Rate Limiting · Input Validation · Output Sanitization.

Webhook payloads are never processed without signature verification (see API_Contract.md, Incoming Webhooks).

Security is not optional.

---

# CI/CD

GitHub → Pull Request → Tests → Lint → Type Check → Build → Docker → Deploy → Smoke Tests → Production.

Every commit should be deployable.

---

# Docker

Development: Docker Compose. Production: Containers. Future: Kubernetes.

Developers should clone the repository and start working within minutes.

---

# Monitoring

Metrics · Logs · Traces · Health Checks: Database Health, Redis Health, Payment Provider Health, Application Health, **Outbox Lag** (count of unpublished events, age of the oldest unpublished event).

Outbox Lag matters specifically: if it grows, projections are going stale even though the Ledger itself is still correct — this failure mode is silent unless it's explicitly monitored.

---

# Future Microservices

Microservices are allowed only when: Business requires independent scaling. Independent deployment becomes valuable. Operational complexity is justified.

If that day comes, the **Ledger Module** is the most natural first extraction candidate — nothing else writes `JournalEntry` / `LedgerLine`, so its boundary is already the cleanest in the system. Until then: remain Modular Monolith.

---

# Technical Debt

Technical debt is documented, never hidden. Every shortcut includes: Reason · Owner · Removal Plan · Priority.

---

# Final Architecture Principle

The architecture should enable the company to move faster every year, not slower. If adding new functionality becomes increasingly difficult, the architecture has failed. Architecture exists to accelerate innovation, not restrict it.

---

# Architecture Manifesto

Every engineer joining this company should remember one thing: we are not writing software that needs to survive Version 1. We are building infrastructure capable of supporting the next decade of innovation in hospitality.

Every module. Every service. Every API. Every database table. Every line of code. Should move us closer to that vision.
