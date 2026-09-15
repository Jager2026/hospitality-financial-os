---
title: ADR-095 — A double that cannot lag its original
version: 1.0.0
status: Accepted
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-095 — A double that cannot lag its original

**Status:** Accepted (Sprint 16), 2026-09-15. Three failures in
[ADR-094](ADR-094-the-processing-fee-enters-the-books.md)'s pull request had one shape — *a
duplicate obliged to change with its source did not change* — and this measures the class and puts
a compile-time contract under the part of it that can carry one.

**The requirement, stated before any option was weighed:** when the real service moves ahead, the
double must fail to **compile**, not lie at runtime.

---

## 1 · How big the class is, measured

**The instrument was wrong twice before it was believed, and both errors are worth recording** —
they are the same class the ADR is about.

- The first argument counter reported `WebhooksService` and `OutboxPollerService` at **nine**
  positional arguments. Both constructors take six. It was counting commas inside comments and
  strings.
- The second reported **seven** for both, and its self-check — *no call site may pass more than the
  constructor takes* — **passed**, because a trailing comma inflated the constructor arity and the
  call sites **by exactly one each**. A check that compares two numbers cannot see an error common
  to both. The ground truth came from reading the two constructors by hand.

### (a) Hand-written service doubles

| kind | count | typed against the real thing? |
|---|---|---|
| class-shaped doubles | **6** in 6 files, **2 distinct names** | **0 of 6** |
| — `FakeStripeService` | 5 copies (4 e2e specs, 1 load spec) | none |
| — `FakeRedisClient` | 1 | none |
| object literals passed as services, silenced by an assertion | ~86 occurrences across 24 files, of which **71 `as any` in 15 spec files** — the `as any` figure is an exact grep, the 86 a pattern estimate | none, and `as any` defeats any type-level check by construction |

**The five copies had already drifted further than ADR-094 found.** Three of the five defined
`createAccountLink` — **a method `StripeService` has never had** — and defined no
`createOnboardingLink`, which it does have. Two reported `requirementsDue: null`, three `[]`. None
of the five implemented `retrievePaymentIntent` or `onModuleInit` at all. Nothing noticed, because
nothing compared them.

### (b) Fixtures reproducing data that has a real source

| data | occurrences | mechanism |
|---|---|---|
| Role names + hand-written permission lists | 11 permission literals in 7 files | **exists** — `repo-invariants.spec.ts`, and it caught ADR-094's own fixture |
| Role names read from the database (`findUniqueOrThrow({ where: { name } })`) | 34 in 24 files | not drift: a wrong name throws |
| `ConfigService` stand-ins — the product's configuration, retyped | **31 in 19 files** | **none at all** |
| currency codes | 107 in 33 files | the `Currency` foreign key; the database is the mechanism |

**And the mechanism that exists had a hole of exactly the kind it polices.** The list of seeded Role
names existed in **three** copies — `prisma/seed.ts`, `test/fixtures/authenticated-user.ts`, and
inline inside the invariant — and **the invariant's copy listed four names, omitting `Accountant`**.
A fixture wearing that name with an invented permission list would have passed the check written to
catch precisely that. No such fixture exists today, so the hole was open rather than leaking.

**It was exactly one list, so it is fixed here** rather than deferred: `prisma/seed.ts` exports
`SEEDED_ROLE_NAMES`, the fixture helper re-exports it, the invariant reads it. `as const` is
load-bearing — `ROLES` is typed against the tuple, so adding a Role without adding its name does not
compile.

### (c) Positional construction — counted, not touched

**151** positional `new …Service(...)` sites in specs. **The widest is `WebhooksService` at six
arguments, in nine files.** `OutboxPollerService` has eight sites in one file, also at six. 42 of
the 151 are `new PrismaService()` with no arguments at all, where order cannot be wrong.

---

## 2 · The options, and what each catches

**Option A — one shared double implementing the interface.** Catches an added method, a removed
method, and a changed parameter type. Removes the ×5. *Cost:* a shared instance is state shared
between spec files in parallel workers — one spec's override visible to another, invisible until two
files happen to run together, which is a worse class of defect than duplication.

**Option B — type the existing copies in place.** Same catches, per copy. *Cost:* near zero, no
shared state, and no reduction in duplication: five copies must still each be edited, loudly rather
than silently.

**Option C — a narrow contract, `Pick<StripeService, "theMethodsThisSpecUses">`.** Lowest ceremony.
Catches a removed method and a changed signature of the methods it names — **and not an added
method**, which is the case that actually bit ADR-094. The requirement excludes it.

**What was built is A with B's cost structure:** one double, exported as a **factory** rather than
an instance, so each caller gets its own. The shared-state objection is answered by construction
rather than by discipline.

**`implements StripeService` is not available, and the reason is worth knowing before someone tries
it:** the real class has private members, TypeScript treats those nominally, and a class implementing
another class with privates is rejected outright. The contract is a mapped type over
`keyof StripeService`, which keeps exactly the public surface.

**What none of these catch, said plainly so the mechanism is not read as wider than it is:** a change
of *meaning* under an unchanged signature. If `retrieveProcessingFee` began returning the fee in the
settlement currency rather than the charge's, every double would still compile and still lie. No type
system sees that; only a test against the real thing does.

---

## 3 · Falsification — four changes, and the mechanism catches two of them *in the double*

Each was applied to the real `StripeService` with the doubles untouched, typechecked, and reverted.
**Every one fails the build at gate step 8 of 12, `Typecheck`** — but where it fails differs, and the
difference is the honest limit of this mechanism:

| change to the real service | fails **in the double**? | the error |
|---|---|---|
| a method **added** (`listDisputes`) | **yes** | `test/fixtures/fake-stripe.ts: TS2741: Property 'listDisputes' is missing … but required in type 'StripePublicApi'` |
| a **parameter type** changed (`string` → `{ id: string }`) | **yes** | `test/fixtures/fake-stripe.ts: TS2322 … Types of parameters … are incompatible` |
| a **parameter added** (arity 2 → 3) | **no** | `src/processor-fee/processor-fee.service.ts: TS2554: Expected 3 arguments, but got 2` — the callers only |
| a **return type** changed (`bigint` → `number`) | **no** | `TS2322` at the callers and inside the service; the double returns `null`, which satisfies both |

**Why the last two escape the double:** a function taking fewer parameters is assignable to a type
taking more, and a double returning a value that satisfies both the old and new return types is not
wrong under either. The build still breaks — but at the call sites, so a change that updates the
callers can leave the double quietly narrower than the thing it stands for.

---

## 4 · What stays outside the mechanism, named rather than closed

- **`FakeRedisClient`** (`token.service.spec.ts`) stands in for a third-party client, not for one of
  our services. A contract for it would be a contract against `ioredis`'s types, which is a
  different decision with a different owner.
- **71 `as any` assertions in 15 spec files.** Every one is a place where the compiler was told to
  stop checking, and no type-level mechanism can reach past them by construction. Recorded as
  **OC-18**, because narrowing them is a spec-by-spec judgment and not one change.
- **The 31 `ConfigService` stand-ins** retype the product's configuration with nothing comparing
  them to it. Same row.

---

## 5 · Positional construction is recorded, not repaired

**Deliberately out of this pull request.** It is 151 call sites and its own axis of risk; changing
doubles and construction order together would make the next failure unattributable, which is
ADR-058's lesson. Recorded as **OC-19** with the measured numbers and the price ADR-094 paid: a
dependency inserted before `logger` silently shifted every argument after it at eight call sites,
and the failure surfaced as `this.logger.setContext is not a function` — at runtime, in seven tests,
naming nothing about the real cause.
