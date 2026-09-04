---
title: ADR-070 — The invitation is sent, and the token leaves the API response
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-070 — The invitation is sent, and the token leaves the API response

**Status:** Accepted (Sprint 15), 2026-09-04. The onboarding axis. Builds on ADR-069's transport.

---

## Context

`POST /memberships` created a `MembershipInvitation` and handed the raw token back to the caller, who relayed it by hand. ADR-068 established that this was the only option, because the system could not send email at all. ADR-069 built the provider. This connects them.

---

## Decision

### 1. The token goes to the email and nowhere else

**Removed from the API response, and a test asserts its absence.** Leaving it in both places would mean the email path is never the one anybody exercises: the console would keep working, the message could stop arriving, and nothing would say so. **A path that is not the only path is a path that is not really tested.**

The test asserts over the whole serialised response rather than one field, so renaming the field does not quietly restore the leak.

**The tests now read the token where the recipient does** — out of the queued message. Every such read is therefore also an assertion that the email was enqueued and carries a usable link, which is a stronger statement than any assertion about a returned field could be. This is what the falsification asked for: an invitation whose sending is removed fails, because there is no longer anywhere else to get a token from.

### 2. The invitation and its email commit together

`invite()` writes the `MembershipInvitation` and enqueues the email in **one transaction**. An invitation without a queued email is a person waiting for a message nobody will send; a queued email without an invitation is a link that cannot be accepted. Neither half can commit alone.

### 3. The token in the payload, and why the alternative does not work

ADR-069 surfaced the tension: **ADR-020 never persists the token, only its hash, while the Outbox must persist what is to be sent** — and a token cannot be recovered from a hash. Two options were live. This is the one chosen, and the other one is not merely less convenient; **it is incompatible with the retry design.**

Generating the token inside the send handler would keep it off disk entirely. But a retry must resend **the same body**: Resend's `Idempotency-Key` is the OutboxEvent id, so a second attempt carrying a *newly generated* token would be deduplicated by the provider and never delivered, while the stored hash had already moved to the new token. The recipient would hold a link that no longer verifies, and nothing would report it.

So the body — token included — lives in the payload and is **redacted on successful delivery** (ADR-069). The exposure is the delivery window, seconds in the normal case, against a token that then sits in the recipient's mailbox for seven days regardless.

**The honest residue:** an event that fails permanently keeps its body until someone clears it. That is the case worth watching, and it is named here rather than left to be found.

### 4. The copy lives in a dictionary, in English, with no locale resolution

Short: who invited you, where, the link, how long it lasts. Plain text — no HTML, no template engine, no tracking pixel.

**Only `en` exists, and the locale is deliberately not resolved.** An invitation goes to somebody who has no `User` row and therefore no `locale`: the system genuinely does not know what language they read. The inviter's locale is a guess about a different person; the Restaurant's `defaultCustomerLocale` describes its diners, not its staff. `email-copy.ts` is where that decision lands **when there is a second language to choose between** — inventing a resolution rule now would be inventing a business rule to serve a table with one row. Lithuanian will be written by a native speaker, and a dictionary entry is already the work item; a literal buried in a service has to be found first.

### 5. The wire is production-only, and that is a gate rather than a bypass

`EmailService` refuses to make the HTTP call unless `NODE_ENV === "production"` — the same gate ADR-038 put on the Stripe boot probe, on the same variable, for the reason that ADR gave: a variable that already exists and is already load-bearing beats a new switch whose only purpose is to be turned off.

Without it the e2e suite, which boots the real `AppModule` and therefore the real Outbox poller, would make **live HTTPS calls to Resend with a placeholder key on every CI run** — a network dependency inside the test gate and outbound traffic carrying a fake credential.

**It refuses rather than quietly succeeding.** A silent no-op would write `SENT` into an audit record for a message nobody was handed, and a delivery record that lies is worse than none. The refusal lands in `EmailDelivery.lastError`, visible and true.

**The consequence, stated plainly: the wire is exercised in production and nowhere else.** That is precisely what a single live verification is for, and it is the next step.

---

## Raised here, decided by the Founder, fixed elsewhere

Both of the following were surfaced by this change rather than caused by it. Both were put to the Founder as findings, and both came back as decisions on the same day; the decisions are recorded here and carried out where they belong.

### The consent gap gets materially worse, and that is the point of raising it now

`AuthService.register` writes an `AgreementAcceptance`. **`MembershipInvitationService.accept` does not** — it is the second `User`-creation path, and it predates ADR-049. Confirmed by reading both, not inferred.

**The gap does not change in nature. It changes in scale, and it becomes unrepairable in arrears.**

- **Before:** a human had to copy a token by hand, so invited accounts were rare and effectively internal. The gap was theoretical.
- **After this change:** the invitation actually arrives, so this becomes **the normal way waiters get accounts** — the default path for the majority of users in Model B.
- **The asymmetry grows with adoption:** owners who self-register have recorded consent; the staff whose personal data and earnings we process do not. That difference widens with every venue onboarded.
- **Consent cannot be backfilled.** A record written later says someone agreed at a moment when they were not asked. Every day this runs adds accounts that can never be made correct retroactively.

**Founder decision: fix it, and not in this change — the trigger is an event rather than a sprint.** It must be closed **before the first venue onboards staff**, and the reason the deadline is phrased that way is that the cost is strictly increasing while the repair is not available later: nothing is lost by fixing it while zero staff accounts exist, and everything created before the fix is permanently uncorrectable. Recorded in `IMPLEMENTATION_PLAN.md` with that trigger.

Its own axis, deliberately: this change is onboarding delivery, that one is consent capture, and a legal record should not land as a side effect of a mail feature. The natural home is the invitation accept screen, which does not exist yet — doing it earlier would mean recording a consent nobody was shown.

### The invitation rate limit now protects something different

Sprint 11's own comment set the condition — *"revisit this number once a real delivery provider exists and email-spam becomes the actual risk"* (ADR-028) — and ADR-069 met it.

**Founder decision: 20/min becomes 5/min.** What the limit protects has changed, and that is why the number moved rather than merely being re-examined: it used to bound rows in a table we own, and it now bounds real mail leaving a verified domain to any address a caller names, so the worst case is **domain reputation** — shared by every future message and slow to repair. A restaurant onboards staff in batches a few times a year, not continuously, so 5/min covers the real workflow with room to spare. 20/min was 1,200 messages an hour; 5/min is 300, and no venue has needed either.

**Asserted by an integration test, not only declared on the decorator** — a rate limit nobody exercises is a comment.

---

## Consequences

**`FRONTEND_URL` gains a second load-bearing use.** It was the Stripe onboarding `return_url`; it is now also the invitation link. ADR-045's production rule rejecting a loopback value already covers both — and the second use makes that rule more valuable, not merely still true: a localhost link in an invitation is a link that works for nobody.

**The accept screen still does not exist.** The link points at `/invitations/accept`, which the API serves and the frontend does not yet render. The email is correct; the page it leads to is the next piece of onboarding work.

**Not in this change:** webhook consumption, Lithuanian copy, HTML mail, templates, the consent fix itself, and anything touching `TAX_PAYABLE` (ADR-029).
