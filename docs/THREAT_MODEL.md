---
title: THREAT_MODEL
version: 1.15.0
status: Active
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# THREAT_MODEL

> "A threat model that lists what you haven't built is more honest than one that only lists what you have."

Purpose: not a from-scratch security exercise — a single place collecting the threats this project has *already* decided how to handle, each pointing at the specific ADR that made the call, plus an explicit, dated list of what genuinely has no answer yet because the code it depends on doesn't exist. Requested after external review (ChatGPT), confirmed by the Founder as worth having now, in parallel with Sprint 3 — not a Sprint 3 deliverable itself, and not a reason to pause it.

Every entry below cites a real ADR number and a real, already-existing mechanism (migration, guard, service method, test) — never a restatement in different words of what the ADR already says. If this document and the cited ADR ever disagree, the ADR is the source of truth (`ARCHITECTURE_DECISIONS.md`'s own stated purpose) and this file is stale.

---

# Closed Threats

## 1. Duplicate financial side-effects from a replayed webhook or retried request
**Threat:** Stripe redelivers a webhook (its own retry policy, or a network blip on our side), or a client retries a timed-out request — either way, the same financial event could be processed twice, double-crediting a Ledger account.

**Closed by:** ADR-004 — Idempotency as a Stateful Record. *"Introduce an `idempotency_keys` table: key, endpoint scope, request fingerprint hash, status..., stored response snapshot, `expires_at`. Incoming webhooks are deduplicated the same way, keyed by the provider's own event id."*

**Mechanism:** `IdempotencyKey` table (`schema.prisma`), enforced at the API contract level (`API_Contract.md`, Idempotency section — required `Idempotency-Key` header on financial endpoints; Stripe webhooks deduplicated by the provider's own event id, not a client-supplied one). Not yet exercised by a real webhook handler (Sprint 5 is the first caller) — the mechanism is built, unused, same status as the Outbox (see `EVENT_CATALOG.md`).

---

## 2. An unbalanced Ledger posting reaching the database
**Threat:** A bug in application code — or a raw SQL script, a bad migration, a future service that bypasses `LedgerService` — writes a `JournalEntry` whose `LedgerLine` rows don't sum to zero across debits and credits, silently corrupting the one invariant the whole product's reconciliation story depends on.

**Closed by:** ADR-002 — Ledger as Source of Truth. Two independent layers, not one: the in-process write-helper (`assertBalanced`, `LedgerService.postJournalEntry`) rejects a bad posting before any database write; a Postgres deferred constraint trigger (`ledger_line_balanced` / `check_journal_entry_balanced()`, `apps/backend/prisma/sql/ledger_integrity.sql`) rejects it again at commit even if the first layer is bypassed entirely.

**Mechanism, verified live, not assumed:** `ledger-trigger.integration.spec.ts` writes `JournalEntry`/`LedgerLine` rows directly through Prisma Client, deliberately never calling `assertBalanced` — the trigger is the only thing standing between the bad posting and the database in that test, and it rejects it. Additionally reproduced by hand this session via raw SQL against a freshly migrated database (`SET CONSTRAINTS ledger_line_balanced IMMEDIATE` inside a transaction, unbalanced debit/credit → `ERROR: JournalEntry ... is unbalanced`).

---

## 3. A JournalEntry's compensating-entry pointer disagreeing with its own entry_type
**Threat:** A row claims `entry_type = 'refund_issued'` but carries a `chargeback_id` instead of a `refund_id` (or any other mismatched combination) — a data-integrity bug that would corrupt reconciliation and any downstream report keyed on `entry_type`.

**Closed by:** ADR-017 — Compensating-Entry FK Placement. *"At most one of `refund_id` / `chargeback_id` / `adjustment_id` should be set on a given row, matching `entry_type`... expressible as a plain single-row Postgres `CHECK` constraint (no deferred trigger needed, since it doesn't aggregate across rows)."*

**Mechanism, confirmed present in the live schema:** `journal_entry_compensating_fk_matches_type` `CHECK` constraint (confirmed via `\d journal_entry` against the migrated database this session) — enforces the full match table (`refund_issued` ⇒ `refund_id` set, others null; `chargeback` ⇒ `chargeback_id` set, others null; `adjustment` ⇒ `adjustment_id` set, others null; `payment_captured`/`tip_allocated`/`payout` ⇒ all three null) at the database level, not just in application code.

---

## 4. A stolen refresh token used in parallel with the legitimate session (OWASP A07:2025, Authentication Failures)
**Threat:** An attacker obtains a refresh token (device compromise, log leak, etc.) and uses it. Rotation alone (revoking only the used token) doesn't distinguish "the legitimate client rotated normally" from "someone just replayed an already-superseded token" — the standard signature of a stolen token racing the real one.

**Closed by:** ADR-019 (revised) — Refresh Token Storage, family-wide reuse detection. *"A revoked family invalidates every token descended from that login, present or future, not just the one being replayed."*

**Mechanism, verified live against real HTTP endpoints, not only unit tests:** rotate → replay the old, already-rotated-out token → both that token and the newer, never-replayed one from the same family are rejected by `POST /auth/refresh`. The detection moment is distinguishable from an ordinary already-revoked rejection (`RefreshTokenReuseDetectedError`) and written to `AuditLog` as `refresh_token_reuse_detected` — confirmed live, correct `user_id`/`familyId`/IP/user-agent, no duplicate row on the subsequent rejection of the family's other token.

---

## 5. Credential-stuffing / brute-force login attempts (OWASP A07:2025, Authentication Failures)
**Threat:** An attacker scripts repeated login attempts against `/auth/login` — either guessing one account's password, or testing a leaked credential list across many accounts.

**Closed by:** ADR-010 — Audit Logging and Rate Limiting Belong to Foundation. *"Baseline rate limiting is a global throttling module, tuned per endpoint later against the limits already specified in API_Contract. Both are built in Sprint 1, before Authentication."*

**Mechanism:** `@Throttle({ default: { limit: 10, ttl: 60_000 } })` on `AuthController` (API_Contract.md, Rate Limiting: "Authentication 10/min" — stricter than the global 100/min default). Verified live this session, fresh database, real HTTP: 10 requests allowed, the 11th rejected `429`, both the 401s and the 429 correctly written to `AuditLog` after this session's own AuditLog failure-channel fix.

---

## 6. Platform absorbing a restaurant's own fraud and chargeback losses
**Threat:** Every restaurant's Connect account carries its own fraud/chargeback risk. Left unexamined, the platform could end up contractually on the hook for losses caused by a restaurant's own customers or business practices — a real balance-sheet exposure, not an abstract one.

**Closed by:** ADR-014 (revised) — Stripe Connect Account Type: Standard-equivalent. *"The restaurant — not Hospitality OS — bears its own fraud and chargeback losses, the financially conservative default for a platform whose own margin is a small take rate."*

**Mechanism, confirmed empirically, not by reading Stripe's documentation:** a real `POST /v2/core/accounts` 2×2 matrix this session showed `dashboard: "express"` *only* accepts `losses_collector: "application"` (platform absorbs losses) and is rejected (`HTTP 400`) with `losses_collector: "stripe"`; `dashboard: "full"` is the exact mirror. There is no configuration where the platform can be on the hook while using the account type actually implemented.

---

## 7. Repeated failed payments as an invisible fraud signal
**Threat:** `MASTERPLAN.md`'s Fraud Prevention section requires detecting "repeated failed payments" as a signal — impossible if a failed payment attempt is never recorded as having failed.

**Closed by:** ADR-018 — Payment Mutability. *"`failed` (a processing error or timeout) and `declined` (the card issuer explicitly rejected the charge) are kept as two distinct terminal states rather than one, because they are different fraud signals in practice."*

**Mechanism:** `Payment.status` transitions exactly once from `pending` to a terminal state including `DECLINED` (added to `PaymentStatus` by this ADR), recorded via `updated_at`; every other field on `Payment` stays immutable. Not yet exercised by a real webhook handler (Sprint 5) — the schema and the rule are in place; nothing writes a `Payment` row yet.

---

## 8. Platform fee and tip left standing on a refunded payment or a lost dispute
**Threat:** A refund or a chargeback reverses `RESTAURANT_REVENUE_PAYABLE` for the full amount but leaves `PLATFORM_FEE_REVENUE` and the waiter's own `TIP_PAYABLE` credit untouched — the platform keeps a fee on money it no longer holds, and a waiter's Wallet still shows a tip the customer got back in full. Found live, not by a test, on the refund side first: a real full refund (`amount=2000, tipAmount=500`) against a real tip-bearing payment left `RESTAURANT_REVENUE_PAYABLE` at **-515** for that Transaction, `PLATFORM_FEE_REVENUE` still holding its `15`, and the waiter's `TIP_PAYABLE` credit still standing at `500`. The chargeback path (`charge.dispute.created`/`charge.dispute.closed`) turned out to have the identical gap, found by checking `DATABASE.md`'s own "Same compensating-entry rule as Refund" claim against the actual code rather than assuming it — the claim was already correct in the docs, the code just hadn't caught up.

**Closed by:** ADR-023 — Refund Proportional Reversal (revised in place to cover both triggers). *"handleChargeRefunded now reverses three accounts proportionally instead of one unconditionally... RESTAURANT_REVENUE_PAYABLE's share is always the residual, never its own independent division... keeps the three reversed shares summing to exactly cumulativeRefunded."* Same `splitProportionally()`/`getOriginalCapturedFeeAmount()` helpers now shared by `handleDisputeCreated` and `handleDisputeClosed`.

**Mechanism, live-verified:** the same real Transaction from the Threat description, re-run after the fix — `RESTAURANT_REVENUE_PAYABLE`, `PLATFORM_FEE_REVENUE`, and `TIP_PAYABLE` each summed to exactly zero for that Transaction after the full refund. Regression-tested with two sequential partial refunds against a tip-bearing payment (`webhooks.service.spec.ts`), confirming the delta-per-account technique doesn't double-count or under-count across multiple events, not just a single full-refund shot. The chargeback side is regression-tested the same way: a dispute opened on a tip-bearing Transaction debits all three accounts proportionally, and a WON closure reverses the exact same three amounts back to net zero.

---

Entries 9–15 below are Sprint 11's OWASP Top 10:2025 review (`IMPLEMENTATION_PLAN.md`), folded into this document's own existing structure rather than kept as a separate checklist — each cites the specific ADR/mechanism that closes it, same rule as every entry above. Not every one of the ten categories produced a new entry: #4 and #5 above already close A07:2025 (Authentication Failures) and are labeled accordingly rather than duplicated.

## 9. ~~Cross-Organization or cross-Restaurant data access via a legitimately-authenticated caller~~ — **REOPENED, see "Open, Not Answered"**

> **This entry is retained here, struck through, rather than deleted.** It was listed as Closed while the threat it describes materialised twice, and removing the claim would remove the evidence of how a closed claim survives being wrong. The live entry is now in **Open, Not Answered**. Everything below is the text as it stood, kept for the record.

### The original entry, as written
**Threat:** An authenticated User with a real Membership at Organization/Restaurant A reads or writes data belonging to Organization/Restaurant B — either because an org-wide Membership's `organizationId` is never actually compared against the target resource's own, or a restaurant-scoped Membership's reach is computed too broadly. The single most consequential access-control bug shape in this codebase, real not hypothetical: `RestaurantService.findAllForUser` shipped with exactly this gap in Sprint 4 (used every Membership's `organizationId` regardless of scope, so a restaurant-scoped Manager could see every Restaurant in the Organization the moment a second one existed) — caught live, not by a test.

**Closed by:** ADR-005 — the reachability rule itself: an org-wide Membership (`restaurantId IS NULL`) reaches every Restaurant in its own Organization; a restaurant-scoped one reaches only the exact Restaurant it names — never "any org-wide Membership anywhere." Enforced twice, by design: `PermissionsGuard` (coarse — does the caller hold this permission on *any* Membership) then a resource-scoped service-layer check (fine — does the *specific* Membership that actually reaches this resource hold it), `restaurant-reachability.util.ts`'s `isRestaurantReachable`/`hasPermissionAtRestaurant`.

**Mechanism, closed by a systematic sweep this Sprint, not a sample (ADR-028 Decision 5):** two search methods deliberately broader than the canonical `restaurantId === null && organizationId === X` idiom, so a check written in different wording wouldn't be missed — every function accepting an `AuthenticatedUser` (35 files), narrowed to every one that actually reads `.memberships` (16 files), plus both Guard files read in full. Result: 21 real reachability/permission-scoped sites across 11 service/controller files, all confirmed comparing `organizationId` correctly. Zero new findings this pass — the last time this class of bug was caught was Sprint 6's `TipService.assertReachable` first draft, caught by self-review before any test or live run.

---

## 10. Missing platform-level protections against common web attack classes (OWASP A02:2025, Security Misconfiguration)
**Threat:** No security response headers (clickjacking via frame embedding, MIME-type sniffing, no HSTS), CORS reflecting any Origin instead of an explicit allowlist, or a verbose error response leaking a stack trace or internal file path to a client.

**Closed by:** ADR-028 Decisions 1–2 — `helmet()` with standard defaults (`main.ts`), and `CORS_ORIGIN` as a required env var (no `.default()`) replacing the previous bare `enableCors()`, which reflected any Origin. The error-response half of this category predates Sprint 11: `AllExceptionsFilter` (Sprint 1) was already designed so an unhandled exception returns a fixed, generic `{ code: "UNKNOWN_ERROR", message: "Something went wrong. Please try again." }` to the client — full diagnostic detail goes to the logger only, never the response body (CLAUDE_RULES.md, Error Philosophy).

**Mechanism, live-verified this Sprint:** a real `GET /health` response carries `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, and the rest of helmet's default set; a request from the `CORS_ORIGIN`-allowed Origin gets `Access-Control-Allow-Origin` echoed back, a request from an unrelated Origin gets no CORS header at all.

---

## 11. SQL injection via a raw, unparameterized query (OWASP A05:2025, Injection)
**Threat:** Request-derived input reaching the database as string-concatenated SQL instead of a parameterized query.

**Closed by:** architecture default, not a per-query discipline — every query in this codebase goes through Prisma Client's generated query builder, which parameterizes by construction; there is no ORM escape hatch used casually. Confirmed this Sprint by finding and reading, line by line, the *only* three raw-SQL call sites in the entire backend (`grep` for `$queryRaw`/`$executeRaw`, not assumed absent).

**Mechanism:** `health.controller.ts`'s liveness check — `` this.prisma.$queryRaw`SELECT 1` `` — a static tagged template with zero interpolation. `ledger.service.ts`'s `client.$executeRawUnsafe("SET CONSTRAINTS ledger_line_balanced IMMEDIATE")` — despite the `Unsafe` suffix, the argument is a hardcoded literal with no interpolated value at all (the `Unsafe` variant is used because Prisma's safe tagged-template form has known trouble with `SET` statements, not to skip parameterization for convenience); the actual user-supplied Ledger data never appears in this call at all, only in the ORM-built `journalEntry.create`/`ledgerLine.createMany` calls immediately around it. `ledger-trigger.integration.spec.ts`'s own raw SQL is test-only, never reachable from a request.

---

## 12. An unsigned or forged webhook accepted as if it were genuinely from Stripe (OWASP A08:2025, Software or Data Integrity Failures)
**Threat:** Distinct from replay of a *genuine* webhook (Closed Threat #1, ADR-004) — an attacker POSTs a fabricated event directly to `/webhooks/stripe`, without ever holding the real signing secret, attempting to make the Ledger post money that was never actually charged.

**Closed by:** `API_Contract.md`, Incoming Webhooks — Stripe: *"the signature (verified inside WebhooksService, using the exact raw bytes `main.ts`'s `rawBody:true` captures) is the authentication"* — the endpoint carries no `JwtAuthGuard` at all by design, precisely because signature verification is a stronger authentication than a bearer token here (it also proves the payload itself, not just the caller's identity). `StripeService.constructWebhookEvent` delegates to Stripe's own SDK HMAC verification rather than a hand-rolled comparison.

**Mechanism, live-verified this Sprint** (during the `@nestjs/core` 11 upgrade's own verification, since raw-body capture is Express-middleware-dependent and worth re-proving after a major HTTP-layer dependency bump): a real, validly-signed test event accepted end-to-end (`200`, `{"received":true}`); the identical payload re-sent with a forged `v1` signature correctly rejected (`400`) before any Ledger code ever runs.

---

## 13. A background write failing without anyone finding out (OWASP A10:2025, Mishandling of Exceptional Conditions)
**Threat:** An asynchronous side effect — an Outbox dispatch, a deferred database constraint — fails, and the failure simply disappears: no retry, no alert, no record, leaving a `JournalEntry` that looks posted but never completed its downstream effects, or a corrupt write nobody notices until reconciliation.

**Closed by:** ADR-002's own reasoning for forcing the deferred trigger to run *inside* the write transaction rather than letting Postgres check it naturally at COMMIT — confirmed directly, not assumed, by `ledger-trigger.integration.spec.ts`: when the trigger fails at COMMIT instead, `Prisma.$transaction()` resolves normally even though the server rolled everything back, so the caller never learns the write failed — "worse than an error: code downstream would treat a silently-discarded JournalEntry as successfully posted" (`ledger.service.ts`'s own comment). SYSTEM_ARCHITECTURE.md's Outbox Lag design answers the async-dispatch half: a repeatedly-failing `OutboxEvent` is not silently dropped, it raises an `ERROR`-level "operational alert" on every poll.

**Mechanism, observed live this Sprint** (not staged for the purpose — encountered as pre-existing dev-DB debris while booting the server for an unrelated check): the exact alert fired repeatedly and correctly against real poisoned rows left over from earlier testing, confirming the alerting path is real and active, not aspirational. `AllExceptionsFilter`'s own catch-all (Closed Threat #10 above) is the same principle applied to the synchronous request path — an unhandled exception always returns a real error, never an ambiguous success.

---

## 14. A security-relevant event happening with no record of it (OWASP A09:2025, Security Logging and Alerting Failures)
**Threat:** A permission denial, a failed login, a Guard rejection, or a suspicious pattern occurs and leaves no trace — undetectable after the fact, whether for incident response or routine review.

**Closed by:** ADR-010 — audit logging as a Sprint 1 foundation, not an afterthought. `AuditLogInterceptor` covers requests that reach a handler; `AllExceptionsFilter`'s own `auditGuardRejection` fallback specifically covers the gap NestJS's own pipeline ordering creates — Guards run *before* Interceptors, so a request rejected by `JwtAuthGuard`/`PermissionsGuard`/`ThrottlerGuard` never reaches `AuditLogInterceptor` at all; the filter is the only place in the pipeline that sees every exception regardless of where it was thrown. Sensitive fields never reach the log in the first place: pino's own `redact` list (`app.module.ts`) strips `Authorization`/cookie headers and `password`/`refreshToken`/`card` body fields before a log line is even written (CLAUDE_RULES.md, Logging Philosophy).

**Mechanism, already proven live (existing entries):** `refresh_token_reuse_detected` written to `AuditLog` with correct `user_id`/`familyId`/IP/user-agent (Closed Threat #4); the login-throttle test's `429` and its preceding `401`s both correctly `AuditLog`-ed (Closed Threat #5).

**Proven against real hostile traffic, not only against our own tests — and found by accident, which is the strongest form of this evidence.** While inventorying production data for an unrelated cleanup, the `AuditLog` turned out to already contain records of the live system being scanned from the internet:

```
2026-08-20 22:40:58–59  Mozilla/5.0 (l9scan/2.0.33e27393…)   → /graphql  /api  /api/graphql  /graphql/api  /api/gql
2026-08-22 05:08:35–36  Amazonbot/0.1 · Amzn-SearchBot        → /graphql  /api/graphql  /v1/graphql  /graphql/console
```

The first is **Leakix**, a real internet-wide vulnerability scanner, walking a list of common GraphQL endpoint paths against production inside a two-second burst. Every probe was rejected (`post_failed`) and every one of them was recorded with its path, IP and user-agent. Nobody set this up as a test; the mechanism simply worked, and the evidence was sitting there waiting to be read. **This is the difference between a logging system that passes its own tests and one that has actually caught something** — and it is the concrete reason `AuditLog` was excluded from that cleanup rather than treated as test residue (`DATABASE.md`, the recorded exception under Soft Deletes).

Worth stating plainly since it is now a matter of record: **production is already being probed by strangers.** Nothing was exposed — the paths do not exist and the API has no GraphQL surface at all — but the interval between "deployed publicly" and "scanned by automated tooling" was measured in days, not months, and that is the correct default assumption for every future deployment rather than a surprise.

---

## 15. A weak or improperly-handled secret (password, token, key) at rest or in transit (OWASP A04:2025, Cryptographic Failures)
**Threat:** A password stored recoverably instead of hashed, a session/refresh token stored or compared insecurely, or a signing secret weak enough to guess or brute-force.

**Closed by, for what this application itself is responsible for:** passwords hashed with bcrypt (`password.util.ts`), never stored or logged in plaintext — tested directly (`password.util.spec.ts`: a different hash for the same password on each call, confirming a real random salt, not a lookup-table-vulnerable fixed one). `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` required at minimum 32 characters (`env.validation.ts`), refused at boot otherwise. Membership invitation tokens hashed with SHA-256 and compared with `timingSafeEqual` (`invitation-token.util.ts`), not a plain string comparison vulnerable to a timing attack. Refresh tokens rotated with family-wide reuse detection (Closed Threat #4).

**Explicitly out of this review's scope, not silently assumed:** transport-layer encryption (TLS termination) is not this application's own responsibility — it terminates HTTP, and real TLS is `IMPLEMENTATION_PLAN.md` Sprint 13's job (Docker, GitHub Actions, Production Database, Domain, **SSL**, Monitoring), not yet built. `helmet()`'s HSTS header (ADR-028) already asserts the expectation that HTTPS will front this service in production — an instruction to browsers, not a guarantee this application enforces itself.

---

## 16. An architectural decision made without weighing its security consequences (OWASP A06:2025, Insecure Design)
**Threat:** The broadest category by construction — a feature built to only ever see the "happy path," where security was never actually part of the design conversation, only patched on afterward if at all.

**Closed by, as an ongoing practice with concrete evidence rather than a one-time answer:** this document's own existence and the discipline behind it — every entry above cites a real ADR that made an explicit security tradeoff *at design time*, not after an incident. Representative examples of the practice, not an exhaustive list: ADR-002's two independent layers (application check + database trigger) so no single bypass compromises the Ledger's one invariant; ADR-004's idempotency designed in before Sprint 5 had a single real caller; ADR-028's rate limits chosen by each endpoint's actual cost/abuse shape rather than one uniform number; fail-closed as the default throughout (`PermissionsGuard` throws if `request.user` is missing rather than defaulting to allow; `AllExceptionsFilter`'s fallback is a rejection, never a silent 200).

## 17. A Payment stuck in PENDING because Stripe was unreachable, a bank/issuer timed out, or the confirming webhook was lost or delayed
**Threat:** Three previously-separate "Open, Not Answered" entries, closed together because one real mechanism answers all three: "Stripe unreachable at the moment of payment," "Bank or card issuer (EMI) timeout during confirmation," and "Webhook and client-side confirmation diverging by more than the expected lag." In every one of these, the customer's own card may or may not have actually been charged, and this system has no way to find out on its own — it just waits.

**Closed by:** ADR-032 Decision 5. `PaymentReconciliationService` (`@Interval`, 5 minutes) finds any `Payment` still `PENDING` after 15 minutes and asks Stripe directly what actually happened (`StripeService.retrievePaymentIntent`) — never assumed from this system's own possibly-stale copy. If Stripe confirms `succeeded`, this **self-heals**: it runs the real capture logic itself (`WebhooksService.captureFromPaymentIntentId`), exactly as if the missing webhook had arrived. If Stripe can't be reached, or genuinely still shows the payment unresolved, a human is alerted (the same `AlertService` mechanism ADR-031 built for Outbox Lag) — fired once per Payment, not every cycle. Not yet live-verified against a genuinely real Stripe outage (nothing this session could fabricate on purpose) — verified via full unit coverage of every branch (`payment-reconciliation.service.spec.ts`: self-heal, alert-without-self-heal, Stripe-unreachable, capture-failure-not-misreported-as-connectivity-failure, one payment's failure not blocking the rest of the batch) and the mechanism's own design directly mirrors the Outbox Lag alert this exact pattern already proved live in production (ADR-031).

## 18. No automated, recurring check for known-vulnerable dependencies (OWASP A03:2025, Software Supply Chain Failures)
**Threat:** As stated in the entry this closes — a new CVE against an already-installed dependency produced no signal until someone thought to run `pnpm audit` by hand.

**Closed by:** ADR-032 Decision 2. CI now runs a real `Dependency vulnerability scan` step (`.github/scripts/check-audit.js`) on every PR — high/critical severity fails the build. Confirmed working both directions before merging: currently green (with 4 known, explicitly-justified, dev-tooling-only advisories ignored by id), and confirmed to genuinely fail when a covered advisory is *not* in the ignore list.

## 19. No breached-password check at registration (OWASP A07:2025, Authentication Failures)
**Threat:** Half of the original combined entry ("no MFA and no breached-password check") — a user could pick a password already known to be in a public breach corpus, with no way for this system to know. The MFA half is **not** closed by this — see the Open, Not Answered entry below, which now stands on its own.

**Closed by:** ADR-032 Decision 4. `hibp.util.ts` checks the HaveIBeenPwned k-anonymity range API (only a 5-character hash prefix ever leaves this process) at both places a password is actually set — `AuthService.register()` and `MembershipInvitationService.accept()`'s new-user branch. Fails open on any HIBP API error — a third-party outage must never block registration.

## 20. Waiter Role (as seeded) cannot itself hold `payments.manage`, so cannot be the tip recipient ADR-022 assigns by construction
**Threat:** As stated in the entry this closes — nobody holding the seeded Waiter Role could ever be a tip's recipient through the real, permission-checked HTTP path, contradicting `MASTERPLAN.md`'s own User Journey.

**Closed by:** ADR-033. Tip recipiency is now an explicit terminal selection (`Payment.waiterMembershipId`, validated, any reachable Membership regardless of Role), independent of who is authenticated and calling `POST /payments`. `AuditLogInterceptor` records both the logged-in caller and the selected recipient as two independent facts, verified by a real dual-identity test using two genuinely different people (`payment.controller.spec.ts`), not the same person read twice under two names.

## 21. `IdempotencyInterceptor`'s check-then-act is a real race window, not yet closed
**Threat:** As stated in the entry this closes — a genuinely unlucky concurrent-request interleaving could surface as a raw, unhandled `500` instead of the intended `409 IDEMPOTENCY_KEY_CONFLICT`.

**Closed by:** ADR-032 Decision 3. The `create()` call inside `intercept()`'s `!existing` branch is now wrapped in a `catchError` that maps a real Postgres unique-constraint violation (`Prisma.PrismaClientKnownRequestError`, `code === "P2002"`) to the same controlled `409` — closed architecturally, not merely "not observed to fail" under one load-test run. Verified by forcing the exact race deterministically (`idempotency.interceptor.spec.ts`: pre-create the winning row directly, then stub `findUnique()` to still return `null`, so this request's own `create()` hits the real constraint on every single run), not by relying on `Promise.all` timing luck.

## 22. Total, unrecoverable loss of the production database — no backup existed at all, and no restore had ever been attempted
**Threat:** The single largest one on this list by consequence, and it was open silently. Production ran with **zero backups of any kind** — found by direct API query during the Sprint 13 backup audit, not by suspicion: `pitr status` returned `enabled: false, bucketWired: false`, volume backup schedules returned `[]`, existing snapshots returned `[]`, and the project had no storage bucket for PITR to write to. Losing the Postgres volume would have meant losing the Ledger permanently, with nothing to restore from.

A second, subtler half of the same threat: even once backups exist, a backup nobody has ever restored from is a belief, not a capability. The failure modes that matter — a dump that will not load, a schema restored without its constraints, a "point in time" that silently lands hours earlier than requested — are all invisible until someone actually tries.

**Closed by:** ADR-034's addendum (production's minor version pin removed — Railway reports minor pinning as a hard blocker for PITR, and PITR is implemented on pgBackRest), plus PITR enabled with a wired bucket. **Verified by an actual restore rehearsal**, not by the feature reporting itself healthy — the distinction this entry exists to make.

**Mechanism, live-verified against a real restore into an isolated service (never touching production — `volumeInstancePITRRestore` takes a `newServiceName` and creates a separate service, unlike volume-snapshot restore, which swaps the volume under the live one):** a restore targeted at `2026-08-26 12:20 UTC` was checked four ways.

- **The Ledger invariant holds** — zero unbalanced `JournalEntry` rows in the restored database.
- **The Ledger's own defences came back with it, not just its rows** — `journal_entry_compensating_fk_matches_type` (`CHECK`, ADR-017), `ledger_line_balanced` (deferred trigger, ADR-002) and its `check_journal_entry_balanced()` function all confirmed present by direct catalog query. A restore that returned data without the trigger would have looked successful while leaving the Ledger undefended.
- **Row counts match production exactly** across all nine key tables, and the specific rows known to exist at that moment were all present and correct — the restaurant with its real Stripe account id, both payments with their amounts and `waiter_membership_id`, and the `AuditLog` row still carrying both identities separately (ADR-033).
- **The restore point is accurate to the second, proven by a discriminating check rather than by counting rows.** The newest *created* row was from `11:56`, so row counts alone could not distinguish a restore at 12:20 from one at 11:57. But the 12:15 reconciliation cycle *updated* existing rows rather than creating any — so `reconciliation_alert_sent_at` is the field that separates the two. It came back populated, byte-identical to production (`12:15:00.819` / `12:15:01.537`). The restore genuinely captured writes up to at least `12:15:01.5`.

That last check also resolved an open question this audit had been carrying: `maxRestoreTime: 12:15:01` had disagreed with `archiverLastArchivedAt: 20:20:30` by eight hours, and it was unclear whether that meant a stale restore horizon. It did not. `12:15:01` was honest — it was the timestamp of the last real write to the database, after which production was idle, so the archiver was alive with nothing left to archive (`archived=0` in pgBackRest's own watcher output). The two numbers answer different questions: how far a restore can reach, and when the archiver last ran. Separately, the dashboard's coverage window and the CLI's figures reconciled once timezone was accounted for — the dashboard renders local time (+3), the CLI UTC; the window's start matched pgBackRest's `last_full` exactly.

**What this rehearsal did NOT prove, stated as prominently as what it did.** The production Ledger is empty — `journal_entry`, `ledger_line` and `transaction` all hold zero rows, because no payment has ever been captured in production. **The invariant check therefore passed trivially, over nothing.** It demonstrates that the mechanism restores, that the schema and its constraints survive, and that the point in time is accurate; it demonstrates nothing about whether debits equal credits across real financial history, because there is no real financial history yet. Re-running this rehearsal is a genuine, non-optional prerequisite once real money has moved — the check that passes today is not the check that will matter then.

**Volume snapshots are now configured alongside PITR, all three schedules, verified through the API rather than from the UI's own labels.** Railway's guidance is that they are independent of PITR — a separate mechanism against a separate class of failure — and both are now in place. The actual values differ from the round numbers the presets suggest, which is exactly why they were read back:

| Schedule | Runs | `retentionSeconds` | Real depth | First automatic snapshot |
|---|---|---|---|---|
| Daily | `44 2 * * *` (02:44 UTC) | 518 400 | **6.00 days** | 2026-08-27 02:44 UTC |
| Weekly | `28 2 * * 6` (Sat 02:28 UTC) | 2 332 800 | **27.00 days** — not 30 | 2026-08-29 02:28 UTC |
| Monthly | `44 17 1 * *` (1st, 17:44 UTC) | 7 689 600 | **89.00 days** — not 90 | 2026-09-01 17:44 UTC |

Only the Daily figure matches its label exactly. "A month" is 27 days and "three months" is 89 — small differences, but the kind that matter when someone reasons "we can always go back three months" during an incident. One **manual** snapshot also already exists (`2026-08-26 21:22 UTC`, `referencedMB: 1223`, `usedMB: 69`) with `expiresAt: null` — it is outside every retention policy and will never be pruned automatically, so it is both a real recovery point available today and a line item that stays on the bill until someone deletes it deliberately.

**What each layer actually covers, and what none of them does:**
- **PITR** — any second within its window, on a short horizon. The finest granularity, and the only one that can land between snapshots.
- **Daily** — six discrete points, independent of pgBackRest. This matters because it is a *different mechanism*: corruption of the pgBackRest repository itself, or a fault in WAL archiving, takes PITR with it and leaves these untouched.
- **Weekly / Monthly** — 27 and 89 days of depth, for damage discovered long after it was done. This is the case PITR structurally cannot cover: a destructive change made by a correct-looking transaction is replayed faithfully by point-in-time recovery, because from WAL's perspective nothing went wrong.

**The layering is real but not yet in place — it accrues.** As of this entry only the manual snapshot and PITR exist; the first Weekly is three days out and the first Monthly six. Until 2026-09-01 there is no monthly-depth recovery point at all, and describing the coverage as though all three tiers already exist would be wrong today even though it will be right shortly.

**One residual gap, unchanged in substance:** every mechanism above lives inside Railway. Together they defend against disk failure, against our own mistakes, and — because snapshots and PITR are independent — against one backup system failing on its own. None of them defends against losing access to the Railway account itself. The off-platform copy stays deliberately deferred with a named trigger (`IMPLEMENTATION_PLAN.md`: before the first real pilot restaurant).

## 23. Any restaurant Owner could grant `Administrator`, a Role holding every Permission in the system (OWASP A01:2025)

**Threat:** `Administrator` is seeded with all ten Permissions and was described as platform-level, but nothing enforced that description. Every write path taking a `roleId` validated only that the id existed — so an Owner could invite, or promote an existing colleague to, a Role with complete control over every Organization. **Promotion was the easier route**: no invitation, no acceptance, one `PATCH`.

**Closed by:** ADR-044. `Role.platformOnly` as a column rather than a filtered dropdown — a filtered interface over an endpoint that accepts anything is the failure mode where the screen looks correct and the API is not. Enforced in all four write paths that accept a `roleId`, and `GET /roles` omits such Roles from the assignable list.

**How the doors were counted, which matters more than the count:** by grepping for the field, not by reasoning about the flows. Reasoning found two; the grep found four. The one reasoning missed (`PATCH /memberships/{id}`) was the most dangerous of them.

**A second, structural finding recorded with it:** `roleId` was the one dangerous input the API accepted but never emitted. For ten sprints nothing returned a list of Roles, so nothing ever had to answer *which ones may this caller see* — and four write paths independently settled for "does the id exist". The predictive form: **look for inputs the API accepts but never returns.**

**Live-verified in production (Sprint 14 closing check), not only by tests:** `GET /roles` returned `Manager, Owner, Waiter`; `POST /memberships` and `PATCH /memberships/{id}` both refused an `Administrator` `roleId` with `400 VALIDATION_ERROR`; both refusals landed in `AuditLog` as `post_failed` / `patch_failed`.

**One caveat this entry must carry:** the fix shipped as code eleven days before it took effect in production, because the column it reads is seeded and nothing ran the seed. See #25.

## 24. A failure outside the HTTP request cycle left no trace anywhere

**Threat:** `AllExceptionsFilter` sees every failure inside the HTTP pipeline and nothing outside it. A rejected promise in `OutboxPollerService`, `PaymentReconciliationService` or any `@Interval` job never touches a request — so Node terminated the process, Railway restarted it under `ON_FAILURE`, and the log line died with the process. `process.on` was never called anywhere in the codebase, verified by grep rather than recalled.

The healthcheck cannot catch this, and the reason is the entry: **a service crashing and restarting in a loop looks, from outside, exactly like a service that is working.** `/health` answers again after every restart.

**Closed by:** ADR-045. Two `process.on` handlers with deliberately different fatality policies — `unhandledRejection` reports and continues, `uncaughtException` still exits after letting the alert leave — plus deduplicated alerting through the existing `AlertService`, carrying only name, message, route and status. Never the exception object: the logger has redaction configured, a webhook POST does not, and a Prisma error's message can embed the failing query and its parameters.

**Load-bearing dependency, recorded because it is what makes the decision safe rather than reckless:** not exiting is better than a restart loop *only because the failure is announced*. `ALERT_WEBHOOK_URL` is therefore required in production and the app refuses to boot without it.

**Verified on the real built process against a live sink**, both halves separately, because a unit test cannot prove a `process.on` registration: an HTTP exception produced one alert; five identical repeats produced none; a rejection outside the HTTP cycle — the half nothing covered — produced its own alert; and the log showed a single bootstrap, so the process had genuinely survived rather than restarted.

**Live-verified in production (Sprint 14 closing check):** the reconciliation alert for a genuinely stuck Payment was delivered end to end — `Alert webhook delivered successfully … status=200`, naming the Payment id.

## 25. A Permission removed from `seed.ts` stayed granted forever, and a decision written into the seed never reached production at all

**Threat:** Two halves of one gap, and the second is what made the first invisible.

`seedRbac` was `upsert`-only: it could add and correct, never remove. Removing a Permission from a Role in `seed.ts` changed nothing on a database that already had the row, so the file went on describing a restriction that was not in force.

And nothing ran the seed. `preDeployCommand` ran migrations only, so **ADR-044's `platformOnly` fix sat in production as `false` for eleven days** while the code that reads it refused nothing. The API was correct; the data it consults had never been told.

**Closed by:** ADR-046 (the seed reconciles rather than only adding, scoped narrowly to `RolePermission` rows of Roles the file defines — never a `Permission`, never a `Role`) and ADR-048 (the seed runs on every deploy, invoked **without** `--allow-revocations`).

**The flag's absence is the whole design.** A deploy applies everything additive and **cannot remove anything**: if `seed.ts` and production disagree about a grant that exists but is no longer intended, the deploy fails naming which Role would have lost which Permission. So "runs automatically" and "may revoke" are answered differently — yes and no — and an incomplete `seed.ts` cannot cause a loss.

**Residual risk, stated rather than argued away:** a wrongly *added* grant still ships. Unchanged from manual runs, and different in kind — an addition requires someone editing a reviewed diff, whereas drift requires nobody doing anything at all.

**Live-verified on the first real deploy after the decision:** `prisma:seed` ran after `prisma:migrate:deploy`, reported `Seeded 10 permissions and 4 roles`, and the deploy succeeded. The refusal path was proven separately with the exact command the deploy runs: with an unintended grant present it exits 1 and names `Waiter -> roles.manage`.

---

## 26. Three by-id routes returned another restaurant's financial data to a caller holding no permission there
**Threat:** `GET /payments/{id}`, `GET /payments/{id}/status` and `GET /transactions/{id}` carried no `@RequirePermission` at all and were scoped inside their services by **reachability alone** — a rule any Membership satisfies. A person holding a zero-permission Waiter Membership at a restaurant could read that restaurant's individual financial rows.

**This was measured before it was fixed, and recorded as open before either** (PR #108). The subject was the dual-role caller this document already describes — Owner of one Organization, zero-permission Waiter at a restaurant in another. Against real rows, through real HTTP: `GET /payments/{id}` returned amount, tip, currency, processor id and idempotency key; `GET /payments/{id}/status` returned the status; `GET /transactions/{id}` returned gross, net revenue, net tip, net platform fee, tax, refunds and chargebacks. All **200**.

**Closed by (PR #109):** `hasPermissionAtRestaurant` at each of the three, plus `@RequirePermission("reports.view")` on the routes themselves — so they are now structurally identical to the list routes they are the by-id form of.

**The check is not a new rule, and that was the requirement.** `hasPermissionAtRestaurant` is defined in terms of `findGrantingMembership`, the same predicate `permittedScope` filters the LIST routes with — one implementation, asked about a single known row instead of used to build a query. ADR-043 closed this exact shape for the lists; the by-id reads were simply never part of that change, and asking one question two ways would eventually have answered it two ways again.

**Refused with 404, not 403.** Confirming that a payment exists at a restaurant the caller may not read is itself the disclosure — the same answer the list already gives by omitting the row.

**Why the other two remedies were rejected.** *Fold the by-id reads into `permittedScope`'s query path* would also have worked and is larger; it was declined because the single-row form already exists, is already used by the dashboard and analytics, and adding a second way to express one rule is what this entry is about. *Leave reachability as the rule and document it* was rejected by the Founder on the substance: three routes handing a stranger's financial picture to any Membership cannot be what was intended, and it is the opposite of what ADR-043 decided for the same data in list form.

**Mechanism, verified by falsification rather than by reading:** reverting both checks to `isRestaurantReachable` makes exactly those three tests fail, with the positive control — the same reads at the caller's own restaurant — still passing. The three had been recorded as `it.fails` in PR #108; closing the leak made them fail with *"expected to fail but passed"*, which is what forced them to be converted here. The marker enforced its own deadline.

**A related audit, reported and not fixed.** Every route was enumerated with a parser validated against a known-answer pair first — the first attempt read decorators in the wrong order and produced a page of phantom findings, the same bug `repo-invariants.spec.ts` already records. **36 of 57 routes carry no `@RequirePermission`**, and most are correctly so: public auth and agreements routes, `/health`, currency reference data, invitation acceptance, self-scoped profile and `tips/me`, the ownership-scoped wallet routes, and the Stripe webhook. Three are worth their own look and are **not** part of this fix:

- ~~`POST /restaurants/{id}/onboarding-link` — reachability only, and it is an **action**: it mints a Stripe onboarding link for the venue's connected account.~~ **Closed 2026-09-02 — see Closed Threat 27.** It needed three measures rather than the permission this list implies.
- `GET /restaurants/{id}` — reachability only; returns `companyNumber`, `vatNumber`, `stripeAccountId` and payout status.
- `GET /tips/{id}` — reachability only; one waiter may read another's tip at the same restaurant.

## 27. Any Membership at a venue could mint a Stripe onboarding link, and that link leads to the form that sets the payout bank account

**Closed by three measures, 2026-09-02 — and the count is the finding.** A single permission would have left two of the three ways in open, which is why this was recorded and stopped rather than fixed as "the fourth instance of the #109 pattern".

**1. The permission — `restaurant.create`, checked at the venue, 404 rather than 403.** `hasPermissionAtRestaurant`, the same predicate #109 used. **`restaurant.edit` was rejected on the merits:** Manager holds it, and the account a venue's money is paid into is the owner's decision, not the shift's. **No new Permission was created** — a new RBAC row is a data migration whose reconciliation gate (ADR-046/ADR-048) would refuse the next deploy over a grant nobody intended. `restaurant.create` is not a stretch: `POST /restaurants` is gated by it and is the call that **creates the Stripe Connect account**, so finishing that account is the same act continued. **It restricts to Owner and Administrator** — the two seeded Roles holding it — not to Owner alone, because Administrator holds every Permission by design (ADR-044) and is platform-only.

**2. The status gate — DEFERRED, and the reason is a fact that could not be established.** The intended rule was to refuse the route once no requirements remain, closing the window rather than narrowing it. It turns on what the hosted form shows for an account whose onboarding is complete. **Zero of the 32 connected accounts in the sandbox has completed onboarding** — every one has `details_submitted: false` and 18 outstanding requirements — and completing one means submitting identity and bank-account details, which this session does not do. **Live Stripe was reachable; the missing thing was a completed account, not the connection.**

**What that probe did establish, by execution rather than from the reference:** `account_update` **is refused for our accounts** — Stripe's own words, *"You cannot create `account_update` type Account Links for this account. Valid types for this account are [\"account_onboarding\"]"* — and an `account_onboarding` link created against a real account expired **exactly five minutes** later. The earlier entry inferred both from documentation; both are now measured. The premise behind the deferred gate therefore holds, even though the gate itself is unbuilt.

**3. The throttle — 10 per hour on the route, via the existing Redis-backed mechanism (ADR-042).** **A permission cannot do this job:** an Owner legitimately holds the right and can still mint an unbounded series, and mail clients burn links by following them to scan. The threshold comes from the measured five-minute lifetime — ten per hour allows a re-request roughly every six minutes, continuously, past any honest need. **Its limit, stated rather than implied:** `ThrottlerGuard` tracks by IP, not by user or venue, so this bounds one source and not a caller with several.

**Why one permission was not enough, which is the transferable part.** The three measures answer three different questions — *who may ask*, *when asking still makes sense*, and *how often*. The permission alone leaves an Owner minting an unlimited series into a window that never closes; the throttle alone leaves a Waiter doing it slowly; the gate alone leaves anyone doing it while onboarding is unfinished, which is exactly when the bank-account form is live. **Treating this as one more instance of the #109 read-scoping pattern would have shipped one third of the fix and closed the entry.**

**Residual, named rather than left implicit.** With measure 2 deferred, an Owner at a venue whose onboarding is already complete can still mint links, capped at ten per hour. What such a link displays is the fact above that could not be established. **Reopen this entry if that ever proves to be an editable form.**

**Falsified individually.** Removing the permission check fails the permission test alone (9 of 10 still green); removing the throttle fails the throttle test alone (9 of 10 still green). The permission test asserts the **positive** case in the same run — an Owner is served — because #108's first falsification was unclean in exactly that way, with markers flipping for a crash rather than a denial.

**What was verified below is what the entry said when it was opened**, kept as written. Two of its inferences have since been confirmed by execution, noted above.


**This is not the read-scoping class, and the difference is why it is recorded here instead of being fixed alongside the by-id reads.** It was going to be fixed as the fourth instance of the #109 pattern. Establishing what the link actually permits — before writing the fix — showed it is a different question.

**What the route does today.** `POST /restaurants/{id}/onboarding-link` calls `getReachableRestaurantOrThrow` and **nothing else**: no `@RequirePermission`, no `hasPermissionAtRestaurant`, and no gate on the venue's onboarding state. **Reachability is the entire rule**, and reachability is satisfied by any Membership — a zero-permission Waiter included.

**What the recipient of the link can do, from Stripe's own reference rather than from memory:**

- The link is `type: "account_onboarding"`, which *"provides a form for inputting outstanding requirements."*
- For a connected account that has not finished onboarding, those outstanding requirements **include the external account — the bank account that receives the venue's payouts.** Stripe's hosted-onboarding documentation describes collecting bank account information as part of the flow.
- `type: "account_update"` — the mode that edits *already-provided* information — **cannot be created for our accounts at all.** Stripe refuses it for accounts with Stripe-hosted Dashboard access, which ours have by ADR-014 (`dashboard: "full"`). So the exposure is bounded to requirements that are still outstanding; it is not a route to changing a bank account that has already been set.

**How long it lives, and whether it can be re-issued:**

- **Single-use**, in Stripe's own words on the create endpoint.
- **A few minutes** — Stripe's documentation says a link is invalid once *"a few minutes went by since the link was created"*, and the API reference's own example shows `expires_at` exactly 300 seconds after `created`.
- **Re-issuable without limit.** Nothing in the API prevents minting another while one is live — `refresh_url` exists precisely so a caller generates a fresh link — and our route carries no throttle beyond the global 100/min.
- Stripe additionally notes that **email clients which automatically visit links can consume one**, which is a reason a link may be spent without its intended recipient ever seeing it.

**So the exposure, stated precisely.** At a venue whose Stripe onboarding is incomplete, anyone holding any Membership there can mint an unlimited series of short-lived, single-use links to the flow that sets where that venue's money will be paid. It is bounded by the link's lifetime, by single use, by Stripe's own identity checks inside the flow, and by only outstanding requirements being collectable. It is **not** bounded by who may mint it, nor by how many.

**Why this is stopped here rather than fixed.** A read-scoping defect leaks information. This one sits on the path to a form that decides where money goes, and the correct answer may not be "add the permission that the other three routes got" — it may be that this route should also be gated on onboarding state, or rate-limited, or only ever reachable by the person who created the venue. **Choosing among those is a decision about money movement, and the Founder takes those.**

**Permissions that exist, shown rather than invented.** The seeded vocabulary is `restaurant.create`, `restaurant.edit`, `restaurant.delete`, `membership.invite`, `membership.manage`, `reports.view`, `payments.manage`, `tips.configure`, `data.export`, `roles.manage`. The closest existing fit is **`restaurant.edit`** — held by Owner, Administrator and Manager. Whether a Manager should be able to set the venue's payout account is exactly the question above, and it is not answered by picking the nearest available name. No new Permission is proposed here; adding one is an RBAC change with its own reconciliation consequences (ADR-046, ADR-048).

**Not verified:** what the hosted flow shows for a venue whose onboarding is already complete. Reading the API reference says there would be no outstanding requirements to collect, so the form should have nothing to offer — but that is inference from documentation, not an observation, and it is the difference between "bounded" and "harmless".
---

---

# Accepted Risk (Not Closed — Deliberately Left Open)

## Redis flush silently un-revokes outstanding refresh tokens and token families
**Risk:** If Redis is flushed or lost (crash without persistence, manual `FLUSHALL`, infrastructure failure), every revoked `jti` and revoked `familyId` disappears. A previously-stolen-and-revoked refresh token would once again verify successfully by signature until its own natural expiry (up to 7 days, `JWT_REFRESH_TTL_SECONDS`).

**Recorded in:** ADR-019, Consequences. *"Accepted risk, unchanged from the original decision: a Redis flush would silently un-revoke every outstanding refresh token and family flag (they'd still verify by signature until natural expiry, typically within days) — acceptable for MVP; revisit if refresh-token revocation ever needs to survive a Redis outage."*

This is listed here, separately from the Closed Threats above, on purpose: it is a threat the Founder and this project have knowingly chosen to accept for MVP, not one that has a mitigation in place. Revisiting it is an explicit future decision, not a bug.

---

# Open, Not Answered

Genuinely unanswered — not because no one has thought about them, but because the code they'd be answered by doesn't exist yet, or the answer depends on a decision outside this codebase entirely. Listed honestly rather than filled in with a guess, per the Founder's own instruction.

## Cross-Organization access by a legitimately-authenticated caller — reopened, and split, because the two halves no longer have the same evidence

**Reopened from Closed Threat #9 (Sprint 14).** The Founder's argument for reopening is the general one and it is sufficient: *a class that recurs after being declared closed is not closed.* It recurred twice after that declaration, both times proven with data rather than argued:

- **ADR-043** — a zero-permission Waiter exported another Restaurant's transaction rows, amounts included. The guard asked whether the caller held the permission on *any* Membership; the list built its scope from *every* Membership; nothing asked whether those were the same one.
- **PR #84** — an org-wide Owner of an unrelated Organization read another Organization's org-wide Membership **in full, and re-roled it**. Three routes affected: `GET /memberships/{id}`, `PATCH /memberships/{id}`, `PATCH /memberships/{id}/disable`.

**But the sharper reason to reopen is what the closing evidence actually claimed.** Entry #9 was closed partly on a systematic sweep (ADR-028 Decision 5) that reported *"21 real reachability/permission-scoped sites … all confirmed comparing `organizationId` correctly. Zero new findings this pass."*

That sweep could not have found PR #84's defect, and the reason is worth more than the bug. **The comparison was present.** It sat in the second clause of `m.restaurantId === target.restaurantId || (m.restaurantId === null && m.organizationId === target.organizationId)`. When the target was itself org-wide, the first clause was `null === null` — true — and `||` short-circuited before the second clause ever ran. A search that looks for the comparison *finds* it; only reading the evaluation order shows it is unreachable.

**Presence of a check is not evidence of its evaluation.** A sweep that greps for the right idiom certifies vocabulary, not behaviour — and this entry was closed on exactly that kind of certification.

### The two halves, which now differ

**(a) Restaurant-scoped reach — materially stronger, but not independently closed.** ADR-047 consolidated ten call sites onto `isRestaurantReachable` / `hasPermissionAtRestaurant` / `findGrantingMembership`, so there is now *one* implementation rather than ten agreeing copies, and `repo-invariants.spec.ts` fails if the predicate is written inline again. The right-hand side is always a Restaurant id, which is never null, so the short-circuit above cannot arise here.

**(b) Nullable-target reach — this is the half that keeps failing.** `MembershipService.getReachableOrThrow`, `MembershipService.assertPermission` and `WalletService.assertReachable` compare against a **Membership** or **Wallet**, whose `restaurantId` is legitimately nullable. They are deliberately excluded from the shared helpers (ADR-047, Decision 3) because folding them in would propagate whichever version was chosen — and one of them was the broken one. Two of the three were fixed in PR #84; `WalletService` was already correct, because it refuses org-wide Wallets outright with an explicit `restaurantId !== null` guard.

### What would close this, stated so it is not closed again on vocabulary

Not "the rule exists" and not "a sweep found the comparison everywhere". Two things, together:

1. **Every reach check derives from one implementation**, or — where it genuinely cannot, as in (b) — **each exception is individually proven by a test that constructs the null-on-both-sides case**. Two of the three now have one (`membership.service.spec.ts`); `WalletService`'s existing test covers the org-wide Wallet case; `membership.controller.ts`'s invite scope was given one in PR #89 after being verified only by reading.
2. **A new access check of this shape is not accepted on a reading.** `CLAUDE.md`'s Architecture Review paragraph already requires the `organizationId` comparison; it should be read as requiring that the comparison is *reached*, which is the lesson this entry now carries.


## Restoring from a volume snapshot has never been tried, and cannot be tried safely against production
Closed Threat #22 above closed the "no backups, never restored" threat **for PITR specifically**, by an actual rehearsal. Volume snapshots are now configured too — and it would be easy, and wrong, to read #22 as covering them by analogy. **It does not.** They are a different mechanism with a different restore path, and that path has never been executed on this project.

The distinction is not academic. PITR restore is safe by construction: `volumeInstancePITRRestore` takes a `newServiceName` and stands up a *separate* service, leaving production untouched — which is exactly why rehearsing it was possible. Volume-snapshot restore does not work that way: per Railway's own documentation it creates a new volume from the snapshot and mounts it **on the same service** in place of the current one, detaching (but retaining) the old volume, and requires a redeploy to take effect. It additionally **permanently deletes every snapshot newer than the one being restored**. Performing that against the live production service is not a rehearsal — it is an outage plus irreversible loss of newer recovery points.

The failure modes a rehearsal exists to catch are the same ones as for PITR — a snapshot that will not mount, a volume restored without the Ledger's constraints and trigger, a "restore" that silently lands on the wrong point. #22 exists precisely because those are invisible until someone tries. Assuming they are absent here because they were absent for PITR is the reasoning `CLAUDE.md` warns against by name: diagnosing by resemblance to a prior case rather than from this one's own evidence.

**What would actually close it, none of which is available today:** a throwaway service with its own volume and its own snapshot, restored and verified in isolation — which requires the staging environment ADR-035 deliberately defers, since the project has exactly one Railway environment and everything that is not a laptop *is* production. The API signature (`volumeInstanceBackupRestore` takes `volumeInstanceId` and `volumeInstanceBackupId` as separate arguments) *suggests* a snapshot might be restorable into a different volume than its source, which would make an isolated rehearsal possible — but that is inference from a parameter list, not documented behaviour, and testing an inference against production infrastructure is itself the risk being avoided.

Snapshots are configured and accumulating, and are worth having on the strength of the mechanism alone — but until one has been restored and checked, they are the same kind of belief PITR was before its rehearsal. Closing this is a real task for whenever staging exists, not something to mark done because #22 looks similar.

---

The two entries below are grouped together deliberately (Sprint 13, ADR-032 Decision 1): both are economically real, and both are genuinely blocked on the same not-yet-built feature — `Withdrawal`/`Settlement` (`DATABASE.md`, Future Entities) — rather than on missing analysis.

## PROCESSOR_CLEARING is never reversed by a refund or a chargeback
Neither `handleChargeRefunded` (ADR-008, revised by ADR-023) nor `handleDisputeCreated`/`handleDisputeClosed` (ADR-016) ever posts a compensating line against `PROCESSOR_CLEARING` — only `RESTAURANT_REVENUE_PAYABLE`, `PLATFORM_FEE_REVENUE`, and (for refunds, as of ADR-023) `TIP_PAYABLE` are reversed. Investigated in depth for Sprint 13 (ADR-032 Decision 1), not fixed: reversing it now would either break historical consistency across every refund/chargeback already posted (replacing `REFUND_CONTRA`) or record the same fact twice via a redundant parallel account-pair (adding a new account alongside `REFUND_CONTRA`) — and nothing in the system reads `PROCESSOR_CLEARING`'s post-refund balance for anything today, since `Withdrawal` doesn't exist yet. **The future-correct shape is recorded in ADR-032 Decision 1 for whenever `Withdrawal` is designed:** a new `PROCESSOR_CLEARING_CONTRA` contra-asset account (additive, touches no existing row), not a replacement of `REFUND_CONTRA`.

## A Wallet's "Available" balance can still be clawed back after the fact
ADR-023 already makes `TIP_PAYABLE` reversible — a chargeback opened after a tip was allocated debits the waiter's own credit line back out, and `WalletProjectionService` (ADR-024, Sprint 7) would correctly recompute a lower balance the next time it runs. Not a bug: the projection is doing exactly what it's supposed to, deriving the truth from the Ledger. The open question is what "Available" is allowed to promise the person looking at it — today nothing can be withdrawn at all (`Withdrawal` doesn't exist, ADR-024 Decision 2), so a number labeled "Available" that could still shrink tomorrow is not yet a real-money risk, only a display one. It becomes a real one the moment `Withdrawal` ships: money genuinely paid out against an "Available" balance that a later chargeback then reverses is a real loss with no obvious owner (the waiter already has the cash; does the restaurant eat it, does the platform, is there a clawback mechanism at all). Must be answered as part of designing `Withdrawal`, not discovered after it ships.

---

## No multi-factor authentication (OWASP A07:2025, Authentication Failures)
**What exists:** the brute-force/credential-stuffing threat itself is closed (Closed Threats #4–#5) — rate limiting, refresh-token rotation with reuse detection, account-status enforcement on every request. Password policy requires a minimum of 8 characters with no forced complexity rule, the current NIST 800-63B-recommended shape. The breached-password half of what was originally one combined entry here is now separately closed — Closed Threats #19 (ADR-032 Decision 4).

**What's genuinely missing:** no second factor of any kind. Sprint 13 (ADR-032/ADR-033) deliberately did not attempt this — the Founder's own instruction was explicit: MFA is a large, standalone feature, not a point fix alongside five narrower ones, and is tracked separately in `IMPLEMENTATION_PLAN.md`'s Deferred/Not-Yet-Scheduled backlog rather than attempted here.

---

The entry below is a different kind of open item from every one above it — not missing code, not a missing process, but a pending answer from outside this codebase entirely (ADR-029).

## Waiter employment-status classification for GPM (Lithuanian personal income tax) purposes is undefined
**What exists:** none — this is not a code gap. It is a legal-classification question this document cannot answer and no line of code can decide on the platform's behalf.

**What's genuinely missing:** whether a waiter receiving tips through this platform is, for GPM purposes, an employee of the restaurant, self-employed, or something else is undecided — and that classification determines the applicable rate, the legal basis for any tax treatment, and who (if anyone) is the tax agent. This blocks two distinct things, not one: actually computing an estimated tax figure, and merely *displaying* one next to the existing gross/net tip amounts (`MASTERPLAN.md`, "Pilot-Ready Product," ADR-029 Decision 2). Becomes answerable only when the Founder has a written answer from a Lithuanian tax/payroll consultant — not a development task, and not something this codebase's own code can close by itself.

**What this does NOT block, added because it was assumed to and the assumption stood unchallenged for a day: data retention periods.** Those are decided by accounting law and do not wait on this classification. The two were being treated as one open question when only one was open, and the effect was to hold up something answerable — the privacy policy's retention section — behind something that is not. Retention is now determined (`PERSONAL_DATA_MAP.md` §6). **The scope of an open item is part of the item**: an entry that does not say where it stops will be read as stopping wherever the reader fears, and a blocked-on-legal-advice entry is the kind most likely to be read expansively.

## A chargeback after the account is disconnected never reaches our books, and reconciliation reports a discrepancy it cannot resolve
**What exists:** `PaymentReconciliationService` (ADR-031/032) compares our records against Stripe's and reports what does not match. The webhook path processes late events normally and deliberately (ADR-054).

**What's genuinely missing:** the events themselves, once a connected account is disconnected. Stripe stated it in writing on 2026-09-02:

> "If a connected account has been disconnected from your Platform, any events on the connected account will not reach the Platform's webhook endpoint."

A chargeback on a payment taken months before the disconnection is Stripe reversing money our Ledger still records as received. **No event arrives, so nothing reverses it here.** Reconciliation then reports a difference **whose resolving data sits on the other side of a connection that no longer exists** — and reports it on every subsequent run, for that account, indefinitely. ADR-054's guarantee that late events land in the Ledger holds only while the connection does, which nobody on this side controls.

**Options, none chosen:**

- **(a) Reconcile from Stripe's side before the connection is lost** — settle open exposure at closure, on the assumption disconnection follows. Cheap, but it guesses at a human action that may come months later or not at all, and it cannot see a chargeback that has not happened yet.
- **(b) Detect disconnection and freeze that account's reconciliation** — stop reporting differences that are known to be unresolvable, and mark the account's books as closed-with-exposure rather than wrong. Does not recover the money; it stops a permanent false signal, which is the part that erodes trust in the check.
- **(c) Accept the exposure and record it per account** — an explicit, bounded liability rather than a recurring alert. Honest, and it needs a number: what a platform's realistic worst-case chargeback exposure is over the dispute window after a venue leaves.
- **(d) Hold funds until the dispute window closes.** The complete answer and the most expensive, in product terms rather than engineering: it changes what a departing owner is paid and when, which is a commercial decision, not a technical one.

**Not urgent, and the reason is specific rather than optimistic:** no restaurant is connected today, so there is no exposure to carry. This must be answered **before the first pilot restaurant is offboarded**, not before the first is onboarded.

---

## Disconnecting a connected account is Dashboard-only, so offboarding cannot be automated and the product cannot see it happen
**What exists:** nothing. This is not a gap in our code — it is a property of Stripe's API surface, stated in writing on 2026-09-02:

> "There's no API path to disconnect a connected account. It is currently a Dashboard-only feature."

**What's genuinely missing, and it is two separate things.**

**Offboarding cannot be a code path.** Whatever "a venue leaves the platform" is supposed to mean operationally, the final step is a human being logging into a Stripe Dashboard and clicking. No runbook this project writes can be executed by the system, and any future offboarding flow ends in an instruction to a person rather than a call.

**More consequentially: the platform cannot observe it.** With no API to perform the action there is equally no call that reports it, and **the disconnection is performed by the account owner, not by us** — so the party who acts and the party who needs to know are different people, with nothing between them. The platform learns of it only by inference: events that stop arriving, or an API call that starts failing. Neither is watched today, and "events stopped" is indistinguishable from "a quiet venue" without something that expects them.

**Why this is filed separately from the entry above** rather than as part of it: that one is about money that cannot be reconciled, and this one is about a state change the system is blind to. **The blindness is the more general problem** — it would still be a problem if the reconciliation question were answered tomorrow, because every other decision that assumes a live connection inherits it.

**Options, none chosen:** treat a run of failing API calls for one account as evidence and mark it disconnected; add a periodic liveness check per connected account; or accept the blindness and require offboarding to be recorded by hand in our own system, which is the cheapest and depends entirely on somebody remembering — **the shape this project has already recorded as the one that decays** (ADR-058, and the backlog entry on instruments nobody reads).

---

---

# Final Principle

A threat model that only ever grows entries and never grows an "open" section stops being trustworthy at exactly the moment it stops being honest about what hasn't been built. Money moves through this system starting Sprint 5 — that's when every item in "Open, Not Answered" above needs to move up into "Closed Threats," cited against whatever ADR ends up answering it, not silently disappear.
