---
title: ADR-061 — Waiter onboarding in Stripe: one person, one account; starts at invitation; no tips until verified
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-061 — Waiter onboarding in Stripe: one person, one account; starts at invitation; no tips until verified

**Status:** Accepted (Sprint 14), 2026-09-02. Schema and record only; the money fork is not built.

---

## Context

Model B — the tip belongs to the waiter — is the single target model (ADR-053; MASTERPLAN, Product Positioning). Its money fork is blocked on a written answer from the regulator. **Waiter onboarding is not.** Whatever the regulator says about who is the tax agent, the waiter's Stripe account has to exist and be verified before a euro can be moved to it — and **that requirement comes from Stripe, not from Lithuanian law.** So everything around the fork can be decided now, and this ADR decides it.

Three of ADR-061's questions were left open at the end of MASTERPLAN's positioning section as *"blocking design, not merely implementation."* This ADR answers all three.

### What Stripe actually requires — established against the live API, not the documentation

On 2026-09-02 a test-mode v2 account was created for an **individual in Lithuania** with a **recipient** configuration (`configuration.recipient.capabilities.stripe_balance.stripe_transfers`), `dashboard: "none"`, and read back with `include: ["requirements"]`. No real person's data was submitted; the account was closed afterwards. The account came back with **12 requirement entries**, every one `awaiting_action_from: user`, every one restricting both `stripe_balance.payouts` and `stripe_balance.stripe_transfers`:

| Group | Fields |
|---|---|
| Name | `identity.individual.given_name`, `identity.individual.surname` |
| Date of birth | `identity.individual.date_of_birth.{day,month,year}` |
| Address | `identity.individual.address.{line1,city,postal_code}` |
| Bank account | `external_account` |
| Terms | `identity.attestations.terms_of_service.account.{date,ip}` |
| Profile | `defaults.profile.business_url` |

**Two things this establishes that reading would not have.** First, **no identity document is required at creation** — name, date of birth and address are typed, not uploaded. A document request may arrive later from Stripe's own risk checks after submission; that was not observed, because nothing was submitted. Second, **`business_url` is required even for an individual** — a field the onboarding screen has to supply on the waiter's behalf (the platform's own URL is the honest value; a waiter has no business URL).

**The hosted onboarding flow was opened with a real account link.** Its first step is Stripe's own contact gate — email, phone number, country pre-filled to +370, a Terms consent line — with Lithuanian available as a language. The steps after that gate were **not observed**, by the boundary of this task: seeing them requires entering a person's details. What they collect is the list above; how many screens Stripe splits it across is unknown and must not be inferred.

**Two API facts recorded because they will bite:** v2 `accounts.list` accepts at most `limit: 20`; and closing a v2 account requires naming its `applied_configurations` (`["recipient"]` here) or the API refuses with `configs_must_match_to_close`.

---

## Decision

### 1. One person, one connected account — attached to the User, never to a Membership

`User.stripeAccountId`, unique and nullable, with its derived status fields alongside. **A Membership references the account through `userId`; it does not own one.** A waiter completes KYC once and carries it between venues: invited to a second restaurant, nothing is created — the new Membership resolves to the same account.

**This answers MASTERPLAN's third open question — one Stripe account or two for a waiter at two restaurants — with one.** The alternative, one account per Membership, would mean a person verifying their identity again for every employer, and two payout streams that never meet. It would also leave the person's own earnings across employers invisible as one figure to the only party who should see it: the person.

**It is a recipient account, not a merchant one.** A restaurant's account (ADR-014) is `dashboard: "full"` with `card_payments` — it takes payments and is merchant of record. A waiter's is `dashboard: "none"` with `stripe_transfers` — it receives, and never charges. The two are different shapes of the same object, and `User.stripeAccountId` must never be handed to code written for `Restaurant.stripeAccountId`.

### 2. Onboarding starts at invitation, and does not block the shift

When a person is invited to a venue as staff, the account is created and the onboarding link is offered. **The waiter works from day one.** Nothing about serving a table, being on a rota, or holding a Membership waits on verification.

**This answers MASTERPLAN's first open question — at invitation or later — with at invitation, without the cost that made "later" tempting.** The cost of "at invitation" was a venue short-staffed on a Friday facing an identity check before the first shift. Decoupling onboarding from working removes that cost: the check starts on day one and finishes when it finishes, and the shift happens regardless.

### 3. Until the account is verified, tips are NOT collected for this waiter

**The person does not appear on the terminal as a recipient** until `stripe_transfers` is active. A customer cannot be asked to tip someone the platform cannot pay.

**This answers MASTERPLAN's second open question — what happens to tips earned before KYC — by making sure there are none.** Two alternatives were considered and rejected, and both are recorded because each will be re-proposed by someone who has not read this:

- **"Collect to a colleague's account, they will pass it on."** Someone else's money on a private individual's account. For the colleague it is income — theirs, in every record the tax authority sees. The Ledger would attribute the tip to one person while the money sits with another; the two would disagree from the first cent, and reconciliation would be reporting the truth.
- **"Collect to the restaurant's account, an administrator hands it over."** This is Model A without Model A's legal basis: the venue holding a named individual's tip with no employer-distribution framework behind it — or, if handed over outside the platform, an unrecorded payout that the Ledger never sees.

**Both solve the technical question at the cost of the thing the product exists for.** The first claim in the positioning is *"you need to know where every euro goes."* Both alternatives are ways of not knowing. The decision is the only one under which the Ledger stays true: a tip is attributed to a person only when it can reach that person.

**What this costs, stated:** a waiter's first days may be tip-less on the terminal. The onboarding screen's job is to make that window short, which is why it starts at invitation.

---

## Schema

Added to `User` (migration `sprint14_waiter_stripe_account`):

| Field | Purpose |
|---|---|
| `stripe_account_id` (unique, nullable) | the recipient account; null until invited as staff |
| `stripe_onboarding_status` (`onboarding_status`) | `COMPLETE` when `stripe_transfers` is active — the one status that decides recipient eligibility |
| `stripe_transfers_status`, `stripe_payouts_status` | raw capability statuses, separate because they answer different questions: may money reach this account, and may it leave to a bank. A person can be a valid recipient while payouts still wait on a bank account |
| `stripe_requirements_due` (json) | `requirements.entries` as returned — what the onboarding screen shows |
| `stripe_account_created_at` | when the account was created, for the "how long has this been open" question |

The existing `onboarding_status` enum is reused rather than duplicated; it already says what needs saying. **All status fields are derived from the live account on refresh, never parsed from a webhook payload** — the same rule Restaurant follows (ADR-009), for the same reason.

**The erasure invariant caught this schema on its first full run, and that is recorded as the mechanism working.** ADR-052's check fails when a `String` field appears on `User` that `redact-user.ts` classifies as neither redacted nor retained; the three new string fields tripped it. They are classified **retained**, with the reasoning in that file: `stripeAccountId` is a join key to a financial counterparty — the same shape as `id` and `Membership.id`, which is what lets a person be emptied while the money stays reconcilable — and the identity behind it lives at Stripe, erased there by Stripe's process; the two capability statuses are facts about an account, not about a person. **Whether an emptied person must also stop being a selectable recipient is a Model B question that nothing today needs answered**, and it is left open there rather than settled by a default.

---

## Permissions — the Waiter role stays at zero, and now says why

The Waiter role holds no Permissions, and this ADR keeps it so. **It was checked rather than assumed that a zero-permission Waiter can reach their own Wallet today:** `GET /wallets` is guarded by `JwtAuthGuard` alone and returns the caller's own Wallets by construction. Ownership, not permission, is the rule for everything a waiter does with their own money — and starting or resuming one's own onboarding is an act on one's own User row, the same rule.

**The one thing a Permission would have to express here cannot be a Permission.** Whether a person may be selected as a tip recipient is not a right a Role grants; it is a fact about a third party's verification. Encoding it as a Permission would put a Stripe status into the RBAC matrix, where it would be reconciled by `seed.ts` and could be granted by an Owner. It is enforced at staff selection instead, from `stripe_transfers_status`.

---

## Not decided here, and not to be built until decided

- **The money fork.** No transfer, no separate charge, no `stripe_transfers` call. ADR-053's block stands.
- **Tax.** Nothing here shows or withholds anything. The regulator's answer decides which.
- **The onboarding screen.** What it collects is now known (the table above); what it looks like is frontend work, gated on the Terms and on the pilot.
- **Whether Stripe requests an identity document after submission.** Not observed; must be established the day a real waiter onboards, not inferred from the empty requirement list at creation.
