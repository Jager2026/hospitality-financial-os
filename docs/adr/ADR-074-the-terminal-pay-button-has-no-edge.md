---
title: ADR-074 — The terminal's pay button has no edge, and three ways to give it one
version: 1.0.0
status: Proposed
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-074 — The terminal's pay button has no edge, and three ways to give it one

**Status:** Proposed (Sprint 15), 2026-09-04. **Options measured, none chosen.** No token is changed by this ADR.

---

## The measurement

ADR-072 fixed one accent for the whole product: `#FFE500`. On the Portal it is unambiguous. On the guest terminal, whose ground is `#FFFFFF`:

| | Measured | Required |
|---|---|---|
| The button's own text (`#161615` on the fill) | **14.19** | 4.5 — passes with room |
| **The button's edge (fill against the page)** | **1.28** | **3.0** (WCAG 1.4.11, non-text contrast) — **fails** |

**The text on the button is excellent and the button is not there.** A yellow rectangle on a white page has almost no boundary, and the failure is not aesthetic: this is the one screen where a stranger has about ten seconds, no reason to try again, and no second impression. **A button a guest does not find is a payment that does not happen** — which makes this the only contrast failure in the system that costs money directly.

It is a consequence of ADR-072 rather than a pre-existing defect: the abolished amber `#9A5D14` measured 5.32 as text on white and had a perfectly serviceable edge. Nothing was broken by carelessness; one accent for two grounds is simply a stronger constraint than two accents for two grounds.

---

## What the terminal actually is — established, because option 3 depends on it

Two facts from the existing documents, read rather than assumed:

- **It is the venue's own tablet, not the guest's phone.** `MASTERPLAN.md`: *"a tablet carrying a visually foreign interface is a foreign object"*. `DESIGN_SYSTEM.md`: *"on a device they have never seen and will never see again."*
- **Its white was decided twice, not inherited.** Part 1 carries two separate sections for it — *The reason that decides it: on the terminal, the user is not ours*, and *The ergonomic reason, which is not a small one either* — and ADR-072 re-affirmed it explicitly when the Portal went dark.

**This matters for how option 3 is framed, and it should be stated plainly rather than softened: the white terminal is not an inheritance nobody re-examined.** It is a decision with written reasoning, made on the guest's behalf rather than on the house style's, and re-confirmed four days ago. Option 3 is still worth putting on the table — but as a **reversal of a reasoned decision**, which is a different act from correcting an oversight, and it should be taken knowing that.

The device fact cuts the same way. A guest's own phone auto-adjusts brightness and carries their own preferences; **a venue tablet on a July terrace does neither, and the person reading it cannot change it.** That is the strongest form of the original argument, and option 3 has to outweigh it.

---

## The three options, measured

### 1 — A dark edge on the yellow button

Keep the fill; give it a `#161615` border.

| | Measured |
|---|---|
| Border against the white page | **18.11** |
| Border against the yellow fill | **14.19** |

**Passes on both sides, which is what 1.4.11 actually asks for** — a boundary must be distinguishable from what is on either side of it, and a border is the only one of the three options that satisfies it *as a boundary* rather than by replacing the thing that lacked one.

**Cost:** a new token. The system has `--rule` for dividers at ~1.6, which is deliberately invisible; a control edge is a different job at a different ratio, so this is a genuine addition to the token layer rather than a reuse. **Smallest change, and the only one that leaves both the accent and the terminal exactly as decided.**

### 2 — A dark fill with yellow text

Invert the button: `#161615` fill, `#FFE500` text.

| | Measured |
|---|---|
| Fill against the white page | **18.11** |
| Yellow text on the fill | **14.19** |

**Also passes, and needs no new token.** The strongest edge of the three by a wide margin, and it makes the primary action unmistakable on a light page.

**Its cost is conceptual and worth weighing rather than dismissing:** the accent stops being the fill and becomes the text. `DESIGN_SYSTEM.md` Part 1 says accent marks *actions*, and it still would — but every reference this project examined uses accent-as-fill for the primary action, and a dark button with yellow lettering reads as a different visual idiom than the Portal's. **One product, two visual systems** already permits that; this would be the first time the two diverge on a *control*, not just on a surface.

### 3 — The terminal goes dark too

One system everywhere: ground `#161615`, yellow fill, ink text.

| | Measured |
|---|---|
| Fill against the ground | **14.19** |
| Text on the fill | **14.19** |
| Body text on the ground | **15.34** |

**Every number passes, and it is the only option that removes the problem rather than treating it** — the edge failure exists solely because one accent has to work on two very different grounds. It also collapses the last surface difference in the product: one palette, one ladder, one specimen page, nothing to keep in sync.

**What it costs is the argument in the section above**, and it is not small: the sunlight case, on a venue-owned tablet the reader cannot adjust, in a market where terrace trade is a substantial share of summer revenue. That reasoning is written down twice and was re-affirmed once. **Choosing this means overturning it deliberately — which is entirely the Founder's to do, and is the reason it is listed rather than dismissed.**

If it is chosen, the honest form is to record *why the original reasoning no longer holds*, not to quietly delete it — the same treatment ADR-072 gave the light Portal's justification.

---

## The second measurement, which is smaller and has no urgency

`--text-muted` on the terminal clears the floor on `--surface` at **4.63** — by **0.13**. On the next step down (`#ECEBE7`) it measures **4.31 and fails**.

Nothing is wrong today: the terminal has exactly two surfaces, and ADR-072 pinned `--surface-2` and `--surface-3` to `--surface` precisely so the question cannot arise by accident. **This is a note for whoever adds a third terminal surface: `#726D64` has to become `#5C5852` in the same change.** Recorded here because that is where someone will be looking, and because a 0.13 margin is the kind of thing that passes review by looking fine.

Option 3 dissolves this one too — a dark terminal inherits the Portal's ladder, which was measured against its own deepest surface from the start.

---

## Not decided here

Which option. The measurements are all that this ADR contributes, and they are enough to make the choice a decision about the product rather than about contrast.

**No terminal screen exists yet**, so nothing is broken in production and there is no deadline. But the choice should be made **before** the first terminal screen is drawn rather than after: options 2 and 3 change what that screen looks like, and retrofitting a surface decision into a built screen is how a design system acquires an exception.
