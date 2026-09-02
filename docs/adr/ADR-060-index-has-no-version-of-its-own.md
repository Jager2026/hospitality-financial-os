---
title: ADR-060 — INDEX.md has no version of its own; a CI check replaces it
version: 1.0.0
status: Accepted
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-060 — `INDEX.md` has no version of its own; a CI check replaces it

**Status:** Accepted (Sprint 14), 2026-09-02

---

## Context

**Five consecutive pull requests conflicted on `docs/INDEX.md`, and every one of the five conflicts was on the same line.** #118, #119, #120, #121 and #126 — later joined by #127, #128 and #130 — each bumped INDEX's own `version:` from the same base to the same next number, and each merge after the first had to be resolved by hand. **Not one of them disagreed about content.** Three of the five touched no other line of the file at all.

This is the shape ADR-057 split the ADR log to escape: **a file every branch must touch, with a single insertion point, conflicts mechanically regardless of what the branches contain.** The `#105–#109` closure proved it for `ARCHITECTURE_DECISIONS.md` — nine conflicting PRs, none with a content conflict — and the backlog entry after #121 named `INDEX.md` as having acquired the same shape.

**What the version was for.** A document's version exists so a reader can tell whether the copy in front of them is the one being discussed. `INDEX.md`'s version told a reader nothing of the kind: it moved on every documentation PR by construction, because every documentation PR changes some row, so the number was a count of merges rather than a statement about content. What the register actually needs to be trusted for is **whether its rows agree with the documents they describe** — and a version number never checked that. The version-uniqueness gap recorded after #121 is the same point from the other side: nothing could tell a careful resolution of that line from a careless one.

**The check that would tell was already being run — by hand.** A shell loop comparing each `docs/*.md` frontmatter version against its INDEX row was executed at the end of every documentation PR for several sprints, by whoever happened to be doing the PR. It had caught real drift. It lived in a session's habit, which is the place this project has already recorded as where mechanisms go to decay (ADR-058; the `test/global-setup.ts` permission matrix; the instrument nobody read, backlog after #121).

---

## Decision

**1. `docs/INDEX.md` carries no `version:` in its frontmatter.** It is the one document in `docs/` without one, and it is the one document every PR touches. The exception is stated here so nobody re-adds the field for consistency's sake: consistency was the cost.

**2. `.github/scripts/check-doc-index.js` runs in CI, before the dependency scan, and fails the build when the register disagrees with what it registers.** Two directions, because a one-directional check passes for the wrong reason:

- every `docs/*.md` that declares a frontmatter `version:` has an INDEX row, and the row's version is the document's;
- every INDEX row that names a `docs/*.md` file points at a file that exists.

**It checks the number and nothing else.** The prose description in each row is hand-written and stays hand-written; the script does not read it.

**3. The ADR-056 invariant is unchanged.** It already skipped documents without a `version:` line — *"only documents that HAVE a version are covered"* — as a stated limit rather than a patched one. INDEX now falls under that limit by design. **Proven by execution, not by reading:** with INDEX changed and unversioned, the invariant passes; with a versioned document changed and unbumped in the same tree, it fails and names the document. The two halves of that pair are what make the first half evidence.

---

## Alternatives

**Generate `INDEX.md` from frontmatter — rejected, and the reason is worth keeping.** This was the candidate recorded after #121: make the file a projection rather than a source, so no branch edits it by hand and a merge is a rebuild. **Estimated at about four hours, not two, and the estimate is what decided it.** Frontmatter across the 22 documents carries `title`, `version`, `status`, `classification`, `owner` — and **no `description` field in any of them.** An INDEX row is a version plus, on average, 915 characters of prose accumulated over sprints: what changed, which ADR, what was found. That prose is not a projection of anything; it exists only in INDEX. Generating the file would first mean migrating 25 hand-written descriptions into 22 frontmatters — a content migration that cannot be done mechanically without loss, which is exactly ADR-057's own objection to migrating the fifty-six ADRs — and then every future documentation PR would edit the description in the document's frontmatter instead. **The conflicts would not disappear. They would move to the frontmatter, where at least they would be about content.** That is a real improvement and a real cost, and it is not the cheap half. **The descriptions are hand-written and remain so.**

**Keep the version and add a uniqueness check across open PRs — rejected.** It keeps the conflict and adds a mechanism to referee it. The line's only function was to conflict.

---

## Consequences

**Documentation PRs stop paying a toll that bought nothing.** Each of the five conflicts cost a rebase, a hand resolution, a re-verification that both sides' rows survived, and a CI rerun — for a line whose value nobody used.

**The register is now checked on every run rather than at the end of some PRs.** The hand-run loop is retired. A row that drifts from its document fails CI with the document's name in the message.

**The toll that remains is the honest one.** Two PRs that edit the same document's *row* still conflict — on the description, which is content. That conflict is worth having.

**One thing this does not check, stated so it is not assumed:** the description text. A row whose version is right and whose prose is stale passes. That is the limit of what a machine can be right about here, and it is the same limit the rejected alternative would have had.
