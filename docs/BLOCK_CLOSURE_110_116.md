---
title: BLOCK_CLOSURE_110_116
version: 1.0.0
status: Active — closure report, findings shown not fixed
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# BLOCK CLOSURE — PR #110 → #116

> "The trigger fired on time. That is the first thing in this report that is new."

Seven pull requests: #110 (the previous closure), #111 (AI_WORKFLOW v2.0), #112 (the pre-pilot gate moved to the route), #113 (the document-version invariant), #114 (`AgreementAcceptance` in `DATABASE.md`), #115 (two `INDEX.md` gaps), #116 (ADR-057, new ADRs in their own files).

**Findings are shown, not fixed.**

**The trigger worked.** `IMPLEMENTATION_PLAN.md` carried "NEXT BLOCK CLOSURE: after PR #114" and the closure was called on it, by the line rather than by anyone remembering. Last block that line did not exist and the pass was missed entirely.

---

# 1. Permission coverage — first by importance

**No new unguarded routes appeared.** The count is unchanged at **21 of 57 guarded, 36 not** — expected, since this block added one gate and no routes, but measured rather than assumed.

Parser re-validated against its known-answer pair before its output was believed: `analytics revenue/export` returns guarded, `auth/login` returns unguarded.

**The three from the #109 audit are all still open**, and none was in this block's scope:

| route | what it exposes | status |
|---|---|---|
| `POST /restaurants/{id}/onboarding-link` | **an action** — mints a Stripe onboarding link for the venue's connected account | open |
| `GET /restaurants/{id}` | `companyNumber`, `vatNumber`, `stripeAccountId`, payout status | open |
| `GET /tips/{id}` | one waiter may read another's tip at the same restaurant | open |

**The first is not a read**, and it is the one worth taking next: reachability is the entire rule on a route that acts on someone else's payment account.

---

# 2. Live verification against production

**The gate from #112 is deployed and refusing**, verified with a real request rather than by checking that the deploy succeeded:

| what | result |
|---|---|
| `POST /auth/register` with the placeholder version | **503 `REGISTRATION_UNAVAILABLE`**, with its own message |
| `GET /health` | 200 |
| `GET /agreements/current` | 200 |
| `plaintabs.com/register` | 200 |

**Production row state, read inside the container:** 11 users, **0 agreement acceptances, 0 probe rows.** The placeholder acceptance removed last block has not returned, and the gate is why it cannot.

**Nothing was created and nothing needed cleaning up** — the probe was refused, which is the behaviour under test.

**Still not verified live, unchanged from last block and for the same reason:** everything requiring live Stripe credentials — restaurants, payments, tips, wallet projection, refunds, chargebacks, #109's by-id permission fix, ADR-054's closed venue, ADR-052's erasure script. Covered by tests against a faked Stripe boundary, which is a weaker claim.

---

# 3. Document reconciliation

**`INDEX.md` now agrees with every document's frontmatter, and this time the agreement means something** — because versions actually moved. Checked mechanically across every document carrying a version.

**Two documents changed without a version bump, and both are inside a one-PR window:**

| document | commits in block | version moved |
|---|---|---|
| `API_Contract.md` | 1 | **no** |
| `IMPLEMENTATION_PLAN.md` | 1 | **no** |

Both changed in **#112**, which merged *before* #113 landed the invariant. **The invariant would have caught both.** That is the cleanest available evidence that it does what it was built for — the last unguarded PR in the repository is also the only one that slipped.

Not corrected here: fixing them means editing two documents, which under the new rule means bumping two versions, which is a change belonging to whichever PR next touches them.

**`THREAT_MODEL.md` unchanged this block**, correctly — nothing moved between open and closed. Its six open entries and Closed Threat #26 stand as written.

---

# 4. Contradictions between new ADRs

**None.** ADR-055, ADR-056 and ADR-057 were read against each other and against what they cite.

**One tension, already resolved in the text and worth repeating because it looks like a contradiction from outside:** ADR-050 records a guard that failed by depending on `NODE_ENV`; ADR-055 then gates registration on `NODE_ENV`. ADR-055 states the distinction explicitly — ADR-050's failure was a *build script* where nothing validated the variable, while ADR-055 runs inside the app, where `validateEnv` makes it a required enum with no default. **The rule is about whether the reading process validates the value, not about the variable's name.**

**ADR-056 and ADR-057 are complementary rather than merely compatible:** per-file ADRs mean a single decision is individually versionable for the first time, and the version invariant covers `docs/adr/` unchanged.

**The anchor-conflict finding from the last closure is now acted on** (ADR-057), on the narrower of the two options and for the risk argument, not the time one.

---

# 5. What remains unproven

Unchanged from the previous closure except where noted.

**Not verifiable in code:** backups encrypted; TLS termination; sub-processor completeness; Stripe's retention of the identity data it holds.

**Established by reading, not execution:** the three reachability-only routes above.

**Verified in development, never in production:** ADR-052's erasure script; ADR-054's closed venue; #109's by-id fix; the entire money path.

**Decided nowhere, and blocking something:**
- `AuditLog`'s two retention periods — no purge job can be written until it is decided.
- Whether `ipAddress`/`userAgent` are erased with a person. **Every erasure is partial until this is answered, and the script says so on every run.**
- DPA Art. 28(3)(g) wording — three framings offered, none chosen.
- The four Stripe support questions — no answer recorded.

**Never rehearsed:** restoring from a Railway volume snapshot.

**New this block, and small:** `ADR-053` is reserved for the tips-ownership decision, which was assigned, lost between sessions, and has not been reassigned. The number is held; the work is not queued anywhere.

**Closed since the last closure:** the pre-pilot gate is no longer a claim contradicted by production — it is enforced by the route, and production refuses.
