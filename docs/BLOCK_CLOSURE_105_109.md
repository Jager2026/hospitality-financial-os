---
title: BLOCK_CLOSURE_105_109
version: 1.0.0
status: Active — closure report, findings shown not fixed
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# BLOCK CLOSURE — PR #105 → #109

> "The counter fired and nobody noticed. That is part of the finding, not the preamble."

Five pull requests merged without a closure pass: #105 (erasure), #106 (legal-claim verification), #107 (close the venue), #108 (permission-scope measurement), #109 (the fix). The rhythm was not kept, and nothing in the repository was keeping it — the trigger lived in memory. The single code change in this report closes that.

**Findings are shown, not fixed.** Where something is unproven, it says so.

---

# 0. The finding that has nothing to do with code

**A real person registered on production today, and there is now one `agreement_acceptance` row naming a document that does not exist.**

Found while reconciling row counts during §1, not by looking for it. Production held 10 users at the start of this check and 11 at the end, with my own probe created and removed in between — the difference is a genuine registration at `2026-08-31T00:06Z`, and it wrote an acceptance against `UNPUBLISHED-no-terms-document-exists-yet`.

`IMPLEMENTATION_PLAN.md`'s "Blocking Gate Before The First Pilot Restaurant" says exactly this must not happen: *an acceptance pointing at a text that does not exist is not a missing record, it is a false one.* **The gate is no longer hypothetical — it has been crossed once.**

Not touched. It is real data and the decision is the Founder's: delete that one acceptance row, or publish the terms and let it stand as the first genuine acceptance. Either is cheap today and neither is cheap after a pilot.

---

# 1. Live verification against production

**Method:** real HTTP against `api.plaintabs.com`, a real browser against `plaintabs.com`, and real row reads inside the production container. Production cleaned up after itself in one guarded transaction.

## Verified live, in production

| what | result |
|---|---|
| `GET /health` | 200 |
| `GET /agreements/current` (ADR-049) | 200, both versions = the placeholder |
| `POST /auth/register` with `acceptedTermsVersion` | **201**, User created |
| the `agreement_acceptance` row it wrote | `PLATFORM_TERMS`, placeholder version, `restaurant_id` null, IP and user-agent captured |
| `POST /auth/register` with a stale version | **409** — ADR-049's `TERMS_VERSION_MISMATCH`, live |
| `POST /auth/login` | 200, tokens issued |
| `GET /auth/me` with the token | 200, memberships `[]` |
| `GET /auth/me` without a token | **401** |
| `plaintabs.com/register` in a real browser | renders; wordmark, three fields, **exactly one checkbox, unticked** |
| submitting it unticked | refused in-browser: *"Please agree to the Terms of Service before creating an account."* |
| `/terms`, `/privacy`, `/login` | 200 each — the links are not dead |

**Cleanup (ADR-039).** One transaction, guarded: refuse unless exactly one probe user exists, refuse if it holds any Membership, roll back unless the delete affects exactly one row. Result: 1 acceptance deleted, 1 user deleted, 0 probe users remaining. Verified by a second independent count.

## NOT verified live, and why

- **Everything requiring a live Stripe call** — creating a Restaurant, taking a payment, tips, wallet projection, refunds, chargebacks. `POST /restaurants` creates a real Stripe connected account; a payment creates a real PaymentIntent. **I do not hold production Stripe credentials and did not attempt to obtain them.** These are covered by the e2e suite against a faked Stripe boundary and by `critical-flow.e2e.spec.ts`, which is a weaker claim than the rows above.
- **#109's own fix** — the by-id permission checks. Exercising it in production needs a Restaurant and a Payment, i.e. the Stripe path above. Covered by `permission-scope.e2e.spec.ts` with falsification; **not observed in production.**
- **ADR-054's closed venue** — same reason.
- **ADR-052's erasure script** — run against the development database with falsification; **never run against production**, and deliberately so: it is a destructive manual act with no rehearsal target.

**One infrastructure fact worth recording.** The production database has **no public endpoint** — no `DATABASE_PUBLIC_URL`, no TCP proxy. `railway run` injects the environment but executes locally, where `postgres.railway.internal` does not resolve. Every row read and the cleanup above ran **inside the container** via `railway ssh`. That is a good security property and it is also the reason a write-then-clean-up check is only possible at all through that path.

---

# 2. Permission coverage — every route, classified

**Why this is first by importance.** In one week, four routes without a permission check were found, then three more, both times only because someone went looking. **Comparing the contract against the code cannot find this class**: a route with no permission agrees perfectly with a contract that names none.

**The parser was validated before its output was believed.** The first attempt in #109 read decorators in the wrong order and produced a page of phantom findings — the same bug `repo-invariants.spec.ts` already records. Rewritten to scan *forward* from each route decorator to the method signature, and checked against a known-answer pair in both directions: `analytics revenue/export` must come back guarded (it does), `auth/login` must come back unguarded (it does).

**Result: 21 of 57 routes carry `@RequirePermission`. 36 do not.**

## The 36, with a reason for each

**Public by design (10)** — `GET /agreements/current`, `POST /auth/register`, `/login`, `/refresh`, `/logout`, `POST /memberships/invitations/accept`, `GET /health`, `GET /currencies`, `POST /webhooks/stripe` (Stripe's own signature is the credential), `GET /roles` — this last one carries `@RequirePermission("membership.invite")` and is therefore **not** in this group; see the guarded list.

**Self-scoped — the caller is the only subject (4):** `GET /auth/me`, `GET /profile`, `PATCH /profile`, `GET /tips/me`. `ProfileService` has no authorization helper at all and needs none: it reads and writes by the `userId` in the token.

**Ownership-scoped by their own rule (5):** `GET /wallets`, `GET /wallets/:id`, `GET /wallets/:id/transactions`, `GET /memberships/:id/wallet`, `POST /wallets/:id/withdrawals`. `WalletService.assertReachable` refuses org-wide Wallets outright — a stricter rule than the shared helper, recorded in THREAT_MODEL.

**Guarded by a service-level permission check instead of a decorator (7):** `PATCH /restaurants/:id` (`restaurant.edit`), `DELETE /restaurants/:id` (`restaurant.delete`), `GET`/`PATCH /restaurants/:id/settings/tips`, `POST /memberships`, `PATCH /memberships/:id`, `PATCH /memberships/:id/disable` (`membership.manage`). These are protected; the decorator's absence is a consistency gap, not a hole.

**Membership-scoped, no permission required, and correct (4):** `POST /restaurants` (a user with zero Organizations must be able to create the first one), `GET /restaurants`, `GET /organizations`, `GET /memberships` — each returns only what the caller's own Memberships reach.

**Bespoke rule, protected but not by the shared helper (2):** `GET /organizations/:id` and `PATCH /organizations/:id`. `OrganizationService.update` requires **org-wide membership**, not a permission, because `seed.ts` has no organization-level Permission — and the code says so in a comment rather than borrowing an unrelated name. Correct today. **Latent:** the rule is "any org-wide member", so an org-wide Membership carrying zero permissions could rename the Organization. No such Membership is issued today.

**Reachability only — the same class #108 measured, not fixed here (4):**

| route | what it exposes |
|---|---|
| `POST /restaurants/:id/onboarding-link` | **an action**: mints a Stripe onboarding link for the venue's connected account |
| `GET /restaurants/:id` | `companyNumber`, `vatNumber`, `stripeAccountId`, payout status |
| `GET /tips/:id` | one waiter may read another's tip at the same restaurant |
| `GET /restaurants/:id/staff` | the staff list — plausibly intended (ADR-033's picker), never decided |

**The first is not a read.** It acts on the venue's payment account, and reachability is the entire rule.

---

# 3. Document reconciliation — all of them, not only the touched

## The finding: no version moved, so every version agrees with nothing

`INDEX.md` matches the frontmatter of every document it lists — and that consistency is meaningless, because **not one `version:` was bumped during the entire block.**

| document | commits in the block | version changed |
|---|---|---|
| `ARCHITECTURE_DECISIONS.md` | 4 (six new ADRs, 049–054) | **no** |
| `PERSONAL_DATA_MAP.md` | 4 (gained §6, erasure, soft-delete correction) | **no** |
| `THREAT_MODEL.md` | 3 (gained Closed Threat #26) | **no** |
| `API_Contract.md` | 2 (new AGREEMENTS section, three route changes) | **no** |
| `UX_MAP.md` | 1 (agreement block, Close A Venue) | **no** |

The numbers are stale in lockstep. A reader checking whether `ARCHITECTURE_DECISIONS.md` 1.42.0 includes ADR-054 has no way to find out.

## Other gaps

- **`LEGAL_CLAIMS_VERIFICATION.md` is not listed in `INDEX.md` at all.** Created in #106; adding it was missed.
- **`AgreementAcceptance` appears nowhere in `DATABASE.md`.** A model added by ADR-049 with two `CHECK` constraints, and the schema document does not mention it — the only model in `schema.prisma` absent from it.
- **Four documents carry no `version:` frontmatter**: `CONCEPT_VISION_RU.md` and the three `SEQUENCE_*` files.
- **`API_Contract.md` vs the controllers:** every route spot-checked is present, including the newest. `repo-invariants.spec.ts` already enforces that guarded routes state their permission — it does **not** check that every route exists in the document, and this reconciliation was done by sampling, not exhaustively. Stated as a limit.
- **`THREAT_MODEL.md`:** six entries in "Open, Not Answered", all genuinely open. Closed Threat #26 was moved correctly. Entry #9 remains reopened and should stay so — §2 above lists four routes still on reachability alone, which is exactly its stated closing condition.

---

# 4. Contradictions between the new ADRs

**None found.** ADR-049 through ADR-054 were read against each other and against what they cite.

**One tension resolved in the text rather than left implicit, worth naming because a reader of only the earlier document would draw the wrong conclusion:** ADR-045 made `NODE_ENV` required *so that guards could depend on it*; ADR-050 then removed a guard's dependence on `NODE_ENV` entirely. ADR-050 explains why (the protection does not cross a process boundary), so the pair is coherent — but ADR-045 alone still reads as an endorsement of the pattern ADR-050 abandons.

## The anchor conflict — format, not merge order

**Established, not guessed.** Two conflicts, both in `ARCHITECTURE_DECISIONS.md`:

- #101 / #102 — ADR-050 and ADR-051
- #105 / #107 — ADR-052 and ADR-054

Both branched from `main`. Both inserted text **immediately before the same line**, `## Superseded / Retired`, which is the file's last section. Two insertions at one anchor produce overlapping diff hunks, and git cannot order them. **Neither conflict involved a single line of shared content.**

**Merge order is not the cause.** It decides *when* the conflict surfaces — the second PR to merge always hits it — not *whether*. The pairs differed in order and the outcome was identical.

**The cause is that one file has exactly one insertion point.** Appending at end-of-file instead would not help: two branches appending at EOF collide the same way. The structural remedy is **one file per ADR** (`docs/adr/ADR-054-*.md`), where two new ADRs are two new files and never touch each other. Shown, not built — it is a repository-wide move with its own cost, including every existing cross-reference.

---

# 5. What is recorded as unproven

Everything from this block written down as "not verified", "consistent but not proven", or "established by reading rather than execution".

**Not verifiable in code at all** (from `LEGAL_CLAIMS_VERIFICATION.md`): backups are encrypted; TLS terminates correctly at the perimeter; the sub-processor list is complete; Stripe's retention period for the identity data it holds.

**Established by reading, not by execution:**
- The four reachability-only routes in §2 — the leak class is *measured* for the three #108 covered, and *inferred by the same reading* for these.
- `GET /restaurants/:id/staff` being intentionally open — nothing records the decision.

**Verified in development, never in production:** ADR-052's erasure script; ADR-054's closed venue; #109's by-id permission fix; the entire money path — payments, tips, wallet projection, refunds, chargebacks.

**Decided nowhere, and blocking something:**
- `AuditLog` needs two retention periods (transaction-connected vs not); nothing in the schema distinguishes them, and no purge job can be written until it is decided.
- Whether `ipAddress`/`userAgent` are erased with a person or retained as security records. Until decided, **every erasure is partial and the script says so on every run.**
- The DPA Art. 28(3)(g) wording — three framings offered, none chosen.
- The four Stripe support questions — sent or not, no answer recorded.

**Never rehearsed:** restoring from a Railway volume snapshot (THREAT_MODEL, and it cannot be rehearsed safely without staging).

**Claimed by a document and contradicted by production:** the pre-pilot gate — see §0.
