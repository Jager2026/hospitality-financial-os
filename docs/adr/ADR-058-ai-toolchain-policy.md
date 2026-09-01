---
title: ADR-058 — AI toolchain policy: plan mode default, permission rules, PR template
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-058 — AI toolchain policy: plan mode default, permission rules, PR template

**Status:** Accepted (Sprint 14)

---

## Context

`AI_WORKFLOW.md` v2.0 wrote down how this project actually works — task format, one axis of risk per PR, standing requirements, how the queue is kept. **All of it was convention.** A convention is followed until the session where it is not, and nothing in the repository could tell the difference.

Three of its rules are mechanisable, and this ADR mechanises them.

**The evidence that convention alone is insufficient is already in this repository.** `.claude/settings.local.json` had accumulated **914 individually-approved allow rules** — every one a decision made once, in a hurry, in a permission prompt, and never revisited. That file is machine-local and gitignored, so none of those decisions was ever reviewed, and a second machine starts from nothing.

---

## Decision

### 1. `plan` is the default permission mode, committed to the repository

`.claude/settings.json` is checked in with `permissions.defaultMode: "plan"`.

**This turns `AI_WORKFLOW.md`'s steps 1–4 into a gate rather than an intention.** Understanding the problem, locating the module and designing before coding are what plan mode enforces structurally: no edit happens until a plan is approved. The step that used to be *"never start coding immediately"* — the single best line in v1.0 — becomes something the tool refuses rather than something a session remembers.

**Committed, not local.** The 914-rule file is exactly what a machine-local policy becomes; a policy that exists on one laptop is not a project policy.

### 2. Permission rules, chosen from what this repository actually runs

Every pattern below was derived by searching `package.json` scripts, `.github/workflows/`, `railway.*.json` and the documents — not from a general idea of what is dangerous.

**`ask` — irreversible or outward-facing, one confirmation each:**

- `git push` — publishes; the first outward-facing act in most sessions.
- `stripe` — touches a real payment provider.
- `railway` — touches production infrastructure.
- **`prisma migrate deploy` in all five real forms**: the raw command, `npx`, and the three `pnpm` wrappers (`pnpm prisma:migrate:deploy`, `pnpm run prisma:migrate:deploy`, `pnpm --filter backend run prisma:migrate:deploy`, the last being the one `railway.backend.json` runs on deploy).
- **`prisma migrate dev`** — creates migrations, and `SPRINT_0_SCHEMA_AUDIT.md` documents `--create-only` as this project's route for hand-written SQL migrations. Real, used, and it writes to a database.
- **The three `db:reset` wrappers** — `pnpm db:reset`, `pnpm run db:reset`, `pnpm --filter backend run db:reset`. See below for why these are `ask` and the raw command is `deny`.

**`deny` — no confirmation available:**

- **The raw `prisma migrate reset` forms**, plain and via `npx`.
- **Reading real env files**: `./.env`, `./.env.local`, `./apps/backend/.env` (the only real one on disk today) and the `**/` forms. Derived from `.gitignore` and confirmed against `git ls-files`. **`.env.example` stays readable** — it is tracked, contains no secrets, and is how a new machine is set up. No deny pattern matches it, verified rather than assumed.

### 3. The second shell is removed rather than mirrored

**Every `Bash(...)` rule above is silently bypassable through PowerShell, and this was measured, not assumed.** A temporary `Bash(echo DENYTEST *)` deny rule was added, exercised against a known-answer pair, and removed:

| Command | Tool | Result |
|---|---|---|
| `echo DENYTEST plain` | Bash | **denied** |
| `FOO=1 echo DENYTEST envprefixed` | Bash | **denied** — the matcher does handle an env prefix, the opposite of what was expected before running it |
| `echo DENYTEST viapowershell` | **PowerShell** | **ran, output returned** |

The third row is the finding: **PowerShell is a separate tool with its own permission namespace**, and a rule written for `Bash` does not constrain it at all.

**The response is to remove the second shell, not to duplicate every rule into it.** `.claude/settings.json` sets `env.CLAUDE_CODE_USE_POWERSHELL_TOOL` to `"0"`, so the tool is not offered and there is one shell for a rule to be written about.

**Why not mirroring** — it was implemented first and then withdrawn. Mirroring works only for the rules that exist at the moment someone remembers to mirror. Every future rule inherits the obligation, the duplicate is invisible when it is missing, and a missing duplicate is not a cosmetic gap but an open hole in exactly the rule someone cared enough to write. It is the same decay this document describes elsewhere: a mechanism whose correctness depends on nobody forgetting a step is a mechanism with a scheduled failure. Removing the tool has one failure mode instead of one per rule.

**The cost, stated rather than buried: this makes the whole permission policy conditional on the PowerShell tool actually being absent.** That is precisely the shape `CLAUDE.md` warns about — *a conditional guard is only as reliable as the thing it is conditional on* — and it is accepted deliberately, because the alternative distributes the same dependency across every rule instead of concentrating it in one checkable place. **It must be checked rather than assumed** (see Consequences).

**`ask` and `deny` are written so they do not overlap.** Deny covers `migrate reset` only; ask covers `deploy` and `dev` only. Precedence between the two lists is therefore never load-bearing — a property chosen deliberately, because precedence is exactly the kind of assumption this project has been wrong about before.

**No `allow` rules in this file.** Adding them here would re-create the 914-rule problem with a commit behind it. Routine approvals stay machine-local in `settings.local.json`, which `.gitignore` already excludes.

### 4. A pull request template

`.github/pull_request_template.md`, with the section this project needed most: **what was RUN, with results, versus what was written but not run.** `IMPLEMENTATION_PLAN.md`'s Definition of Done has required that distinction for eleven sprints; the template is where it stops depending on anyone remembering. It also asks for falsification evidence, docs version bumps, and **the CI result of the head commit rather than the fact of a push** — a distinction that once went unnoticed for two entire sprints.

---

## Alternatives

**`bypassPermissions` as the default — rejected.** It is the mode that makes every session faster and removes the last mechanical check between a plan and a destructive command. This project's own history is the argument: a leftover server that made a falsification report wrong, a `git checkout --` that discarded a session's work, four hundred and sixty accumulated payment rows, and a production `agreement_acceptance` row written by a real registration. None of those were caused by a permission prompt being absent — but every one of them is the class of thing a prompt is the last chance to catch, and the mode exists precisely to remove that chance. **A tool that never asks cannot be the thing that notices.** For a codebase that moves money it is the wrong default at any speed.

**Mirroring every rule into `PowerShell(...)` — implemented, then withdrawn.** Reasoning in Decision §3: it protects only the rules that exist when someone remembers to mirror, and a forgotten duplicate is an open hole in exactly the rule someone cared enough to write.

**Hooks — deliberately deferred to their own PR.** Hooks execute commands on tool events and can block. They are the natural mechanism for "run the gate before a push" or "refuse a commit whose docs versions did not move", and each is a behavioural change with its own failure modes — a hook that silently does nothing is worse than no hook, and proving one fires requires its own falsification. Mixing them into this change would put configuration, documentation and executable event handlers on one diff, which is the axis-mixing `AI_WORKFLOW.md` forbids.

**CI checks for the PR template — also deferred.** A template is a prompt, not a gate: nothing yet fails when a section is left empty. Making it a gate means a workflow that parses PR bodies, which is a check on prose and therefore easy to build badly. It earns its own change, with the same discriminating-pair validation any parser in this repository gets.

---

## Consequences

**Plan mode changes how work starts.** A session now proposes before it edits, and the Founder approves a plan rather than discovering a direction in a diff. That is the intended cost: it front-loads the disagreement to where it is cheap.

**`db:reset` is `ask`, the raw `prisma migrate reset` is `deny`, and the split is not a compromise between them.** The first draft denied both, which would have blocked the documented precondition of a trustworthy test run — `IMPLEMENTATION_PLAN.md` states in those words that `pnpm run db:reset` is not hygiene but a precondition, after three suite failures caused by accumulated rows. A rule that ordinary work has to get past several times a session is the rubber-stamp pattern this project has already written down, arriving before it was even merged.

**The reasoning that resolves it: the danger of a reset is which database is on the other end, not which words are in the command.** `pnpm run db:reset` against the local development database is routine and expected several times a day; the identical command with a production `DATABASE_URL` in the environment is unrecoverable. A static pattern cannot tell those apart, because **the deciding value is not in the string being matched.** So the static rule is asked to do only what a static rule can do — be a gate, one deliberate confirmation at the boundary — and the raw forms, which have no sanctioned everyday use here, stay denied outright.

**The contextual check is a `PreToolUse` hook, in the next PR.** A hook sees the environment the command would actually run in, so it can refuse on the basis of the active `DATABASE_URL` rather than the command text. That is the check that is worth having, and it is deliberately not smuggled into a configuration-only change — it is executable behaviour with its own failure modes, and a hook that silently does nothing is worse than no hook.

**OPEN QUESTION — whether the `ask` rules produce a confirmation on this machine at all.**

The observation that raised it: this ADR's own `git push` **executed**, and `.claude/settings.local.json` holds 926 allow rules including `Bash(git push *)`.

**The first explanation offered for that was wrong and is corrected here, because the correction is the more useful record.** It claimed local settings outrank project settings, so a local `allow` beats a project `ask`. That is not how the rules are evaluated: **the lists from every level are merged, and the merged rules are evaluated `deny` → `ask` → `allow`, regardless of which file a rule came from.** File precedence governs scalar settings, not the outcome of a permission decision. On that reading an `ask` is not beaten by an `allow` at all, and the observation needs a different explanation.

**The more likely one: the session was running in Accept-edits mode.** That is a property of the session, not of the rules — a mode can relax confirmations no matter which file the rules live in — and it is consistent with an `ask` rule producing no visible prompt while every `deny` continued to fire.

**And the fact that makes both explanations premature: the model cannot observe whether a prompt was shown.** What is visible from inside a session is that a command *executed*. Whether a confirmation appeared and was answered, or no confirmation was ever raised, is not in that signal. **"It ran" is not evidence of "it ran without asking"** — the earlier claim treated the two as the same thing, and that, not the precedence error, is the reusable mistake. Only a human watching the terminal can settle it.

**Procedure, for the Founder to run and record:**

1. Start a fresh session in this repository, in **Plan** mode.
2. Temporarily move `.claude/settings.local.json` aside, so only this committed policy is in effect.
3. Have the session attempt a `git push`.
4. **Observe directly whether a confirmation prompt appears.**
5. Restore `settings.local.json`.

**Result: _(to be filled in by the Founder)_**

What is *not* in question: the `deny` rules fire. That was observed by the refusal itself, which is a signal the model does receive — a denied tool call returns an error rather than a result. `apps/backend/.env` was refused while `apps/backend/.env.example` read normally, in the same session.

**The PowerShell tool must be confirmed absent, not assumed absent.** Decision §3 makes the whole policy conditional on it, so the condition is the thing to check. **In a fresh session started in this repository, an attempt to use the PowerShell tool should not be possible at all** — the tool should not be offered, rather than being offered and refused. The same `echo DENYTEST` pair that measured the gap is the cheapest way to re-run the check: with the tool gone, the Bash form is still denied and the PowerShell form has no route to attempt.

**What could not be established about that setting, stated plainly.** The variable is real — `CLAUDE_CODE_USE_POWERSHELL_TOOL` appears in the shipped `claude.exe`, its schema accessor is a tri-state boolean rather than a raw string, and the binary carries the string *"Set CLAUDE_CODE_USE_POWERSHELL_TOOL=1 to enable the PowerShell tool (preview)"*. **What could not be read out of a minified bundle is how that parser treats the literal `"0"`.** A tri-state boolean very probably maps it to false, which is the intent; if instead the raw non-empty string were tested for truthiness, `"0"` would read as *true* and enable the very tool it is meant to remove. That is this codebase's own documented trap — **the wrong falsy check is invisible until the case actually occurs** — and it is why the paragraph above asks for the tool's absence to be observed rather than inferred from the setting being present.

**Verification this ADR cannot do for itself.** Permission rules take effect for sessions that start after the file exists, and a running session cannot observe its own startup validation. **Whether Claude Code accepts every pattern, and whether `plan` is actually the mode on launch, is verifiable only by starting a new session in this repository** — the schema, the JSON, and the rule shapes were checked here; the runtime acceptance was not.
