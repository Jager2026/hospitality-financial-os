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

**`deny` — no confirmation available:**

- **`prisma migrate reset` in all five real forms**, including the `db:reset` script wrappers, since `db:reset` *is* `prisma migrate reset --force`.
- **Reading real env files**: `./.env`, `./.env.local`, `./apps/backend/.env` (the only real one on disk today) and the `**/` forms. Derived from `.gitignore` and confirmed against `git ls-files`. **`.env.example` stays readable** — it is tracked, contains no secrets, and is how a new machine is set up. No deny pattern matches it, verified rather than assumed.

**Both `Bash(...)` and `PowerShell(...)` for every rule.** This is the one finding that changes the policy's shape rather than its content: **PowerShell is a separate tool with its own permission namespace**, it is actively used here (it appears throughout the 914 accumulated rules), and a rule written only for `Bash` is bypassed by the other shell without anyone intending to bypass anything.

**This was measured, not assumed.** A temporary `Bash(echo DENYTEST *)` deny rule was added and exercised against a known-answer pair before being removed: the plain Bash form was denied, and the identical command issued through **PowerShell ran and returned its output**. The same test corrected a second belief in passing — an env-prefixed form (`FOO=1 echo DENYTEST …`) was *also* denied, so the matcher does handle env prefixes, which is the opposite of what was expected before running it. Both results matter: one justifies the mirroring, the other is a reminder that a pattern's reach is worth measuring rather than reasoning about.

**`ask` and `deny` are written so they do not overlap.** Deny covers `migrate reset` only; ask covers `deploy` and `dev` only. Precedence between the two lists is therefore never load-bearing — a property chosen deliberately, because precedence is exactly the kind of assumption this project has been wrong about before.

**No `allow` rules in this file.** Adding them here would re-create the 914-rule problem with a commit behind it. Routine approvals stay machine-local in `settings.local.json`, which `.gitignore` already excludes.

### 3. A pull request template

`.github/pull_request_template.md`, with the section this project needed most: **what was RUN, with results, versus what was written but not run.** `IMPLEMENTATION_PLAN.md`'s Definition of Done has required that distinction for eleven sprints; the template is where it stops depending on anyone remembering. It also asks for falsification evidence, docs version bumps, and **the CI result of the head commit rather than the fact of a push** — a distinction that once went unnoticed for two entire sprints.

---

## Alternatives

**`bypassPermissions` as the default — rejected.** It is the mode that makes every session faster and removes the last mechanical check between a plan and a destructive command. This project's own history is the argument: a leftover server that made a falsification report wrong, a `git checkout --` that discarded a session's work, four hundred and sixty accumulated payment rows, and a production `agreement_acceptance` row written by a real registration. None of those were caused by a permission prompt being absent — but every one of them is the class of thing a prompt is the last chance to catch, and the mode exists precisely to remove that chance. **A tool that never asks cannot be the thing that notices.** For a codebase that moves money it is the wrong default at any speed.

**Hooks — deliberately deferred to their own PR.** Hooks execute commands on tool events and can block. They are the natural mechanism for "run the gate before a push" or "refuse a commit whose docs versions did not move", and each is a behavioural change with its own failure modes — a hook that silently does nothing is worse than no hook, and proving one fires requires its own falsification. Mixing them into this change would put configuration, documentation and executable event handlers on one diff, which is the axis-mixing `AI_WORKFLOW.md` forbids.

**CI checks for the PR template — also deferred.** A template is a prompt, not a gate: nothing yet fails when a section is left empty. Making it a gate means a workflow that parses PR bodies, which is a check on prose and therefore easy to build badly. It earns its own change, with the same discriminating-pair validation any parser in this repository gets.

---

## Consequences

**Plan mode changes how work starts.** A session now proposes before it edits, and the Founder approves a plan rather than discovering a direction in a diff. That is the intended cost: it front-loads the disagreement to where it is cheap.

**`pnpm run db:reset` is now denied, and this is worth flagging rather than discovering.** It is the documented precondition for a trustworthy test run — `IMPLEMENTATION_PLAN.md` states that in those words, after three suite failures caused by accumulated rows. **Under this policy a session cannot run it at all**, and `deny` has no confirmation path. Recorded here because the Founder asked for reset denied in every found form, and this is the found form that ordinary work uses several times a session. **If it proves too tight, the one-line change is moving the three `db:reset` patterns from `deny` to `ask`** — which keeps the raw `prisma migrate reset` forms denied while letting the sanctioned local wrapper through with a confirmation.

**The `ask` rules are already neutralised on the Founder's machine, and no committed file can fix that.** Settings load user → project → **local**, so `.claude/settings.local.json` outranks this policy, and an `allow` there beats an `ask` here. It holds 926 such rules. The evidence is this ADR's own pull request: **its `git push` executed with no prompt**, because `Bash(git push *)` sits in that local allow list. The same collision covers `stripe docs` and 46 `railway` entries, `railway service *` and `railway variable *` among them.

The `deny` rules are unaffected — deny outranks allow, and no local rule allows `db:reset` or `migrate reset` in any case. Confirmed live alongside it: `apps/backend/.env` is refused and `apps/backend/.env.example` reads normally.

So this policy is fully in force on a fresh machine and **partially inert on the one it was written on**, until those specific local entries are deleted. That file is personal and gitignored, so the deletion is the Founder's to make. **The point generalises past this ADR: a project policy is a floor, and a local allow list silently raises the floor out from under it** — which is the 914-rule problem doing damage, not merely being untidy.

**Verification this ADR cannot do for itself.** Permission rules take effect for sessions that start after the file exists, and a running session cannot observe its own startup validation. **Whether Claude Code accepts every pattern, and whether `plan` is actually the mode on launch, is verifiable only by starting a new session in this repository** — the schema, the JSON, and the rule shapes were checked here; the runtime acceptance was not.
