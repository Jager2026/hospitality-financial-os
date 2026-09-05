---
title: BLOCK_CLOSURE_117_156_PROCESS
version: 1.0.0
status: Active — closure report, findings shown not fixed
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# BLOCK CLOSURE — PR #117 → #156, part 3 of 4: the process

> "A remedy that fits the instance rather than the property leaves the property in place, and the
> next instance does not look like the last one."

**Scope: process only. No code, no configuration.** Part 1 covered documentation, part 2 the audit
axis, part 4 is the cleanup.

---

# 3.1 — The Founder's hypothesis is not verifiable, and this is the record saying so

**The observation.** After the session was moved into auto mode by an indirect route, the Founder
observed a drop in quality: more departures from the task as set, lost items, days spent on
side work.

**Not investigated, by the Founder's own decision, on the strength of a prediction I was asked to
make rather than test: the answer would be "cannot be established."** This entry exists so that the
question is not re-opened in a month and paid for twice.

**Why it cannot be established.** Three variables changed inside roughly one window:

1. the permission mode,
2. the removal of 926 permission rules,
3. the model.

**Nothing separates them.** There is no interval in which one moved and the others did not, so no
observation in the history can attribute an effect to any one of them. This is ADR-058's own
principle applied to the session rather than to a commit: **a cause is isolable exactly once**, and
that moment has passed.

**What could still be measured, and why it would not settle it.** Objective proxies do exist in the
git and GitHub history — the share of pull requests closed without merging, the number of rebases,
pull requests that needed a corrective follow-up, the distance between a task as set and the
content of the merge. Every one of them is a joint effect of all three variables. Measuring them
would produce numbers and no attribution, which is worse than no numbers, because a number invites
the reader to draw the conclusion it cannot support.

**And the shape of the wrong answer is worth naming, because it is the tempting one.** A plausible
mechanism could be written for any of the three — auto mode removes a checkpoint, fewer rules
remove a guardrail, a different model behaves differently — and each would read convincingly. **A
plausible mechanism is not evidence.** Confirming an observation by reasoning that fits it is how
this project already got a wrong diagnosis from a leftover process plus one passing run (ADR-045).

**Recorded conclusion: unattributable. Not "no effect" — unattributable.** The observation stands as
the Founder's, and it is not contradicted here.

---

# 3.2 — Stacked pull requests and the register, measured

## The stack cost, from the GitHub timeline rather than from memory

Thirty-eight merged pull requests in the block, plus one closed and two throwaway probes.

**Stacked at any point: four.** They are not visible in the current base branch, because GitHub
retargets a pull request automatically when its base merges — so a stacked pull request that
survived looks, afterwards, exactly like one that was never stacked.

| PR | Event | Cost |
|---|---|---|
| **#144** | `base_ref_deleted` | **Auto-closed** when `feat/email-provider-resend` was deleted by #143's merge. Reopened as #145. The PR #61 mechanism `CLAUDE.md` records, repeated |
| **#142** | `automatic_base_change_succeeded` | Retargeted silently |
| **#151** | `automatic_base_change_succeeded` | Retargeted silently |
| **#153** | `automatic_base_change_succeeded` | Retargeted silently, then needed a rebase and a hand-resolved conflict two weeks later |

**Force-pushes across the block: fifteen, over thirteen pull requests** — #126 alone has three, the
rest one each. That is the measurable trace of rebases and amendments; roughly **one pull request in
three** was rewritten after being opened.

**The instrument had to be corrected before any of this was believed, and the correction is the
interesting part.** The first query counted `base_ref_changed` events and returned **zero across all
forty-two pull requests**. That is not the event GitHub emits; the real one is
`automatic_base_change_succeeded`. **A filter on a string that never occurs returns a clean zero,
and a clean zero reads as "nothing is wrong."** Caught by asking for a positive control —
enumerating the event names that actually appear — rather than by trusting an empty result. See 3.3,
class 2.

## The register is the real shared insertion point, and ADR-060 did not remove it

**33 of 38 merged pull requests touched `docs/INDEX.md` — 87%.**

Of those, **19 wrote to the single `docs/adr/` row**, and **6 changed nothing else in the file at
all**: their entire register edit was that one line.

**This is exactly the file shape ADR-057 split `ARCHITECTURE_DECISIONS.md` to escape** — one
document every pull request must touch, with one insertion point, so that two branches conflict
**mechanically, regardless of content**. `IMPLEMENTATION_PLAN.md` already carries an entry saying
`INDEX.md` has become that file. The measurement above is that entry, quantified.

**And ADR-060 is the evidence that the remedy was aimed at the wrong thing.** It removed
`INDEX.md`'s own `version:` line — the cause of three of the four conflicts observed at #118–#121 —
and it worked for that cause. **Conflicts continued anyway.** In this session #152 and #153 both
came back `CONFLICTING`, both on the ADR row, both resolved by hand, and neither had a content
disagreement: two branches had appended a sentence to the same line.

**The version line was an instance. The single insertion point is the property.** ADR-060 removed
the first. The second is still there, and 19 pull requests in this block wrote to it.

---

# 3.3 — What broke more than once

Four classes were nominated. All four recur, with evidence from this block. **A fifth is added, and
it is the one that explains why several of the other four keep coming back.**

## 1. A check is present but is not evaluated

The original form: `a || b` never reaches `b`, so a documented sweep confirming the right comparison
appears in the expression certified vocabulary rather than behaviour, over a live cross-Organization
leak.

**This block, two more, both structural rather than logical:**

- `.github/scripts/check-doc-index.js` carries `// @ts-check` and appears in **no** tsconfig, proven
  by `tsc --listFiles`. The marker is read by nothing (part 1, S1).
- `repo-invariants.spec.ts` asserts *guarded route ⇒ its permission is in the contract*. The
  assertion runs and passes, and by construction cannot see a contract route nobody built or an
  unguarded route missing from the contract. Both directions of drift exist (part 2).

**The generalisation the block adds: the marker can be missing a mechanism, not just a branch.** A
`@ts-check` with no compiler, and an invariant whose iteration excludes the failing case, are the
same failure as a short-circuited `||` — something that looks like coverage and is not — arrived at
without any logic being wrong.

## 2. An instrument errs in its own favour

`CLAUDE.md` records three. This block produced **seven more, all mine**, which is the point: the
class does not need a bad engineer, it needs an instrument nobody checked.

| Instrument | What it produced |
|---|---|
| Production count wrapped in `try/catch` | Eleven `"n/a"` values that read as an answer, from a connection that never opened |
| `grep "^export function"` | A **false absence** — `callerWithSeededRole` is `export async function` |
| Link auditor, first run | Reported an ADR missing from a register that plainly cites it (matched by filename stem; the register names ADRs by number) |
| Route differ, attempt 1 | Five phantom unguarded routes — `@RequirePermission` is on the class |
| Route differ, attempt 2 | Two phantom undocumented routes — the contract pairs verbs on one line |
| Route differ, attempt 3 | Contract inflated 64 → 102 — routes quoted inside prose |
| Timeline query for base changes | **Zero across forty-two pull requests, from an event name that does not exist** |

**Two sub-shapes are worth separating, because they need different defences.**

- **The false finding.** A broken checker usually fails by *finding* something, and a finding is
  what an audit is looking for, so nothing about it feels wrong. Defence: a dirty fixture with a
  known answer.
- **The false absence, which is newer and harder.** A wrong identifier — a misspelled event name, a
  regex that under-matches — returns **nothing**, and nothing reads as *nothing is wrong*. **A dirty
  fixture does not catch this**, because the fixture is written with the same wrong assumption as
  the query. The defence is different: **a positive control taken from the real corpus** — list the
  event names that actually occur, list the exports that actually exist — before filtering on one.

**Stated as a rule: a search proves a string is present. It never proves one is absent, because
absence is a property of the pattern as much as of the corpus.**

## 3. Conditional silence

Five causes now, from four unrelated mechanisms plus one found in this block (part 2): a `paths`
filter, step ordering, a base-branch filter, a workflow-level `paths` producing no run at all, and
`pnpm --recursive run` exiting 0 with nothing to do.

## 4. Squash-merge against stacking

PR #61. Nine pull requests at #105–#109, none with a content conflict. This block: #144 auto-closed,
three retargeted silently, #148 closed because its content had already arrived under a different
SHA. **The cost is structural and does not require the work to overlap.**

## 5. The remedy fits the instance, not the property — and this is why the others return

The new one, and it has four instances in this block alone:

| Property | What was fixed | What was left |
|---|---|---|
| A document with one insertion point that every PR must write to | `INDEX.md`'s `version:` line (ADR-060) | The single ADR row. 19 pull requests wrote to it this block; two conflicted this session |
| A step whose failure silences later steps | The audit step moved last (ADR-072) | Step ordering itself — ADR-073 says so explicitly |
| Executable files no compiler checks | `// @ts-check` on the two named gates (#82) | The **hand-typed include list** that let them escape. Three files have escaped since |
| A secret reachable by a session | A rule about scratch files on disk | Access by any other route — a local process holding the production environment, execution inside the container (part 1, T10) |

**The shape is the same every time: the fix names the occurrence, and the occurrence's accidents are
carried into the fix.** `version:` was where the conflicts happened to land; the audit step was where
the skipping happened to start; the two gates were the files that happened to be found;
`ikey.txt` was the shape the secret happened to take.

**And the tell is available at the time, not only afterwards.** In each case the property had already
been written down somewhere — ADR-057 had named the file shape, ADR-045 had named the class of guard
that silently stops guarding — and the fix was narrower than the sentence describing the problem.
**When a remedy is narrower than the sentence that states the problem, that gap is the next
instance.**

---

# Carried to the fix pull request, so it is not lost

**The seventeen `not.toBe(200)` assertions (part 2) are in the "fix now" basket, as their own pull
request, after this diagnostic block — and the fix is NOT a blind replacement with `.toBe(403)`.**

Founder's correction, and it is established by fact rather than accepted on authority:

- `THREAT_MODEL.md:296` — **"Refused with 404, not 403. Confirming that a payment exists at a
  restaurant the caller may not read is itself the disclosure."**
- `restaurant-reachability.util.ts:180` throws `RESTAURANT_NOT_FOUND` with **404**.
- `API_Contract.md` states the same rule in three separate places, including
  `GET /payments/{id}/status` (*"still confirms that a specific payment exists"*) and
  `GET /memberships/{id}/wallet`, where an absent Wallet and an unreachable one deliberately return
  the identical error so the route cannot be an existence oracle.

**So the correct assertion is per route, not uniform.** Where existence disclosure is the concern —
payments, transactions, wallets, memberships, restaurants reached across an Organization — the
right answer is **404**, and asserting 403 would encode the behaviour this project explicitly
rejected. **403 is correct only where the resource is already known to be reachable and only the
permission is missing.**

**Which makes the blind fix worse than the current state, not merely incomplete.** `not.toBe(200)`
is weak but agnostic; `.toBe(403)` everywhere would be a specific, wrong specification, asserted by
a passing test — and a wrong test is harder to dislodge than an absent one.

**The work is therefore: classify each of the seventeen against the disclosure rule first, then
assert the specific status each route is supposed to return.**

---

# Found while running this pull request's own gate · **plan, with a trigger**

Part 1's gate produced one timeout. This one produced two, in different files, and together they
sharpen an entry `IMPLEMENTATION_PLAN.md` already carries.

**What failed:** `dashboard.service.spec.ts` and `analytics.service.spec.ts`, one test each, both
**timed out at 5.06 s against the 5000 ms default**. Both are real-database tests. Frontend green,
394 of 396 backend tests passing.

**Read from the log before anything was re-run**, and the log carries a second thing: the background
Outbox poller — real, because these specs boot the real `AppModule` — was failing repeatedly on
`Invalid tx.ledgerLine.findMany() invocation … Error creating UUID … found 'n' at 1`. The source is
not a mystery: `outbox-poller.service.spec.ts` deliberately writes
`payload: { journalEntryId: "not-a-valid-uuid" }` to exercise the retry-and-alert path, and those
rows are unpublishable by construction.

**Then a real experiment rather than a hopeful re-run: both files were run in isolation. 37 of 37
passed.** That discriminates interference from a defect in the specs themselves, which a second full
run could not have done.

**The new fact, and it is not what the plan's entry describes.** The database was reset immediately
before this run — `global-setup.ts` printed `outbox: 0 (0 unpublished)`. So this is **not**
accumulation across runs. It is **cross-file interference inside a single run**: one vitest worker
writes deliberately-poisoned rows while another worker's booted application polls the same database
every two seconds and errors on them.

**And the existing instrument cannot see this variant, for a reason worth stating.** It counts at
setup, and at setup the debris does not exist yet. Part 1 recorded that a finding printed before the
problem arrives is, in practice, a finding that arrives after it. This is that, in its strongest
form: not merely printed too early, but **measuring a quantity that is necessarily zero at the
moment it is measured.**

Not caused by this change, which is two Markdown files. **Basket: plan, with a trigger** — it
belongs to the existing "the suite should clean up after itself" entry, which should record that the
mechanism has two variants and that only one of them is currently observable.

---

# The baskets, collected

**Plan, with a trigger** — the register's single insertion point, which ADR-060 left in place and 19
pull requests wrote to this block. The options are already recorded in `IMPLEMENTATION_PLAN.md`
(split it, generate it from frontmatter, or accept the conflicts); this part adds the measurement,
not a decision.

**Accept and record** — 3.1 as unattributable, closed rather than open · the stack cost as measured,
four stacked of thirty-eight, one auto-closed · the fifth recurring class, and the false-absence
sub-shape of the second, with the positive-control defence it needs · the suite-interference variant
above, which the existing counter cannot observe.

**Carried forward** — the 403-versus-404 classification above, which belongs to the fix pull request
and must be settled before a single assertion is changed.
