---
title: ADR-072 — The Portal is dark, and the floor is measured from the deepest surface
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-072 — The Portal is dark, and the floor is measured from the deepest surface

**Status:** Accepted (Sprint 15), 2026-09-04. One axis: tokens. No screen was repainted — screens read tokens and repaint themselves.

---

## Context

`DESIGN_SYSTEM.md` decided a light Portal with dark as a supported preference, and an amber accent whose default was `#9A5D14`. The Founder replaced the palette outright: **the Portal is dark, the amber is abolished, and there is no light variant.** The only light surfaces that remain are the guest terminal and, when they exist, print and export.

This is a decision about the product's appearance, which is the Founder's. What follows is what it costs, what it forces, and what it must not be allowed to quietly break.

---

## Decision

### 1. One Portal appearance, and the mechanisms for a second are removed

`#161615` ground, with a four-step ladder deepening as things stack: `#1E1E1C`, `#262624`, `#30302D`.

The `@media (prefers-color-scheme: dark)` block, `[data-theme="light"]` and `[data-theme="dark"]` are **gone, not left inert**. They existed to carry a second Portal appearance; there is no second appearance to carry, and a toggle that switches between one thing and itself is a mechanism with nothing on the other side of it. Their absence is asserted, so a future edit cannot reintroduce a half-working theme switch without failing a test.

### 2. The contrast floor is measured from the DEEPEST surface, not the ground

**This is the part that is a rule rather than a palette.**

A text colour is now checked against every surface it can land on, which means the binding measurement is against `#30302D`. Measuring against the ground certifies a value that fails on the very card it is most likely to be used in: a muted grey that reads perfectly on the page background can be unreadable inside a raised panel, and the old spec would have passed it.

| Token | Value | On ground | On `#30302D` |
|---|---|---|---|
| `--text` | `#EFECE4` | 15.34 | 11.21 |
| `--text-muted` | `#BDBAB1` | 9.33 | 6.82 |
| `--text-faint` | `#9E9B94` | 6.53 | **4.77** |

**Verified by execution, as the acceptance condition required:** substituting `#8A8781` — which measures 5.06 on the ground and 3.70 on `#30302D` — fails the suite. It failed at `#262624` first, which is stronger than asked for: the check is "every surface", not "the deepest one".

### 3. Text on an accent fill is the ink, and nothing else

`#EFECE4` on `#FFE500` measures **1.08**. That is not low contrast; it is not there.

**Enforced by ratio, not by equality**, and that distinction is the design: an equality check catches only the one wrong value someone happens to think of, while the ratio catches every wrong value there is. Setting `--on-accent` to the light text fails the suite — verified by doing it.

The 1.08 is itself asserted, because someone will eventually propose light text on the yellow for looking calmer, and a measured number ends that conversation without an argument.

### 4. There is no fourth text level, and there will not be

`--text-faint` clears the floor by **0.27**. A fourth level would have to fit between 4.77 and 4.5 — differing from `--text-faint` by less than a third of a ratio point. **One token with a typo, not two roles.**

The headroom is asserted rather than described, which makes it a live guard: if the deepest surface were ever lightened, the headroom would grow, the assertion would fail, and this decision would have to be re-read instead of quietly reversed.

### 5. The ladder is asserted to actually deepen

*"The floor is measured from the deepest surface"* is only true while the ladder is ordered. Reordering the values would leave every ratio assertion passing while measuring the wrong pair, so the ordering itself is a test.

### 6. What survives the palette change, and why that is the interesting part

Four rules were carried across unchanged, and they are the ones about **money and hierarchy rather than taste**:

- **The accent never carries importance and never touches a money figure.**
- **Elevation carries layering, never importance** — a shadow means something is genuinely above something else.
- **The Hierarchy Law is arithmetic**: hero ≥ 3× body, nothing else above 0.625× the hero. A review fails on a number, not an opinion.
- **There is no warning colour.** The two places it gets reached for are the two places Part 1 forbids alarming.

A palette change is exactly the event that tells you which rules were ever about colour. These four were not, and the last is the sharpest test: the reason for having no warning token was partly that it would collide with an amber accent. **The amber is gone and the rule stands**, because the real reason was always the platform-fee caption and the empty dashboard.

---

## The terminal stays white

Confirmed by the Founder against the literal reading of *"the only light thing is print and export"*. The terminal's surface was chosen on **legibility** — a screen read on a terrace in July — not on house style, and that reason did not change when the Portal did.

Two measured consequences follow, and both are recorded rather than solved:

**The pay button's boundary.** `#FFE500` measures **1.28** against the terminal's white ground. Its own text is fine at 14.19; its edge against the page is not, and WCAG asks 3:1 for a control's boundary. No terminal screen exists yet, and inventing a border token for a button nobody has drawn is how a token layer starts being authored by an imaginary screen. **It needs an answer before the first terminal screen ships.**

**The terminal has no deeper surfaces**, deliberately — one amount, one action, nothing stacked three levels down — and `--surface-2`/`--surface-3` are pinned to `--surface` so nothing inside a terminal can inherit a Portal-dark value. This is also what keeps it inside the new floor rule: `--text-muted` clears 4.5 on `#F4F3F0` by **0.13**, and on the next step down measures **4.31 and fails**. **A third terminal surface requires moving `#726D64` to `#5C5852` in the same change.**

---

## Print and export are not defined

The Founder's decision names them as the only other light surfaces. **No tokens were created for them**, by decision: nothing prints, and a token set with no consumer is what later drifts from the reality it claims to describe. It arrives with the first such screen.

---

## Consequences

**The neutral ramp is trimmed from thirteen steps to six.** The other seven existed to serve the light Portal. A ramp step nobody points at is a value with no measurement behind it.

**`accent-palette.ts` no longer describes the Portal's accent.** Five verified values with a light/dark pair each, defaulting to the abolished amber — its whole shape assumes two Portal appearances. It is left in place (the branding feature has not shipped, and this change's axis was tokens) but it governs nothing today. **The disconnection is asserted by a test** so nobody reads it as if it still did. Whether that feature survives at all is a separate decision.

**`/design` is visibly broken in three ways**, reported rather than fixed because screens were out of scope:

1. **The two Portal specimens are now byte-identical** — both render `#161615`/`#EFECE4`, one still labelled *"Portal — light, default"*. The page sets `data-theme` attributes that no longer match any rule, so it silently shows one surface twice.
2. **Seven ramp swatches render empty** — it lists all thirteen steps and only six exist.
3. **The accent section still shows the five branding values**, amber first, as though they described the Portal.

The page did not crash and the tokens themselves apply correctly, confirmed by reading the computed values in a real browser rather than from the CSS.

**One literal colour exists in the codebase** and is now on a dark ground: `text-gray-500` on the Sprint 1 placeholder home page. It is a Tailwind palette value rather than a token, so it did not follow the surface, and its contrast is unmeasured. Reported, not fixed.

**Three new tokens have no Tailwind class.** `--surface-2`, `--surface-3` and `--text-faint` exist in CSS but are not in `tailwind.config.ts`, which is outside this change's stated boundary. Screens can reach them through `var()` but not through a utility class until three lines are added there.
