---
title: ADR-068 — Scheduled report delivery: the estimate, and the fact it rests on
version: 1.0.0
status: Proposed
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-068 — Scheduled report delivery: the estimate, and the fact it rests on

**Status:** Proposed (Sprint 14), 2026-09-04. **Estimate only — nothing is built.** A Founder vendor decision is required before any of this becomes engineering work.

---

## The fact first, because everything depends on it

**This system cannot send email. Not "does not yet" — there is no capability of any kind.**

Established by looking, not by assuming:

| Checked | Result |
|---|---|
| Mail packages in any `package.json` (nodemailer, SendGrid, Postmark, Resend, Mailgun, SES, SMTP) | **none** |
| Sending code in `apps/backend/src` (`sendMail`, `sendEmail`, `createTransport`, `mailer`) | **none** |
| Outbound channels that do exist | `ALERT_WEBHOOK_URL` only — a generic HTTP webhook for operational alerts, optional, and not email |

**And the invitation does not send email either**, which was the specific question asked. `MembershipInvitationService.invite()` returns `{ id, email, token }` to the API caller, and its own field comment says so plainly: the token *"exists exactly once, here — never persisted (ADR-020). The caller is responsible for relaying it (email, Slack, whatever) until a real delivery provider exists with its own ADR."*

**So an invitation today is a token handed back over the API and relayed by a human.** Nothing is delivered by the system.

---

## What this changes about the shape of the work

**Scheduled delivery is not an analytics feature. It is new external infrastructure, a vendor, and a Founder decision** — and the analytics part of it is the part that is already finished.

**The scheduling half is close to free.** `@nestjs/schedule` is already a dependency, `ScheduleModule.forRoot()` is already registered once in `OutboxModule`, and three services already run on it: the Outbox poller, `PaymentReconciliationService`, and `ShiftService`'s scheduled close (ADR-064). A monthly or weekly trigger is a fourth `@Interval`/`@Cron` in an existing pattern.

**The delivery half does not exist at all**, and most of its cost is not code.

---

## What would be required

### Decisions that are the Founder's, not engineering's

1. **Which provider.** The constraint that narrows it is not price: the recipient list and the file contents are personal data (`PERSONAL_DATA_MAP.md` — `email`, `displayName`, and per-person earnings), so the provider becomes a **processor** and needs a DPA and an answer on EU data residency. GDPR is the binding consideration; deliverability is the second.
2. **Attachment or link.** A CSV attached to an email puts names, addresses and per-person earnings into an inbox we do not control, permanently and un-revocably. A short-lived signed link keeps the file behind our own authentication and can be withdrawn. **This is a data-protection decision with a real trade-off** — the attachment is what an accountant actually wants — and it changes `PERSONAL_DATA_MAP.md` either way.
3. **Who receives it.** There is no "report recipient" concept anywhere in the schema today. The natural candidate is the Accountant Membership's own email (ADR-066), which needs no new configuration and inherits the reachability rules; an explicitly configured recipient list is the alternative and is a new entity.

### Work that is engineering, once those are answered

4. **Domain authentication — SPF, DKIM and DMARC on the sending domain.** DNS records, not code. Without them a financial report is filed as spam or rejected outright, and the failure is silent to us.
5. **A configuration variable of the correct shape.** By this project's own rule (ADR-045): it is a gate that other behaviour is conditional on, so it takes **no default** — a default would make the condition unobservable, and a conditional guard is only as reliable as the thing it is conditional on.
6. **Delivery through the Outbox, not a direct call.** Sending a financial report is a disclosure event: it must be recorded, at-least-once, de-duplicated, and replayable. The Outbox pattern is already in this codebase for exactly this shape of problem (ADR-024), so this is reuse rather than invention.
7. **Bounce and complaint handling.** A bounced report is a report the accountant never received, and **silence is indistinguishable from success** — which is the failure mode that matters when someone is relying on the file for a filing deadline. This is an inbound webhook from the provider plus an alert, and it is not optional if the feature is to be trusted.
8. **An audit record** of what was sent, to whom, and when — `AuditLog` exists and this is a natural entry.

### Cost, honestly separated

| Part | Estimate |
|---|---|
| The schedule itself | ~half a day (a fourth `@Interval` in an existing pattern) |
| Delivery: provider integration, Outbox wiring, bounce webhook, audit, config, tests | **3–5 days**, and only **after** items 1–4 |
| Vendor selection, DPA, DNS | **not engineering time** — Founder and calendar time, and the DNS change has propagation delay |

**The 3–5 days is the honest number for the code. It is not the honest number for the feature**, because the feature cannot start until a vendor exists.

---

## Recommendation

**Do not build this now.**

The customer pain it removes is already mostly removed by the two changes that precede it. An accountant with the Accountant role (ADR-066) can pull both lists on demand (ADR-067). **Scheduled delivery converts "they fetch it" into "it arrives"** — real convenience, but convenience, not capability. Against that it introduces an external processor of personal financial data, a new silent-failure mode, and a permanent DNS and vendor dependency.

**One finding argues for making the vendor decision sooner than the report feature needs it**, and it is the reason this ADR is worth reading even if the answer is "not now": **the same missing capability already blocks invitations**, where a token is relayed by hand today. That is on the onboarding critical path and is a worse problem than a report an accountant can already download. **If a provider is chosen, choose it for the invitation and let reports follow** — the integration is the same, and sequencing it that way pays for the vendor with the more urgent need rather than the less urgent one.

---

## Boundaries observed

**Nothing was built.** No provider was added, no configuration variable was introduced, no code was written. No tax logic anywhere. `TAX_PAYABLE` untouched (ADR-029). Till and bank reconciliation not started — no integrations exist and the pilot limitation is already recorded; `PaymentReconciliationService` stays calendar (ADR-065 §4).
