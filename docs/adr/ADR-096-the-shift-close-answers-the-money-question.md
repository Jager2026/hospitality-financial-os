---
title: ADR-096 — The shift close answers the money question
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-096 — The shift close answers the money question

**Status:** Accepted (Sprint 17), 2026-09-15. The requirement changed before this was built, and the
change is the reason it could be built at all: **the owner does not need the money by midnight, they
need to know the amount and the date.** We do not advance funds. So the product is *predictability*,
and a fast payout is a paid option rather than a promise.

---

## 1 · What was measured before anything was written

**`available_on` is computable, and the rule held on thirteen real transactions across three
dates:** it is **midnight UTC of the charge's UTC date plus the account's payout delay**, with the
time-of-day always exactly `00:00:00`.

| charge (UTC) | `available_on` |
|---|---|
| 2026-08-18 20:51–20:59 | 2026-08-25 00:00 |
| 2026-09-14 19:20 | 2026-09-21 00:00 |
| 2026-09-15 14:35–14:36 | 2026-09-22 00:00 |

**How fast the numbers arrive:** eight charges, **8 of 8** resolved, BalanceTransaction present
after **min 2448 ms, median 2635 ms, max 3111 ms**.

**Where the shift boundary falls against the availability boundary:** UTC midnight is **03:00 in
Vilnius in summer (GMT+3) and 02:00 in winter (GMT+2)**. So a restaurant trading 18:00–02:00 in
summer stays inside one UTC date and gets one answer; a bar closing at 04:00, or anything past 02:00
in winter, genuinely has **two** arrival dates for one evening.

**And the finding that made this work necessary at all: `available_on` was nowhere in the
repository.** Zero occurrences. The BalanceTransaction ADR-094 already fetches carries the date, and
the fetch returned three of its sixteen fields and discarded the rest.

---

## 2 · The field, and what is still discarded

`transaction.funds_available_on`, written by the **same conditional update** that claims the fee — so
the date and the fee cannot disagree about which delivery produced them.

**The reason is not the round trips.** Without the column, answering *when does this money arrive*
at shift close needs Stripe reachable, once per transaction. That makes a venue's own closing figure
fail for a reason that has nothing to do with that venue. **A closing till must not depend on a
third party's uptime.**

**What a BalanceTransaction actually carries, enumerated from a live object rather than from
documentation** — sixteen fields, of which we now keep three:

| kept | `id` (as `processor_fee_balance_txn_id`), `fee`, `available_on` |
|---|---|
| **not kept** | `amount`, `net`, `balance_type`, `created`, `currency`, `description`, `exchange_rate`, `fee_details`, `reporting_category`, `source`, `status`, `type` |

Two are worth naming because somebody will ask. **`net`** is `amount − fee`, which we can compute and
therefore need not store twice. **`status`** (`pending` until `available_on`, then `available`) is a
live fact that would be stale the moment it was written down. **Each of the others is a separate
decision, listed rather than taken.**

---

## 3 · The contract: a list, never a number

```
grossRevenue   the bill, before anything          always known
tips           the staff's, not the venue's       always known
deductions[]   { kind, amount, state }            stripe_processing | platform_fee
netToVenue     gross less every deduction         known only when every deduction is
availability   { rows: [{ availableOn, amount, transactions }], unresolved, state }
```

**Every amount carries one of three states, and they do not look alike:** `available`, `pending`
(recent payments, the number is coming), `unavailable` (it is not coming). **`null` never means
zero** — a known fee of zero renders as zero, and only an unknown one renders as words.

### The two shapes, and what each breaks

**A list of deductions.** A fourth deduction — currency conversion, an Instant Payout fee — is a
fourth row; every consumer that walks the list keeps working. *What it breaks:* a consumer wanting
"the Stripe fee" must search by `kind` rather than read a field, and a typo in a key fails at
runtime rather than at compile time.

**Top-level fields** (`stripeFee`, `platformFee`, …). Direct, greppable, typed. *What it breaks:*
the fourth deduction is a breaking change to every consumer, and there is no obvious place to hang a
per-amount state — which is how `processingFee: null` came to mean three different things before
ADR-094 split them.

**The list is what shipped, and the requirement chose it rather than a preference:** "the contract
must hold when a fourth deduction appears" excludes the second shape by construction. If that
requirement is relaxed, swapping shapes is a rewrite of one method and its tests.

---

## 4 · The fetch, and a date that may move

The date is fetched by **ADR-094's mechanism unchanged** — no new form, no second scheduler.

**The payout delay is not constant.** Lithuania's settlement timing is **7 calendar days initially
and 3 business days once the account is established**, and *"risk criteria might prevent your
account from changing to the default"*. So the dates of *future* payments will shorten.

**Whether an already-created transaction is re-dated: NOT ESTABLISHED, and it is not for want of
trying.** Three routes were attempted and each was closed:

- changing `delay_days` on our own platform account — *"You cannot use this method on your own
  account"*;
- changing it on a v2 connected account of the type the product creates — *"You cannot change
  `settings[payouts][schedule][delay_days]` via API once an account has been activated"*;
- creating a v1 account the platform fully controls, where the delay **is** settable — Stripe now
  refuses v1 account creation outright for this integration.

**And the second refusal has a cause worth recording, because it is ours.** The documentation says
*"You can edit this property on accounts where you own fraud and dispute liability"* — and ADR-092
established that we deliberately do **not**: our accounts carry `losses_collector: "stripe"`. The
API refusal is a consequence of that choice, not an arbitrary limit. What the platform **can** still
set is the `interval`, including `manual`, measured and accepted.

**So what does the owner see if the date changes after they have read it?** Not a silent rewrite. A
figure shown at close is what Stripe said at that moment; a later disagreement is recorded **beside**
it as a correction, the same rule ADR-002 applies to money — history is immutable and a correction
is a new fact, never an edit. **A promised date quietly overwritten is the worst kind of
inaccuracy — worse than no date at all**, because it destroys the only thing the screen was for.

---

## 5 · The screen, and the wait

**One line answers the question**; everything else is below it and smaller. Two dates are two lines,
never one sum. The sentence is *"€X available on D"*, not *"€X in your account on D"* — Stripe makes
funds available on that date, and the payout and the receiving bank each take their own time after
it. We can promise the first and not the second.

**The close waits up to 15 seconds**, and the number is measured rather than chosen: Stripe's
BalanceTransaction arrives in 2.4–3.1 s, ADR-094's fetch then spends a 2-second poll and a 2/4/8-second
backoff against a four-attempt cap — about fourteen seconds in all. Fifteen covers it with nothing
left over. **Past that point the answer is not "still waiting" but `unavailable`**, a different state
with a different sentence, because the fetch has given up rather than being slow.

While waiting, the screen says so in words. **Silent waiting and an incomplete total are both
wrong**, and they are wrong in the same way: each lets somebody believe a number that is not yet
true.

### Falsification — measured by removing each mechanism

| removed | how it fails |
|---|---|
| storing `available_on` (dropped from the claim) | `the date list is empty: expected [] to have a length of 1`, and **three of three tests fail** — every transaction falls into `unresolved` and no row can be grouped |
| reporting an unknown fee as a number | `a fee nobody has read was reported as a number: expected '195' to be null`, and **exactly one test fails** |

Different words and different casualty counts, which is the second signal that the two mechanisms
are checked separately rather than as a pair.

---

## What this does not do

**No Instant Payouts.** Its own axis, and unavailable to new accounts anyway.

**No renaming.** `PROCESSOR_CLEARING` and the other classes ADR-093 found wrong under direct charges
stay as they are; OC-15 still holds that.

**The read-modify-write class is not closed.** This adds one more conditional write to a column
alongside an existing one; that is a fifth use of an idiom, not a mechanism.

**And one the database reset exposed rather than caused.** The browser test that follows an invitation link reads it out of the queued email — correctly, because the token exists exactly once and only there (ADR-070). The product then destroys that body on purpose: EmailService refuses to send outside production, the poller abandons the event, and ADR-075 replaces the text so a live address and a live token do not sit in the queue. **On an accumulated database the poller never got that far in time; on a freshly reset one it wins every time**, and the test failed with `contains no link` — a message pointing at the mailer rather than at the redaction. Fixed by starting the watch **before** the click, so the row is read milliseconds after it exists and up to two seconds ahead of the poller. The deep queue had been protecting that test by accident, which is OC-10 wearing its other face.

**One thing this change cost, recorded because it is the second time in two days.** The ADR-094
integration spec declares its own copy of what `retrieveProcessingFee` returns and silences it with
`as any`. Adding a field to the real method did not break that copy at compile time — the suite
caught it at runtime instead. That is **OC-18 biting inside the pull request that recorded it**, and
it is the exact population ADR-095's contract cannot reach.
