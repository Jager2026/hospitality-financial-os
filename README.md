# Hospitality Operating System

Financial infrastructure for restaurants, cafés, and bars — payments, digital tipping, waiter
wallet, owner dashboard. See [`docs/MASTERPLAN.md`](docs/MASTERPLAN.md) for scope and product
vision, and [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md) for every
architecture-level decision (ADR-001 through ADR-018) and the reasoning behind it.

## Documentation

Read in this order before writing code — see `docs/AI_WORKFLOW.md`:

1. `docs/MASTERPLAN.md` — scope, source of truth for product
2. `docs/ARCHITECTURE_DECISIONS.md` — all ADRs, source of truth for architecture
3. `docs/AI_WORKFLOW.md` — daily process
4. `docs/DOMAIN_GLOSSARY.md` — terminology
5. `docs/SYSTEM_ARCHITECTURE.md`
6. `docs/DATABASE.md`
7. `docs/API_Contract.md`
8. `docs/UX_MAP.md`
9. `docs/SEQUENCE_DIAGRAMS.md`, `docs/SEQUENCE_PAYMENT_TIP.md`, `docs/SEQUENCE_ONBOARDING.md`,
   `docs/SEQUENCE_REFUND_CHARGEBACK.md`
10. `docs/IMPLEMENTATION_PLAN.md`
11. `docs/ARCHITECTURE_REVIEW_REPORT.md`
12. `docs/CONCEPT_VISION_RU.md` — long-term vision, background only; `MASTERPLAN.md` wins on
    any conflict

Behavioral rules for how this project is built — human or AI — live in [`CLAUDE.md`](CLAUDE.md).

## Repository Structure

```
apps/
  backend/    NestJS API — Prisma, PostgreSQL, Redis (Sprint 1+)
  frontend/   Next.js Restaurant Portal + Waiter Portal (Sprint 1+)
packages/
  shared/     Cross-app TypeScript utilities
  ui/         Shared UI components
  config/     Shared lint/tsconfig/build config
  types/      Shared TypeScript types (API contracts, domain types)
docs/         All product and architecture documentation
docker/       Local development services (Postgres, Redis)
scripts/      Repository automation
.github/      CI workflows
```

## Getting Started

Requirements: Node 20+, [pnpm](https://pnpm.io) 9+, Docker.

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d
pnpm install
pnpm dev
```

**No Node.js is required to read this repository, but running it locally does need Node 20+.**
`apps/backend` (NestJS) and `apps/frontend` (Next.js) are real, foundation-layer code as of
Sprint 1 — no business modules yet (those start Sprint 3). `apps/backend/prisma/schema.prisma`
is real as of Sprint 0 and reflects the full data model in `docs/DATABASE.md`; the two
integrity constraints Prisma can't express live in `apps/backend/prisma/sql/ledger_integrity.sql`
— see that file's header for how to apply them.

## Branch Strategy

Trunk-based. `main` is always deployable and protected — no direct pushes, PR required, CI must
pass (lint, format, Prisma schema validation, typecheck, test, build). Feature branches:
`feat/<short-description>`, `fix/<short-description>`, `chore/<short-description>`. Every commit
on `main` should be deployable (`docs/SYSTEM_ARCHITECTURE.md`, CI/CD).

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Run all apps in development mode |
| `pnpm build` | Build all apps and packages |
| `pnpm lint` | Lint the whole repository |
| `pnpm format` | Check formatting |
| `pnpm typecheck` | Type-check every workspace |
| `pnpm test` | Run tests across every workspace |
| `pnpm prisma:validate` | Validate `schema.prisma` without touching a database |

## Status

Sprint 1 (Foundation) — see `docs/IMPLEMENTATION_PLAN.md`. Written but **not yet run**: this
development environment has no Node.js, so `pnpm install` / `prisma migrate` / `nest start` /
`next dev` have not been executed against this code. Run them locally and report back before
treating Sprint 1's Definition of Done as met. Nothing beyond Sprint 1 proceeds without Founder
review.
