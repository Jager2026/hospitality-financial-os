---
title: BLOCK_CLOSURE_117_156_AUDIT
version: 1.0.0
status: Active — closure report, findings shown not fixed
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# BLOCK CLOSURE — PR #117 → #156, part 2 of 4: what does not work although it looks like it does

> "A step that ran, exited zero, and printed a success line for every package — having executed
> nothing."

**Scope: the audit axis.** Conditional silence across the whole of `.github/`, the scriptable forms
of a test that proves nothing, and the API contract against the controllers. Part 1
(`BLOCK_CLOSURE_117_156.md`) covered documentation; parts 3 and 4 follow.

**Nothing here is fixed.** Baskets as before: **fix now** · **plan, with a trigger** · **accept and
record**.

**2.3 — dead and half-built code — is deliberately absent**, cut by the Founder when the scope was
agreed. Recorded so its absence is a decision rather than an oversight.

---

# 2.1 — Conditional silence: the boundaries of the class

## Everything in `.github/`, enumerated

Six files: two workflows, three scripts, one pull-request template. One job each, fifteen steps in
`ci.yml` and eight in `e2e.yml`. Every condition:

| Where | Condition | Is silence distinguishable from passing? |
|---|---|---|
| `ci.yml` · `on.pull_request` | **none**, since #156 | Yes — it always runs |
| `ci.yml` · `on.push` | `branches: [main]` | Yes — every branch is covered by the pull-request trigger instead |
| `ci.yml` · the single job | fifteen steps in sequence | **No** — known cause 2: a failure at step *n* leaves *n+1…* reported `skipped`, neither pass nor fail |
| `e2e.yml` · `on.pull_request` | `paths:` | **No** — known causes 1 and 4: no workflow run at all, nothing on the page |
| `e2e.yml` · `Upload traces` | `if: failure()` | Legitimately conditional — an artefact of a failure, not a check |
| anywhere | `continue-on-error` | **Absent.** Checked; none exists |
| anywhere | `concurrency` / `cancel-in-progress` | **Absent.** So a superseded run is never reported `cancelled`, which would have been a sixth shape |

**One thing is worth recording as correct rather than as a finding.** `audit-evaluate.js` is the
only guard in the repository that names this class in its own code:

```js
class AuditUnavailableError extends Error { /* ... */ }
// "a gate that could not run its check must say so, never report success"
```

It refuses on a missing `advisories` key rather than reading it as zero advisories. That is the
distinction every other instance of this class failed to make, made explicitly, in the file.

## The fifth cause · **plan, with a trigger**

**`pnpm --recursive run <script>` exits 0 when no package has that script.** Established by
execution, twice:

```
pnpm --recursive run nonexistent-gate-step            -> exit 0
pnpm --recursive --filter=./apps/e2e run build        -> exit 0   (apps/e2e has no build script)
```

**Why this is a fifth cause and not a restatement of the other four.** All four known causes live
at the workflow, job or step layer: something decides whether a check *runs*. This one is **inside a
step that did run** — `pnpm run test` is `pnpm --recursive run test`, and the step exits 0, prints a
line per package, and turns the check green. The distinguishing property is new:

> **"Nothing to do" is reported identically to "did it, and it passed."**

### Its live form, and the honest severity

**Four of six workspace packages have a `test` script that is an `echo`:**

| Package | `test` script |
|---|---|
| `packages/shared` | `echo "no tests yet"` |
| `packages/types` | `echo "no tests yet"` |
| `packages/ui` | `echo "no tests yet"` |
| `apps/e2e` | `echo "e2e runs via test:e2e — see ADR-041"` — deliberate and documented |

**The exposure today is nil, and saying so is the point.** Each of the three holds exactly one
file — three lines, `export {}` and a comment saying it is empty until something needs it — and
**zero files import any of them.** There is no untested code. An earlier draft of this finding said
there was; measuring the line counts is what stopped it.

**The risk is the transition, and nothing marks it.** The day `packages/ui` gains its first real
component, the `Test` step keeps reporting success for it, and the `echo` is not something anyone
is prompted to revisit. `pnpm-workspace.yaml` is `apps/*` plus `packages/*`, so a new directory
joins the workspace automatically — in scope for the build, out of scope for the gate, with no
signal at the boundary.

**Trigger, phrased so it can actually be evaluated: when any of those three packages gains its first
importer, or its first file that is not the placeholder.**

**A smaller instance of the same thing, in my own working notes.** The first matrix I built for this
section reported `test: yes` for all six packages, because a `test` key exists in all six
`package.json` files. **An instrument reporting coverage that does not exist** — the class under
audit, one level up, in the thing doing the auditing.

---

# 2.2 — Tests that prove nothing, in the forms a script can see

Narrowed to the money and access-control specs (40 files), and to the two forms that are decidable
without judging semantics: a test block with no `expect` at all, and a block whose assertions are
**all** negative or existence-shaped.

**The scanner was falsified first**, on a four-case fixture: one test that must be flagged for having
no assertion, one that must be flagged for asserting only `not.toBe`/`toBeDefined`, and two that must
**not** be flagged. It returned exactly those two.

## The finding · **fix now**

**Seventeen assertions of the form `expect(res.status).not.toBe(200)` or `.not.toBe(201)`, and every
one of them is in an access-control end-to-end spec** — `permission-scope.e2e.spec.ts` and
`disabled-membership.e2e.spec.ts`. Six of them are in the tests that assert one Organization cannot
read another's payments, transactions and dashboards.

**Why the shape is wrong here, concretely.** `not.toBe(200)` passes on **403**, which is the intended
answer. It passes equally on 404, 500 and 502. So:

- A regression that turns a clean authorisation refusal into a crash **passes**.
- A change that removes the route altogether **passes**, because 404 is not 200.

**A test that still passes when the feature under test is deleted proves nothing about the feature.**
That is `CLAUDE.md`'s own standard — *a test only counts if it would fail against a plausible wrong
implementation* — and these are the tests standing over the exact leak class `CLAUDE.md` records
having shipped twice (`RestaurantService.findAllForUser`, `TipService.assertReachable`).

The fix is `.toBe(403)`. It is a test-only change and belongs in its own pull request.

## What the scan flagged that is not a finding

Recorded because an audit that reports only its hits is not reproducible.

- **Three "no assertion" hits in the Playwright specs are false positives of my own scanner.** It
  splits test blocks by counting parentheses without respecting string literals, and
  `expect(bodyBackground).not.toBe("rgba(0, 0, 0, 0)")` truncates the block early. All Playwright
  blocks do assert — checked by reading them.
- **Most of the fifteen weak-only hits are the correct assertion shape.** `expect(() =>
  assertBalanced(...)).not.toThrow()` for *"accepts a balanced posting"* is a positive claim written
  in the negative; *"produces a different hash for the same password on each call"* can only be
  `not.toBe`. A borderline case worth naming rather than counting: `harness.spec.ts`'s *"the design
  tokens are actually applied in the browser"* asserts `not.toBe("")` — weak in form, but the claim
  really is "a value arrived at all".

---

# 2.4 — The contract against the controllers: routes and permissions

Fields are out of scope by the Founder's cut. `repo-invariants.spec.ts` already covers one direction
for one subset — every **guarded** route states its permission in `API_Contract.md` — and it passes.
This looked for what that invariant cannot see.

## The instrument was wrong three times before its output was believed

Recorded in this much detail because it is the same trap `#126` and `#109` both fell into, and each
correction came from the real document having one convention more than the fixture:

| Attempt | What it reported | Why it was wrong |
|---|---|---|
| 1 | Five `AnalyticsController` routes unguarded | `@RequirePermission("reports.view")` is on the **class**. The fixture had no class-level decorator, so it could not have caught this |
| 2 | `PATCH /profile` and `PATCH /restaurants/{id}/settings/tips` undocumented | The contract pairs routes on one line — `GET /profile — PATCH /profile` — and only the first verb was read |
| 3 | 102 contract routes instead of 64 | Matching a verb anywhere on a line swept up routes quoted inside prose |

Validated at the end against the same known-answer pair the two previous closures used:
`analytics revenue/export` comes back **guarded**, `auth/login` comes back **unguarded**. Both correct.

## Result

**62 routes in the controllers. 67 declared in the contract.**

### Four documented routes are not built · **plan, with a trigger**

- `GET /transactions/{id}/refunds`
- `GET /refunds/{id}`
- `GET /transactions/{id}/chargebacks`
- `GET /chargebacks/{id}`

**These are the four #126 found, and none has been built since.** What makes them a finding rather
than a known gap is how the section reads: its preamble explains the design — refunds come through
Stripe's dashboard, chargebacks from the card network, *"Everything here is read-only"* — and then
lists four endpoints with **no marker saying they do not exist.** A frontend engineer coding against
this document has no way to tell.

**The contrast is in the same document and settles what "correct" looks like:** `GET /settings` and
`PATCH /settings` are also unbuilt, and the contract says so in the same line — *"future; not built
by Sprint 6"*. My scan flagged them too and they are **not** a finding. The difference is one clause.

### One route exists and is not declared · **accept and record**

`GET /health`. It appears in the document's prose but never as a route line. Infrastructure, not
product surface.

### Guarded routes: the count did not grow · **accept and record**

**36 of 62 routes carry no `@RequirePermission`.** The #110–#116 closure recorded **36 of 57**. Five
routes were added in this block and **all five are guarded**; the unguarded count is unchanged, which
is what that closure predicted and is now measured again rather than assumed.

The 36 are not a defect on their own — the classification from the #105–#109 closure stands, and it
covers `auth/login`, `auth/register`, `webhooks/stripe`, `health` and the reachability-scoped reads.
**This pass did not re-classify them**, and says so rather than implying it did.

### The hole neither check covers · **plan, with a trigger**

`repo-invariants.spec.ts` asserts: *guarded route ⇒ its permission is in the contract.* By
construction it cannot see either of these:

- **a contract route nobody built** — the four above;
- **an unguarded route absent from the contract** — because the invariant only iterates guarded ones.

Both directions of drift exist today in the first form. The second is currently empty but nothing
would report it, and 36 routes are eligible.

---

# The baskets, collected

**Fix now** — the seventeen `not.toBe(200)` assertions in the two access-control end-to-end specs.
A test-only change, its own pull request, and the only finding in this part that stands over a leak
class this project has already shipped twice.

**Plan, with a trigger** — the fifth silence cause, trigger being the first real file or first
importer in `packages/shared`, `packages/types` or `packages/ui` · the four unbuilt refund and
chargeback routes, which need either building or one clause in the contract · extending the route
invariant to the two directions it cannot currently see.

**Accept and record** — `audit-evaluate.js` as the one guard that already distinguishes *could not
check* from *found nothing*, and is worth copying · `GET /health` undeclared · the unguarded count
unchanged at 36, not re-classified here.

**Deliberately not done** — 2.3, dead and half-built code, cut when the scope was agreed.
