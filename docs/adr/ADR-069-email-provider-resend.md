---
title: ADR-069 — Resend as the email provider, and email as the Outbox's second consumer
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-069 — Resend as the email provider, and email as the Outbox's second consumer

**Status:** Accepted (Sprint 15), 2026-09-04. The transport and the plumbing. **No caller yet** — no email is sent by any code path this change adds.

---

## Context

ADR-068 established by looking that this system could not send email at all, and that the invitation returns a token over the API for a human to relay by hand — which blocks waiter onboarding, the critical path of Model B. The Founder chose **Resend**, verified `plaintabs.com` (DKIM, SPF, MX green; DMARC `p=none` with `rua`), and put `RESEND_API_KEY` into Railway.

This change builds the provider. The invitation itself is the next one.

---

## Decision

### 1. The key is shape-checked at boot — and the obvious way to write that rule was wrong

`RESEND_API_KEY` joins the Stripe secrets under ADR-038's discipline: a malformed key stops the process at startup, where a human is watching, rather than at the first send, where nobody is.

**Copying the neighbouring Stripe regex would have been a production outage.** Stripe's rule is `^(sk|rk)_(test|live)_[A-Za-z0-9]+$` — alphanumerics after the prefix. A real Resend key has the shape `re_<publicId>_<secret>`: **`re_`, an id, an underscore, then the secret.** The transplanted pattern rejects every valid key, and the failure is a refusal to boot on the first deploy.

The rule is `^re_[A-Za-z0-9_]+$` with a 32-character floor, established from Resend's own documented key format. **The first test in the suite is the one that catches this**, and it was verified by execution: with the naive pattern in place, env validation fails with `RESEND_API_KEY is malformed` and the application cannot start.

**Required in every environment, with no `.optional()` and no `.default()`.** ADR-045's rule: a gate that other behaviour is conditional on cannot itself be conditional, because a default makes its absence unobservable. Absence and emptiness are both rejected, separately asserted — this project has been bitten three times by code that only checked one.

### 2. No SDK

The requirement is one `POST` with a bearer token, a JSON body and one extra header. An SDK for that is dependency surface in a system whose CI runs a vulnerability gate on every push. `fetch` is in the runtime. If Resend's protocol grows past what fits in one method, that is when to reconsider — not in advance.

### 3. The sender is a constant, not configuration

`noreply@plaintabs.com`. The domain is verified once at DNS level and is identical in every environment this system runs in. **A configuration knob would only add a way to get it wrong**, and a sender that does not match the verified domain fails at Resend, at send time, silently — exactly ADR-045's class of failure. A second sending domain is what would make this configuration.

### 4. Sending goes through the Outbox — and that makes this the SECOND consumer

A direct `await email.send(...)` in a request handler loses the message on any crash between deciding to send and sending, and makes the caller's transaction depend on a third party being reachable. The intent is written in the same transaction as the business fact that caused it.

**This is the trigger the project wrote down in advance.** `IMPLEMENTATION_PLAN.md` (Deferred) records that `OutboxPollerService` has no claim step, and that of its two triggers — a second backend instance and a second consumer — *"the second is the one to defend against, precisely because it does not announce itself: the first fires when someone chooses something, the second fires when someone ships a feature."* The poller's own comment names email as the case that turns a double dispatch into a double effect, and ends *"Fix the claim first."*

**The claim step is not fixed here, and this is the honest account of why.** It changes the Outbox's concurrency contract on the money path — a different axis of risk from an external integration, needing its own tests and its own review. Instead this change makes a double dispatch harmless **for this consumer**, by two independent mechanisms:

- **`EmailDelivery.outboxEventId` is UNIQUE.** A second dispatcher fails at the database, not at the recipient.
- **Resend's `Idempotency-Key`, keyed on the OutboxEvent id.** Documented: unique per request, max 256 characters, **expiring after 24 hours**. That expiry is a real boundary, stated rather than buried: a retry of the same event more than 24 hours later — a stuck event replayed by hand — is outside the provider's protection and rests on the unique constraint and the already-`SENT` check alone.

**Neither is a substitute for the claim step**, which remains missing for whatever consumer comes third. The threshold for fixing it and the threshold for turning the poller's branch into a handler registry are the same threshold, and it has not been reached.

The routing itself is one branch on `eventType`, and its additivity is asserted: a journal-entry event still reaches `WalletProjectionService`, a malformed payload still fails fast without it, and removing the branch fails **only** the routing test.

### 5. A failure leaves a trace, because silence is the failure mode

`EmailDelivery` records the recipient, the subject, the status, the provider's message id on acceptance, and **the provider's own words on rejection**. A record saying only "failed" cannot be acted on.

The row is written **before** the send is attempted, in the same transaction as the request — so *"we decided to send"* and *"there is a record of the send"* are one fact rather than two that can disagree. The handler records the outcome and then **rethrows**, so the poller's existing attempt counter and its alert at five failures still fire. It records; it does not swallow.

**`status` has `PENDING`, `SENT`, `FAILED` and deliberately no `DELIVERED` or `BOUNCED`.** Those are facts only Resend's webhooks can supply, no webhook endpoint exists in this change, and an enum value nothing can ever set is a promise the system does not keep. **`SENT` means Resend accepted it**, which is not delivery, and the name says so.

### 6. The body does not stay

An email body is the one Outbox payload that can contain a secret — an invitation link is a credential — and a published row is kept forever. On success the payload's `text` is replaced with a marker, bounding the body to the delivery window. **`EmailDelivery` never stores the body at all.**

This makes an email event non-replayable, which for a money event would be wrong and here is the point: replaying a send is precisely what must not happen.

---

## Resend's webhooks — established as fact, and NOT acted on here

The Founder asked which events Resend emits about delivery, failure and spam complaints. From Resend's own documentation:

| Event | What it would mean for us |
|---|---|
| `email.sent` | Redundant with our `SENT` — the API response already told us |
| `email.delivered` | The recipient's mail server accepted it. The only positive evidence we can ever have |
| `email.bounced` | **Permanently rejected.** The invitation never arrived; the person is waiting for something that will not come |
| `email.complained` | Marked as spam. A deliverability signal for the whole domain, not just this message |
| `email.delivery_delayed` | Temporary failure, still retrying |
| `email.failed` | Provider-side send failure after acceptance |
| `email.suppressed`, `suppression.added` / `suppression.removed` | The address is on Resend's suppression list — every future send to it silently does nothing |

Also emitted: `email.opened`, `email.clicked` (tracking — **not wanted**: a transactional invitation has no reason to report reading behaviour), and `domain.*` / `contact.*`.

**What would have to be decided, and is not decided here:** which of these get an endpoint, whether a bounce alerts an operator or only marks the row, whether a suppression blocks re-inviting the same address, and how the webhook is authenticated. `providerMessageId` is stored now precisely so that a webhook can be correlated back to a delivery when that work happens.

---

## The live credential probe — options, not a decision

ADR-038's Stripe probe makes one cheap authenticated call at boot in production, because shape validation cannot catch a one-character truncation. The same gap exists for Resend. **The Founder asked for options rather than a choice, and the reason is real: sending an email at every boot is not acceptable, and Resend's cheap read-only endpoint carries an unknown.**

1. **`GET /domains` at boot.** Read-only, no message sent, one request. **The unknown:** Resend documents two API-key permission levels but does not document which endpoints a *sending-access* key may call. If the production key is sending-only, this probe fails against a perfectly good key — turning a safety mechanism into a boot failure. **Testable in minutes against the real key, and that test is the prerequisite for choosing this.**
2. **No probe; rely on the first real send.** Cheapest. The first send is an invitation, so the cost of learning late is a waiter who never receives one — and the delivery record does show the failure, which is more than the Stripe case had.
3. **Probe on first use, not at boot.** One verification per process lifetime, triggered by the first send rather than by startup. Avoids the permission question at boot but moves the failure to the same place as option 2.
4. **Send a real message to a fixed internal address at boot.** Genuine end-to-end proof, and unacceptable: an email on every deploy and every restart, which is exactly the mechanism-that-becomes-noise CLAUDE.md warns about.

**No probe is implemented in this change.** Option 1 is the one worth measuring first; the measurement is a single authenticated request with the production key, and it belongs to the Founder's own account rather than to this session.

---

## The tension this change surfaced and did not resolve

**ADR-020 deliberately never persists the invitation token — only its hash. The Outbox, by construction, must persist what is to be sent.** A token cannot be recovered from its hash, so an email body containing an invitation link cannot be rendered later from stored data: it must either be in the payload, or the token must be produced at send time.

That is a decision for the change that introduces the invitation email, not this one, and both options are real:

- **Body in the payload, redacted on delivery** — what this change's mechanism already supports. The token is at rest for the delivery window, seconds in the normal case, and for as long as an event stays stuck in the failure case.
- **Generate the token in the handler** — the token then never exists at rest at all, at the cost of making `MembershipInvitation.tokenHash` nullable and splitting invitation creation across two moments.

---

## Consequences

**`.env.example` and CI both gain the variable**, and the CI placeholder is deliberately shaped `re_<id>_<secret>` — a simplified placeholder would pass a rule that real keys fail, which is the failure this ADR is named for.

**A realistic example key cannot be written down, and that was learned by trying.** The first version of this ADR, the schema comment and `.env.example` all quoted a realistically-shaped key to make the underscore concrete. GitHub's secret scanner blocked the push, correctly identifying it as a Resend API Key. The project already has a rule for this exact moment — `ci.yml` records that a placeholder realistic enough to satisfy our own validation is by construction realistic enough to trip the scanner, and that clicking the unblock link *"would have been the wrong lesson: nobody should be training themselves to wave through secret-scanning warnings."* The literal was replaced with the shape `re_<publicId>_<secret>`, which conveys everything the example did and cannot be a credential. **The unblock link was not used.**

**Nothing sends yet.** `EmailOutboxService.enqueue` has no production caller; the tests construct events directly and every transport in them is a stub. No test in this repository makes a network call to Resend.

**Not in this change:** the invitation email (next), webhook consumption, templates, any Lithuanian text, scheduled report delivery (ADR-068 estimated it; no decision exists), and anything touching `TAX_PAYABLE` (ADR-029).
