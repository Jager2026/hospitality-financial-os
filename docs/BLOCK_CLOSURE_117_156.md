---
title: BLOCK_CLOSURE_117_156
version: 1.0.0
status: Active — closure report, findings shown not fixed
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# BLOCK CLOSURE — PR #117 → #156, part 1 of 4: what got lost

> "The trigger did not fire. Thirty-six pull requests went by, and the line that was supposed to
> notice was itself one of the things nobody read."

**Scope of this document: the documentation axis only** — decisions that did not reach the code,
triggers whose condition arrived unremarked, four documents checked against reality, and register
integrity. The audit axis (PR 2), the process axis (PR 3) and the cleanup (PR 4) are separate.

**Nothing here is fixed.** Every finding carries a basket: **fix now** · **plan, with a trigger** ·
**accept and record**. A finding that fits none of the three was not written down.

---

## How overdue, exactly

The Founder's estimate was fourfold. **It is worse, and the correction is recorded rather than
softened.**

| | |
|---|---|
| Last closure | `BLOCK_CLOSURE_110_116.md`, delivered by PR #117 |
| The trigger line in `IMPLEMENTATION_PLAN.md` | *"NEXT BLOCK CLOSURE: after PR #121."* |
| Pull requests merged since #116 | **36** |
| Prior cadence | 5 and 7 |

So the pass is roughly **five to six times** overdue, not four, and the mechanism written
specifically to prevent that — *"a counter that is not written down is not a counter"* — was
written down and still not read. **That is a finding about the mechanism, not about the reader:**
the line lives in a document nothing forces anyone to open, and it is checked by memory, which is
the failure it was built to replace.

---

# First by risk, on its own: the plan says the seed never runs

**Founder's ranking, and it sits above everything else in this document rather than among it.**

| | |
|---|---|
| `IMPLEMENTATION_PLAN.md` says | *"`railway.backend.json` runs migrations before a deploy and nothing else, so `seed.ts` has never executed automatically."* |
| `railway.backend.json` actually says | `"pnpm --filter backend run prisma:migrate:deploy && pnpm --filter backend run prisma:seed"` |
| The system | **Correct.** ADR-048 decided exactly this, and the seed is invoked **without** `--allow-revocations` — verified absent — so a divergence fails the deploy instead of revoking |
| The document | **Wrong**, and wrong about whether a deploy can silently remove permissions in production |

**Why this ranks first and the rest do not.** Every other finding here is read at leisure: a stale
tense, an unmapped table, a trigger nobody looked at. **This one is read in a panic.** The question
*"can a deploy revoke permissions?"* is asked during an incident, by someone who needs an answer in
seconds and will take it from the document that is authoritative for the queue. They will get
*"the seed never runs"* — reassuring, specific, and false at the premise.

A wrong answer under time pressure is not the same class of failure as a stale line. It is the
class where somebody deploys, or declines to, on the strength of it.

The detail worth keeping when the line is fixed is the one ADR-048 built the design around: **the
absence of `--allow-revocations` is the decision, and it is visible in the diff.** The corrected
sentence must say that, or the next reader gets a different wrong answer — that the seed runs and
may therefore revoke.

Full detail below at **S3**. Basket: **fix now**.

---

# 1.2 — Triggers, established by fact

Eighteen trigger-bearing entries. Each was checked against the system rather than by re-reading its
own condition. Production figures below were read **inside the Railway container** on 2026-09-05,
counts only, no column values:

```
user 11 · organization 0 · restaurant 0 · membership 0 · membershipInvitation 0
payment 0 · journalEntry 0 · ledgerLine 0 · outboxEvent 0
agreementAcceptance 0 · emailDelivery 0
```

## Fired, and nothing happened

### T1 — The block-closure trigger itself · **fix now**

Covered above. The line says #121; we are at #156.

### T2 — The Outbox has a second consumer, and still has no claim step · **plan, with a trigger** (the trigger has already fired)

`OutboxPollerService` selects `where: { publishedAt: null }` with `take: BATCH_SIZE` and marks a row
published only later. No `SELECT … FOR UPDATE SKIP LOCKED`, no claimed-at column, no advisory lock —
verified by reading the file, not by recalling the entry.

The plan gave this two triggers and said which one to fear:

> **A second Outbox consumer.** Requires no decision at all — it arrives through ordinary feature
> work. … **That sprint will be about the projection, not about concurrency**, and the person
> writing it has no reason to look at how rows are claimed.

**It arrived exactly like that.** ADR-069 made email the second consumer; `EmailOutboxService` is
injected into the poller and dispatched to on `event.eventType === EMAIL_OUTBOX_EVENT_TYPE`.

Three things follow, and they are not equally bad:

- **The prediction was right, in its own words, and the entry was not updated.** ADR-069 says the
  claim step "is still missing and is not fixed here" — so it was seen — but no work was scheduled
  and the plan still reads as though the trigger is pending.
- **The safety argument in the plan no longer covers what runs.** It rests on
  `WalletProjectionService` recomputing a balance in full, so a double dispatch is harmless. Email
  is not idempotent by that mechanism; ADR-069 supplies a different one (a `UNIQUE` constraint plus
  Resend's 24-hour idempotency key). That is adequate and it is *elsewhere* — the plan's stated
  reason for calm is now wrong about the system it describes.
- **The poller's own class comment is false.** It still says *"the only consumer,
  `WalletProjectionService`"*. The `dispatch()` method's comment, written later, is correct and even
  names the threshold. Two comments in one file disagree.

### T3 — The dependency audit's option B · **plan, with a trigger**

Trigger: *"revisit when the queue is not blocked."* The queue is not blocked. The condition arrived
quietly, as this class does.

**Note the interaction with ADR-073, established this week:** option B needs a second required
status check, and requiring a check is now known to be safe only when that check reports on every
pull request. A separate audit job has no `paths` filter, so it would — but the ordering rule from
ADR-073 applies regardless: the branch-protection edit is the last step, not the first.

## Not fired, correctly — but two rest on stale reasoning

| Trigger | Condition | Fact |
|---|---|---|
| **T4** Pre-pilot terms gate | before a real restaurant sees registration | `CURRENT_PLATFORM_TERMS_VERSION` is still `UNPUBLISHED-…`; `/terms` and `/privacy` render "not written yet"; production `register` refuses. Consistent, end to end |
| **T5** `AgreementAcceptance` on invitation accept | before the first venue onboards staff | 0 restaurants, 0 memberships. Still absent from the code — see A2 |
| **T6** Staging (ADR-035) | before the first pilot restaurant | 0 restaurants. **Its stated blocker is stale** — see below |
| **T7** Off-platform backup | before the first real payment | 0 payments, 0 journal entries, 0 ledger lines |
| **T8** Tokens to an httpOnly cookie | before the first pilot restaurant | `session.ts` still uses `localStorage` |
| **T9** `Role.name` stops doing two jobs | when Lithuanian arrives | only `en.ts` exists |
| **T11** Prisma 5→7 | none | still `^5.19.0` |
| **T12** MFA | none | no MFA code anywhere; the two grep hits are a comment and a redaction field |
| **T14** Error-rate monitoring / Sentry | first pilot restaurant or first production payment | neither |

**T6's blocker no longer holds · accept and record.** The plan defers staging for two reasons, and
one of them has expired: *"it is blocked: ADR-035 requires a second Stripe sandbox, and Stripe
integration is currently non-functional (`invalid_v2_key`, open with Stripe support)."* Stripe v2
account creation was exercised successfully during this block. **The deferral now stands on one
reason — prematurity — not two**, and that reason expires at the same moment the trigger does.

## Two conditions that cannot be checked as written

### T10 — Secrets in working files · **fired. The trigger is rewritten here, and the rewrite is the finding**

Trigger as written: *"before any secret with production scope exists on this machine."*

**Answered by the Founder: `RESEND_API_KEY` has never been on this machine** — it was pasted into
Railway from a browser. The question I raised has a clean negative answer.

**And the trigger fired anyway, by a route its wording does not describe.** The Founder's
correction, and it is the right one: the risk was never *storage*. It is **access**. Two instances,
both from this session, both established by execution rather than recalled:

- **The Stripe key's prefix was read inside the production container** to establish its mode. The
  value never left; the mode was established as fact rather than assumed. Still: that is a session
  reading a production secret.
- **`railway run --service backend` injects the whole production environment into a process on this
  machine.** My own diagnostic printed `DATABASE_URL host: postgres.railway.internal` — which is
  proof that the production `DATABASE_URL`, password included, was in a local process's environment.
  Nothing was written to disk, and the original entry is about files, so it would have called this
  clean.

**The condition, restated so it covers what actually happens:**

> **Any path that gives a session access to production secrets — a file on disk, a value in a local
> process's environment, or execution inside the production container.**

**Why the original wording missed it, and this is the reusable part.** It was written from the
incident that produced it — scratch files named `ikey.txt` and `env-backup-real` — so it described
**the shape of that incident** rather than the property that made it dangerous. A trigger derived
from one occurrence inherits that occurrence's accidents. `railway run` is not a scratch file, and
by the letter of the old condition it is not a secret on this machine either; by the property, it is
the same exposure with a shorter lifetime.

**Consequence: the options recorded under that entry no longer fit.** All three — an entropy scan of
the working tree, a scratchpad-hygiene rule, or accepting that no such file has ever been in the
repository — address files. None sees a process environment or a container session. **The entry
needs re-deciding against the new condition, not re-scheduling.** Not decided here.

### T13 — Refresh-token revocation surviving a Redis outage · **plan, with a trigger** (replace the trigger)

ADR-019's own condition fired long ago; the deferral is *"until after the frontend."* **"After the
frontend" is not checkable.** Nine pages exist and the frontend is plainly mid-build; nothing says
what "after" means, so the entry can never come due by its own terms. Recorded so the deferral is
re-armed with a condition someone can evaluate, not so the work is scheduled today.

## Three entries the plan calls open, which are closed

Each was true when written. None was revisited.

### S1 — "Executable files that no compiler checks — four remain" · **fix now**

Both named gates gained `// @ts-check` in **PR #82**, before this block. But the class regrew, and
this is the sharper half:

| File | `@ts-check` | Covered by a tsconfig | |
|---|---|---|---|
| `scripts/preflight-deploy.js` | yes | yes | fine |
| `.github/scripts/check-audit.js` | yes | yes | fine |
| `.github/scripts/audit-evaluate.js` | yes | yes (transitively) | fine |
| `.github/scripts/check-doc-index.js` | **yes** | **no** | **the annotation is inert** |
| `apps/backend/scripts/live-invitation-check.js` | no | no | added this block (#146) |
| `apps/backend/scripts/revoke-live-invitation.js` | no | no | added this block (#146); **it deletes rows** |

Established by execution, not by reading: `tsc -p tsconfig.scripts.json --listFiles` emits exactly
three project files. `check-doc-index.js` is not among them, so its `// @ts-check` is read by
nothing. **A file that carries the marker of being checked and is not is worse than one that carries
nothing** — it answers the question before anyone asks it.

**The root cause is the shape, not the omission.** `tsconfig.scripts.json`'s `include` is a
hand-typed list of two filenames. It is the decaying-list pattern `CLAUDE.md` names, and it has
already fallen three files behind.

### S2 — "Fixtures build their Role and Permissions from the seed" · **accept and record**

The plan calls this deferred and says *"the specs simply never followed."* They did.
`test/fixtures/authenticated-user.ts` exports `seededRole`, `callerWithSeededRole` and
`syntheticCaller`, and `repo-invariants.spec.ts` fails on any fixture pairing a seeded Role name with
a literal permission list. The entry is stale; the work exists.

### S3 — "the seed has never executed automatically" · **fix now — FIRST BY RISK, see the section above**

The plan says:

> `railway.backend.json` runs migrations before a deploy and nothing else, so `seed.ts` has never
> executed automatically.

**`railway.backend.json` today:**

```json
"preDeployCommand": [
  "pnpm --filter backend run prisma:migrate:deploy && pnpm --filter backend run prisma:seed"
]
```

**The system is correct — ADR-048 decided precisely this**, and the decision's load-bearing detail
holds: the seed is invoked **without** `--allow-revocations`, verified absent from the config, so a
deploy applies additions and *fails* rather than revoking on a divergence.

**The document is what is wrong, and it is wrong on the question with teeth.** Anyone checking "can
a deploy silently revoke permissions in production?" against the authoritative plan gets *"the seed
never runs"* — a reassuring answer, obtained from a false premise, about the matrix that decides who
can do what.

---

# 1.1 — Did each decision reach the code?

Thirteen ADRs, chosen by the same rule the Founder applies to review depth: those promising code that
touches **money, personal data, or access**. The remaining twenty-two — design, process, CI,
documentation — are deferred to a later pass.

**Reached the code, verified by reading it:** ADR-042 (`failOpen` in `redis-throttler.storage.ts`) ·
ADR-044 (`GET roles`) · ADR-046 (`rolePermission.delete`, seed.ts:177) · ADR-047
(`restaurant-reachability.util.ts` plus the inline-predicate invariant) · ADR-048 (above) · ADR-049
(`auth.controller.ts` writes the acceptance) · ADR-051 (`auth/active-memberships.ts`, one shared
filter) · ADR-052 (`redact-user.ts`, including the Stripe keys) · ADR-063 (no Stripe reference
anywhere under `dashboard/`) · ADR-066 (`Accountant` seeded) · ADR-067 (six `/export` and
`/export/by-shift` routes) · ADR-069 / ADR-070 (email and the invitation).

## A1 — ADR-061's waiter onboarding exists as columns and nothing else · **accept and record**

`User` carries `stripeAccountId` plus five Stripe status columns, and `redact-user.ts` treats them as
a linkage to a natural person's file at Stripe. **Nothing writes any of them.** There is no route and
no service; `apps/backend/src/stripe/` holds a service and a module, no controller.

This is defensible — ADR-061 is Model B, and Model B is blocked on a written answer from VMI or the
Bank of Lithuania (ADR-053) — but two documents currently describe a live linkage that cannot exist
yet, and nothing marks the columns as ahead of their flow.

## A2 — The pre-pilot gate covers one of the two paths that create a User · **plan, with a trigger**

`assertPlatformTermsPublished` has exactly **one** call site: `auth.controller.ts`.
`MembershipInvitationService.accept` creates a `User` (line 197) and a `Membership` (line 203) with
**no gate and no `AgreementAcceptance`**.

The plan names half of this — *"Two code paths must be closed before the gate can lift"* — and it
names the missing acceptance. **It does not name that the refusal is missing too.** In production
today `POST /auth/register` refuses, and `POST /memberships/invitations/accept` does not. ADR-070
made invitations actually deliverable two pull requests ago, so this is the path that now matters.

The existing trigger (T5) is the right one; it should be widened from "record the acceptance" to
"close both halves of the gate on this route".

## A3 — A docstring that describes a system that does not exist · **fix now** (in PR 4)

`agreement-versions.ts:21`:

> `/** Subject: User. Accepted at registration and at invitation acceptance. */`

The second half is false, per A2. One line.

---

# 1.3 — Four documents, checked against reality

## D1 — `PERSONAL_DATA_MAP.md` has drifted again · **fix now**

Its own opening claim: *"a factual inventory of every field that identifies a person"*, and *"Every
statement below was read out of `schema.prisma` and the service code, not recalled."* Both were true
at v1.2.0.

**Absent from the map, present in the schema:**

| Missing | What it holds |
|---|---|
| **`OutboxEvent`** — 0 mentions | Since ADR-070 its `payload` carries an invitation email's **body**, which is the recipient's address **and a live token granting membership**. Redacted on successful delivery; **retained indefinitely on permanent failure** — ADR-070 calls that "the honest residue" |
| **`EmailDelivery`** — 0 mentions | `to` and `subject`, one row per message, retained |
| **`Shift`** — 0 mentions | which person closed which shift, and when |
| **Six `User` columns** | `stripeAccountId` and five Stripe status fields. The map discusses `stripeAccountId` only under `Restaurant`, where it calls it *"the key to Stripe's own file on that individual"* — which is exactly what it is on `User`, for a waiter |

**The sharpening that makes this a specific failure rather than general neglect:** `DATABASE.md`
names **all twenty-four models**, `EmailDelivery` and `Shift` included. The schema *was* documented.
Only the personal-data consequences were not — and that is the document a privacy policy is written
from.

## D2 — `THREAT_MODEL.md` contradicts the code, checkably · **fix now**

`THREAT_MODEL.md:187` describes the dependency scan as *"currently green (with 4 known,
explicitly-justified, dev-tooling-only advisories ignored by id)"*.

`.github/scripts/check-audit.js:27`: `const IGNORED_ADVISORIES = {};`

The list is empty, and `IMPLEMENTATION_PLAN.md`'s own ADR-037 line says so correctly. Two Critical
documents disagree; the code settles it.

## D3 — `THREAT_MODEL.md:237` is written in a tense that has expired · **accept and record**

*"the first Weekly is three days out and the first Monthly six. Until 2026-09-01 there is no
monthly-depth recovery point at all."* That date has passed. The entry is now true in a way it says
it is not yet.

## D4 — `LEGAL_CLAIMS_VERIFICATION.md` holds, and rests on D1 · **accept and record**

Two claims were checked by execution and both are accurate: what we send Stripe at account creation
is `contact_email`, `display_name`, `identity.country` (plus `dashboard` and `losses_collector`,
which are not personal data), and the redaction description matches `redact-user.ts`.

**But its §5 argument cites `PERSONAL_DATA_MAP.md`**, which is the drifted document. The claims are
true today; the reasoning is anchored to a map that no longer covers the system. Re-verify after D1.

**`DATABASE.md`: no model-level drift found.**

---

# 1.4 — Register and links: clean

45 documents. **0** unregistered, **0** broken relative links, **0** ADRs unmentioned outside
`docs/adr/`.

This is a real result rather than an absence of effort, and the reason it is clean is that
`check-doc-index.js` runs in CI on every pull request — a mechanism, not attention.

**The instrument was falsified before its output was believed**, per `CLAUDE.md`: run against a
fixture that must come back dirty and one that must come back clean. **It produced a false finding on
the first dirty run** — it matched ADR files by filename stem, while the register names ADRs by
number, so it reported an ADR the index plainly cites. Fixed, then re-run in both directions.

---

# What this pass says about method

Three of the findings above came from checking a claim rather than reading one, and two of my own
instruments failed in my favour while doing it. Both are recorded because the second kind is the one
`CLAUDE.md` warns is quiet:

- A production count wrapped every model in `try/catch` and printed eleven `"n/a"` values. That is
  not an error, it is **an answer** — and it was produced by a connection that never opened. The
  real cause (`postgres.railway.internal` is not resolvable outside Railway) appeared only after the
  catch was removed.
- A grep for `^export function` reported that `callerWithSeededRole` did not exist, which would have
  been a striking finding — an invariant's failure message telling the reader to call a function
  nobody wrote. It is `export async function`. **The instrument under-matched, and an under-matching
  search produces a false absence** — the mirror of the false-finding class, and harder to notice,
  because nothing appears.

The generalisation worth carrying: **a search proves a string is present. It never proves one is
absent**, because absence is a property of the pattern as much as of the corpus.

---

# Found while running this pull request's own gate · **plan, with a trigger**

Not part of the audit axis, and recorded here because it was measured rather than encountered.

`apps/frontend/scripts/check-public-env.spec.ts:53` — *"refuses a loopback URL, in every spelling of
loopback"* — **timed out at 5967 ms against vitest's 5000 ms default.** Not an assertion failure.

**Diagnosed from the log before anything was re-run**, and the cause is arithmetic rather than a
shrug:

| | |
|---|---|
| Subprocess spawns in the failing test | **6** (`execFileSync`, one per loopback spelling) |
| Cost per spawn on this machine | ~0.8–1.3 s, read off the passing siblings in the same file: 1 spawn → 298 ms, 2 spawns → 1580/1763/2688 ms |
| Budget | 5000 ms, the default |

Six spawns do not fit. **The test's runtime is a function of process-spawn cost, and its budget is
not** — so whether it passes depends on the machine, which is why it passes in CI (it did, on #156,
today) and fails here. Backend: 64 files, 396 tests, all passing. Frontend: 33 of 34.

It is not caused by this change, which is two Markdown files. It belongs to PR 2's axis — a test
that can fail for a reason unrelated to the code under test — and it is left unfixed here on
purpose.

---

# The baskets, collected

**Fix now, ranked** — **S3 first and separately: the plan's false statement about the seed.** It is
the only finding here that gets read in a panic rather than at leisure, and the only one where a
wrong answer changes what somebody does in the next minute. Then: S1 (three unchecked scripts, one
of which deletes production rows, and the hand-typed include that let it happen) · D1 (the data
map) · D2 (the audit contradiction) · T1 (the trigger line) · A3 (the docstring).

**Plan, with a trigger** — T2 (the Outbox claim step; its trigger has fired) · T3 (audit option B) ·
T13 (re-arm with a checkable condition) · A2 (widen T5 to both halves of the gate) · the
spawn-bound test budget above.

**Accept and record** — T6 (staging now rests on one reason) · S2 (a closed entry to strike) · A1
(columns ahead of their flow) · D3 · D4.

**Answered, and it changed the entry** — T10. `RESEND_API_KEY` has never been on this machine. The
trigger fired by another route, its condition is rewritten above to cover access rather than
storage, and the three options recorded under it all address files and therefore no longer fit.

**Deferred to a later pass, by the Founder's own cut** — ADR→code for the twenty-two decisions about
design, process, CI and documentation; and claim-level reconciliation of the other twenty-two
documents.
