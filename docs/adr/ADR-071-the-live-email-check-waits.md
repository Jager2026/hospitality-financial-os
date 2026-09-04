---
title: ADR-071 — The live email check waits for the first real venue
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-071 — The live email check waits for the first real venue

**Status:** Accepted (Sprint 15), 2026-09-04. Documentation only — no code changed by this decision.

---

## Context

ADR-070 sends the invitation email, and said its wire is exercised in production and nowhere else — so a single live verification was the next step. Preparing it surfaced a problem that was not visible from the feature side.

**An invitation is scoped to an Organization, and production has none.** A read-only count taken inside the production container found 11 users, **zero Organizations and zero Restaurants**. So the check could not run without first creating one — and `RestaurantService.create` creates four things, in this order: a **Stripe connected account**, an Organization, an org-wide Owner Membership, and the Restaurant. The revoke script written alongside it withdraws exactly one of those: the invitation.

The question was therefore not *"how do we clean up?"* but *"what are we willing to create?"*

---

## Decision

**The live email check waits for the first real venue.** Nothing is created for the purpose of testing it. When a real restaurant onboards, the first invitation it sends is the verification.

### Why not extend the cleanup script

The obvious alternative was to make the revoke script remove the Organization and the Restaurant too. It was rejected on the shape of the tool it would require.

**Restaurant deletion in this system is soft** — `deletedAt` plus `status: INACTIVE`, the row stays (`restaurant.service.ts`). **Organization has no deletion path at all**, in the API or anywhere else. So a script that genuinely cleaned up would have to issue hard `DELETE`s against the database, bypassing the domain rules that deliberately do not offer this.

**A tool that can erase an Organization by hard DELETE, outside the domain rules, is more dangerous than the artefact it removes.** The artefact is one inert row. The tool is a permanent capability, sitting in the repository, that removes a company and everything hanging off it with no soft-delete, no audit trail, and no reachability check — built to tidy up after a smoke test. That trade is the wrong way round.

### Why not leave the artefacts deliberately

The second alternative was to create them and accept them, with the reason written down. Rejected because **that is precisely the root cause cleaned out in #110**: production accumulating test entities, one justified exception at a time, until nobody can tell which rows describe a business and which describe a past verification. The absence of a staging environment is what makes each such exception permanent, and the answer to "no staging" is not "use production carefully".

### The cost, accepted explicitly

**The email path is not verified live.** No message has been sent through Resend by this system, and the four questions the check would have answered — did it arrive, is the sender shown as `plaintabs.com`, is it in the inbox rather than spam, does the link work — remain unanswered.

**What the deploy already proved, and it is not nothing:** `RESEND_API_KEY` is required at boot with a shape check (ADR-069), so **production could not have started without a present, well-formed key**. Deployment `3615baf` reported success and `/health` returns `ok`. That establishes the key, the configuration and the boot path. It establishes nothing about delivery.

The rest is verified by the first real invitation, where the check costs nothing extra because the Organization exists for its own reasons.

---

## The scripts stay, and must not be run yet

`apps/backend/scripts/live-invitation-check.js` and `apps/backend/scripts/revoke-live-invitation.js` are **kept, not deleted**. They are the work already done and they are exactly what the first real venue needs.

**Neither may be run before a real Restaurant exists.** Running the check today is the decision this ADR declines, in a form that looks like a small operational step. Both files carry a header saying so.

**A comment is a note, not a mechanism**, and that is stated rather than glossed: nothing enforces this. The enforcement that exists is upstream and real — the check refuses to proceed without a Restaurant unless `--create-restaurant` is passed explicitly, so creating production data cannot happen as a side effect of running it.

---

## Consequences

**A closed test-mode connected account, `acct_1UBvb9B7fP2omx83`, exists permanently.** It was created by the probe that established this decision's central fact, and it is recorded in `THREAT_MODEL.md` under Accepted Risk with both Stripe quotations and the observation that the documentation predicted a refusal which did not occur.

**The probe was worth its own residue.** Without it, this ADR would have rested on the vendor's error table, which said closing our account shape is impossible. Executing it showed that closing succeeds and simply does not remove the object — the same conclusion for the Founder's purposes, reached for the right reason. **A prediction from documentation is not a fact about behaviour.**

**The ADR-059 precedent is named, not left to interpretation** (`THREAT_MODEL.md`): the probe closed an account, and closing is stronger than the disconnection ADR-059 forbids. Formally ADR-059 governs venues rather than our own test artefacts, so there is no conflict — but the reading is available, so the rule is restated where someone would look: **no connected account belonging to a venue is ever closed or disconnected, for any reason.**

**Not decided here:** whether the live check, when it eventually runs against a real venue, sends to the Founder's address or to a real staff member's. That is a question for the day it happens.
