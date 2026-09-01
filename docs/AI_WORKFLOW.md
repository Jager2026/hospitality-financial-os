---
title: AI_WORKFLOW
version: 2.1.0
status: Active
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
supersedes: AI_WORKFLOW v1.0 — reconciled below rather than discarded
---

# AI WORKFLOW

> "The process is what remains when nobody remembers to follow it."

**Scope.** How the Founder and the AI Technical Co-Founder work together day to day: how a task is written, how large it may be, what is always required, and how the queue is kept. **Not** how to think about engineering — that is `CLAUDE_RULES.md`, and this document deliberately does not restate it.

---

# Reconciliation of v1.0

v1.0 was written before the project had learned anything. Ten steps of the form *"Never start coding immediately"*, *"Write tests. Run tests"*, *"Prefer small commits"*. Gone through by category, the way `UX_MAP.md` was.

## Now mechanised rather than intended (ADR-058)

**Steps 1–4 of v1.0 — understand, understand the feature, locate the module, design first — are performed in `plan` mode, and approval of the plan is the gate before any code.** `.claude/settings.json` sets `permissions.defaultMode: "plan"` and is committed, so it is the project's policy rather than one machine's.

This is v1.0's best line — *"never start coding immediately"* — turned from a thing a session remembers into a thing the tool refuses. The same file carries `ask` rules for `git push`, `stripe`, `railway`, every real form of `prisma migrate deploy` and `migrate dev`, and the three `db:reset` wrappers; `deny` rules for the raw `prisma migrate reset` and for reading real env files. `db:reset` is `ask` rather than `deny` on purpose — **the danger of a reset is which database is on the other end, not which words are in the command**, and a static pattern cannot see that; the contextual check belongs to a `PreToolUse` hook in a later PR. The file also disables the PowerShell tool, so there is one shell for a rule to be written about rather than two namespaces to keep in sync.

It contains **no `allow` rules**, deliberately: `.claude/settings.local.json` had accumulated over 900 of them, each approved once in a prompt and never reviewed, and committing that pattern would only give it a commit behind it.

## Still true — kept

- **"Never start coding immediately."** The single best line in v1.0, and it survived everything.
- **Read the documents first, in dependency order.** Correct, and now enforced by the documents being genuinely authoritative rather than aspirational.
- **Locate the module. Never modify unrelated modules.** Sharpened below into one axis of risk per PR.
- **If behaviour changed, documentation changes too. Always.** Correct and load-bearing.
- **"Otherwise: Not Done."** The right closing note.

## Went stale — what the document says, and what actually happens

- **"Write tests. Run tests."** What actually decides whether a test counts is **falsification**: break the implementation, watch the test fail, restore it, watch it pass. This project has shipped tests that passed against a broken implementation, and tests whose *names* claimed an isolation they did not achieve — both caught only by falsifying. v1.0 has no word for this.
- **"Self Review."** In practice, review is asymmetric: money and access code is read line-by-line, everything else rides on an honest session report. v1.0 describes one uniform pass that does not exist.
- **"Testing"** as one step, after implementation. In practice tests are how a claim is *established* — often before there is anything to fix, as with the measurement that preceded the by-id permission fix.
- **"Prefer small commits."** Wrong axis. Size was never the problem; **type** is. A large single-purpose PR is fine and a small one mixing an access fix with a document edit is not.
- **The document order in Step 1** lists `PRODUCT_REQUIREMENTS` and `API`, which do not exist under those names. `INDEX.md` is the live list.
- **Step 9's PR contents** are right as far as they go and omit what PR descriptions have actually had to carry: the falsification evidence, and what was verified live versus only by tests. **Closed by `.github/pull_request_template.md`** (ADR-058), whose sections are exactly those: business value, architecture and trade-offs, **what was RUN with results versus what was written but not run**, docs touched with version bumps, the CI result of the head commit rather than the fact of a push, and known limitations.

## Missing entirely — practice exists, the document does not

Everything in the sections below: the task format, one axis of risk per PR, the standing requirements, the words that are meant literally, how the queue is kept, and the block closure. All of it operates today. None of it was written down, which is why one of them silently stopped operating (see **Block Closure**).

---

# How a task is written

**The task itself is a single code block.** Decision and requirements, nothing else. Inside the block there is no retelling of the report that prompted it — that report has already been read, and repeating it back doubles the length of the thing that has to be executed precisely.

**Estimates, analysis, and reasoning go in the prose around the block**, addressed to the Founder. The two audiences are different: the block is executed, the prose is read.

**A task states what to do and what not to do.** An explicit boundaries list (*do not fix this here*, *do not start the mechanism*) has repeatedly been the difference between a focused PR and one that quietly grew.

---

# One axis of risk per pull request

**Size is not the constraint. Type is.** Large tasks are welcome — the erasure mechanism, the close-the-venue rename with its tests, the legal-claims verification were each substantial and each single-purpose.

**What is forbidden is mixing axes.** Permissions, a test refactor, and a document edit in one diff hide each other's failures: a reviewer reading a hundred lines of documentation is not reading the access check buried in the middle, and a red test in a refactor looks like the refactor rather than the security change.

Split by what could go *wrong*, not by what the files are called. Two changes to the same file with different failure modes are two PRs; two files serving one change are one.

---

# Standing requirements

These apply to every task without being restated in it.

**Verify by fact where production is concerned.** Not "the tests pass" — a real request, a real row, a real browser. Where the check needs credentials that are not available, **say so plainly and name what was therefore only covered by tests**. Working around a missing credential produces a report that claims more than it checked.

**Falsification is mandatory, and it is demonstrated rather than asserted.** Break the thing, show the test failing, restore it, show it passing. A PR description saying "falsified" without the result is a claim, not evidence. Falsification has twice caught defects in the falsification itself — an unimported symbol that made routes crash instead of deny, and a test whose name claimed more than it proved.

**Do not decide silently.** When the code disagrees with the task's premise, show the disagreement before acting on either. Several tasks in this project rested on a premise that turned out not to hold; each time, saying so was worth more than the work would have been.

**Show options, do not choose — where the decision is the Founder's.** Product and legal questions get a set of real options with their costs, including the option nobody likes. Engineering questions get a recommendation. Confusing the two wastes a round trip in one direction and takes a decision that was not ours in the other.

**Estimate before building anything larger than about two hours.** The estimate names what will break and what stays untouched, so the decision to proceed is made against a real cost rather than an optimistic one.

---

# Words that mean exactly what they say

The Founder and the AI Technical Co-Founder are not the only readers; tasks pass through other sessions and other tools. These carry an operational meaning that must not be paraphrased.

**"Мержи" — merge it. Not "мержу" — "I am merging".** The Founder does not merge by hand and has no reason to. A session without GitHub access cannot merge and must not imply that it has: the substitution once left **nine pull requests hanging**, each waiting on someone who believed the other had done it.

**"Оцени, не строй" — estimate, do not build.** The deliverable is a number and a list of consequences. Building anyway is not enthusiasm, it is spending the Founder's decision for him.

**"Установи фактом" — establish by execution.** Reading the code and concluding is precisely what this does not mean. A search over source text proves that a string is present; nothing more.

**"Покажи варианты" — show them all, including the one you would not pick.** An option omitted because it looks wrong is an option chosen by default when nobody argues for the others.

---

# The queue

**`IMPLEMENTATION_PLAN.md` is authoritative. Nothing else is.**

Three registers exist in practice, and only one of them is real:

1. **`IMPLEMENTATION_PLAN.md`** — sprints, deferred items, the block-closure trigger, the pre-pilot gate. **Authoritative.**
2. **The list at the end of a task** — a projection of (1). Useful, never additive.
3. **The line of not-yet-assigned work at the end of a reply** — also a projection. Useful, never additive.

**Work that exists only in correspondence is not in the queue.** This is not a preference. A task about the personal-data map was assigned, moved to a different session, and vanished — no trace with anyone, and it had to be assigned again from scratch. Nothing in (2) or (3) survives a session ending, a context window filling, or a chat being switched.

**Deferred work carries an explicit trigger, never "someday."** The trigger names the condition: *when a second consumer of the Outbox exists*, *when staging exists*, *after PR #114*. This demonstrably works — off-platform backup, staging, MFA and the vitest migration were all found again, months later, because each sat in the document with a condition attached.

---

# Block closure

**Every five merged pull requests, a closure pass. Five points:**

1. **Live verification against production** — the full product path, including everything added since the last pass. Real requests, real browser, real rows. Production cleans up after itself in one guarded transaction. Where production credentials are missing, name it rather than working around it.
2. **Permission-coverage audit** — every route either guarded or explicitly recorded as needing no guard, with the reason. **This point is newest and first by importance.** In one week, four unguarded routes were found, then three more; both times only because someone went looking. **Comparing the contract against the code cannot find this class** — a route with no permission agrees perfectly with a contract that names none. Any parser used here is validated against a known-answer pair, in both directions, before its output is believed.
3. **Document reconciliation, all of them** — not only the ones touched. `INDEX.md` versions against each document's own frontmatter; `DATABASE.md` against `schema.prisma`; `API_Contract.md` against the real controllers, routes, fields and permissions; `THREAT_MODEL.md` for anything closed that is still listed open, or the reverse.
4. **Contradictions between new ADRs** — whether a new one contradicts an earlier one, and whether a fix has invalidated reasoning recorded before it.
5. **The list of what remains unproven** — everything written down as "not verified", "consistent but not proven", or "established by reading rather than execution". Shown as a list, not fixed.

**The trigger is a line in `IMPLEMENTATION_PLAN.md`, not a counter in anyone's head.**

**Recorded plainly because it is the reason the line exists: the habit failed once already.** Five pull requests merged with no closure pass, and it was the **Founder** who noticed, not the process. A counter that lives in memory is not a counter — it is a thing that works until the moment it matters.

---

# Overlap with CLAUDE_RULES.md — shown, not merged

`CLAUDE_RULES.md` is the behavioural contract: how to think, what to value, what never to do. This document is the working process: how a task arrives, how big it may be, how the queue is kept. They meet in three places, and the overlap is **left in place deliberately** — the two documents are read at different moments, and a rule that only exists in the other one is a rule that is not read when it is needed.

- **Falsification.** `CLAUDE_RULES.md` states the standard (a test that would not fail against a plausible wrong implementation proves nothing). Here it is a *procedural* requirement: shown in the PR, not asserted.
- **Verification by execution.** There it is an epistemic rule about what a text search can prove. Here it is *when* the check happens — before the report, against production.
- **Documentation-first.** There it is a value. Here it is a step in closure point 3.

Neither document should be edited to remove its half. If they ever *disagree* rather than overlap, `CLAUDE_RULES.md` wins and this file is stale.

`CLAUDE.md` and `docs/CLAUDE_RULES.md` are byte-identical and enforced so by `repo-invariants.spec.ts`. Nothing in this document touches either.

---

# Done

Documentation, tests, architecture, security, review — and, since v1.0 did not say it: **the falsification shown, the live checks named, and the queue updated in the document rather than in the reply.**

Otherwise: not done.
