---
title: ADR-059 — The platform does not disconnect connected accounts
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-059 — The platform does not disconnect connected accounts

**Status:** Accepted (Sprint 14), 2026-09-02

---

## Context

ADR-054 decided that a venue closes rather than deletes, and that webhooks arriving after closure are processed normally. Its first Amendment (2026-09-02) recorded Stripe's written confirmation that a **disconnected** account's events never reach the platform's endpoint — which voided the guarantee behind that decision whenever an account is disconnected. Two `THREAT_MODEL.md` entries followed: reconciliation after disconnection, and the fact that disconnection is Dashboard-only and invisible to the product.

Both entries treated disconnection as something that *would happen* when a venue left. **The question nobody had asked was whether it should.**

Stripe answered it the same day, in writing, unprompted by any decision of ours. Three statements, quoted in full because each one carries a separate consequence:

> "My advice would be to not disconnect those accounts at all if you are going to continue doing business with them in the future, especially around seasonality. It is fairly uncommon for a platform to go through that access revocation explicitly and most platforms would keep the connection active."
> — Stripe (Thomas), 2026-09-02

> "In terms of what can be reset, right now it's mostly the Payout schedule but it's partly because v2 Accounts are newer... As we continue evolving the API and products related to this, we will likely add new platform-controlled settings that could be reset in the future and take you by surprise."
> — Stripe (Thomas), 2026-09-02

> "When you disconnect, you lose all access to that account's data and information. If you reconnect in the future, you would be able to see all the transactions and data again, even from before the connection."
> — Stripe (Thomas), 2026-09-02

---

## Decision

**The platform does not disconnect connected accounts.** Not when a venue closes, not for a seasonal pause, not when a restaurant leaves.

**Closing a venue and disconnecting an account are two different things, and this ADR exists partly to keep them from being merged.** Closing (ADR-054) is an operation of *our* system: `deletedAt` is set, operations stop, history stays. **The Stripe connection is not touched by it.** Nothing in `close()` calls Stripe, and nothing will be added that does.

### Why, taken from the three statements in order

**Seasonality is the ordinary case, not the edge case.** ADR-054 already recorded it: a venue that closes in November and cannot return in April loses its history and leaves. Stripe's first statement says the same from their side — keep the connection active, *especially* around seasonality — and adds that explicit revocation is *uncommon* among platforms. A design that revokes on closure would be both unusual and self-defeating for the market this product is built for.

**The reset surface will grow, and Stripe has said so themselves.** Today a disconnect-reconnect cycle resets "mostly the Payout schedule". Stripe's own forecast is that more platform-controlled settings will become resettable *"and take you by surprise"*. **A process that depends on disconnection therefore has an unbounded and externally-controlled cost:** what it destroys is not fixed at design time and is decided by a vendor's roadmap. That alone rules it out as a routine operation.

**Disconnection is a total loss of visibility, not a pause.** *"You lose all access to that account's data"* — every transaction, every dispute, every payout that account ever made through us becomes unreadable from our side. Reconnection restores it, but only if reconnection happens, and only if the owner does it. For a product whose first claim is *"you need to know where every euro goes"* (MASTERPLAN, Product Positioning), voluntarily blinding ourselves to a venue's history is a contradiction of the positioning, not a housekeeping choice.

### Boundaries

- **This decides what the platform does. It does not, and cannot, decide what the account owner does.** Disconnection is Dashboard-only, performed by the owner (ADR-054 Amendment; `THREAT_MODEL.md`). An owner may still press that button. This ADR removes *our* reason to, which was the only reason it was going to happen routinely.
- **No mechanism is built to prevent disconnection.** There is no button on our side to remove, and nothing on our side could stop the owner's. Recording a decision that has no enforcement is not a gap here: it is the whole content of the decision — a thing we choose not to do, stated so that nobody re-derives the need and builds it.
- **Offboarding, when it is designed, ends in "the connection stays".** Whatever "a venue leaves" comes to mean operationally, the last step is not a disconnection. The venue's account remains connected and idle, exactly as Stripe advises.

---

## Consequences

**The reconciliation gap after disconnection becomes theoretical.** The `THREAT_MODEL.md` entry on chargebacks after disconnection described a risk that arrives only if an account is disconnected. With disconnection excluded *by decision* — not made technically impossible — that risk arrives only if the decision is broken, by us or by an owner acting alone. The entry is reformulated accordingly and **not closed**: the mechanism is real, and a decision is not a lock.

**The platform's blindness to disconnection remains, and matters less.** With no routine disconnection, the only disconnection is an owner's unilateral one. Detecting it is still worth having eventually; it is no longer the precondition for offboarding it looked like.

**The Terms of Service now say something the platform does not do.** §4 and §11 state that we disconnect the account from the platform. That is no longer the behaviour. The Terms text lives outside this repository and is edited there; **this is recorded as a divergence between the Terms and the decision, not corrected here.** Until the Terms are amended, the document a venue agrees to describes a disconnection that will not happen — which is the safer direction of the two possible mismatches, and still a mismatch.

**ADR-054's first Amendment stands as written**, with a second added to point here. Its reasoning about what disconnection *does* was correct; what changed is that we will not be the ones doing it.
