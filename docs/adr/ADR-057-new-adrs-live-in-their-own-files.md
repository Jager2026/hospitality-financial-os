---
title: ADR-057 — New ADRs live in their own files
version: 1.0.0
status: Accepted
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-057 — New ADRs live in their own files, and the existing fifty-six stay where they are

**Status:** Accepted (Sprint 14)

**This document is the first ADR in `docs/adr/`, and it is the decision that put it there.**

---

## Context

`ARCHITECTURE_DECISIONS.md` conflicts on merge whenever two branches add an ADR, and it has done so twice in one sprint: #101/#102 (ADR-050 and ADR-051) and #105/#107 (ADR-052 and ADR-054).

**The #110 closure established the cause as the file's format, not the merge order.** Both pairs inserted text immediately before the same line — `## Superseded / Retired`, the file's last section — so their diff hunks overlapped and git could not order them. **Neither conflict involved a single line of shared content.** Merge order decides only *when* the conflict surfaces; the second PR to land always hits it. Appending at end-of-file instead would collide identically, because two branches appending at EOF is the same overlap.

The cost is real and recurring: every second documentation PR needs a rebase, a conflict resolution, and a restarted CI run.

---

## The migration that was estimated and rejected

Splitting all fifty-six existing ADRs into files was measured before being proposed, not guessed:

| | |
|---|---|
| ADRs in the monolith | 56 |
| lines | ~1,570 |
| prose mentions of `ADR-NNN` across docs and code | ~1,320 |
| references to the filename `ARCHITECTURE_DECISIONS.md` | 40 |
| anchor links `](#adr-0NN)` | **0** |
| tools parsing the file | **0** |

Most of that is reassuring — the 1,320 mentions are prose, not links, and would not need rewriting; there are no anchors and no tooling to update. The real work is 40 filename references, frontmatter for 56 files, an index, and the split itself: **roughly two and a half hours.**

**It was rejected on risk, not on time, and the Founder chose this narrower option on that argument.** A mechanical split of a 1,570-line file can silently drop an ADR, and **nothing currently checks that file's integrity** — so the split would have to be accompanied by its own proof that concatenating fifty-six files reproduces the original body byte for byte. Constructing that proof under the pressure of an in-flight migration is exactly the situation in which a subtle loss goes unnoticed.

**Two homes for ADRs is a confusion. Losing an ADR is not recoverable by reading.** The confusion is honest, visible, and reversible; the loss is none of those.

---

## Decision

**ADR-057 and every ADR after it live in `docs/adr/`, one decision per file, named `ADR-NNN-slug.md`. ADR-001 through ADR-056 stay in `ARCHITECTURE_DECISIONS.md` and are not moved.**

The conflict class disappears for every future ADR — two new decisions are two new files, which cannot overlap — and the 1,570 existing lines are not touched.

**Three things make the split navigable rather than merely tolerable:**

- **`ARCHITECTURE_DECISIONS.md` says so at the top**, above its own first ADR. Without that line, a reader six months from now opens the file, sees it end at ADR-056, and has no reason to suspect there is anywhere else to look.
- **`INDEX.md` lists both locations**, because that is the file whose job is finding documents.
- **An invariant refuses the same ADR number in both places.** Cheaper than one day discovering two ADR-058s and having to decide which was real.

**The existing fifty-six may still be split later**, as its own piece of work with its own byte-identity proof. Nothing here forecloses it; this decision only stops the bleeding first.

---

## Consequences

**A reader must know to look in two places.** That is the cost, it is paid on every lookup, and it is mitigated by the pointer and the index rather than pretended away.

**The version invariant (ADR-056) covers these files unchanged** — it matches anything under `docs/` ending in `.md`, so `docs/adr/ADR-057-*.md` is included without an amendment. Verified by execution rather than assumed.

**Each ADR file carries its own frontmatter version.** A single ADR is now individually versionable, which the monolith never allowed: an amendment to ADR-054 previously moved the version of a document containing fifty-five other decisions.

**Numbering stays global and monotonic across both homes.** The invariant enforces uniqueness; nothing enforces contiguity, and nothing should — ADR-053 is deliberately reserved for the tips-ownership decision that was assigned and has not landed, and a gap that means "reserved" is more useful than a renumbering that hides it.