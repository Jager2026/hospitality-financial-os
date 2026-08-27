/**
 * The Portal's English dictionary — ADR-040.
 *
 * English only at launch, and this file exists on day one anyway. That is a decision about
 * **order, not scope**: every user-facing string goes through a lookup from the first line of
 * code, even while there is exactly one language to look up. A free literal costs a sweep of
 * every component to retrofit later, which is the same shape as a hardcoded colour — and the
 * same reason `--accent` is a token before any restaurant can change it.
 *
 * Flat, dotted keys rather than nesting: `MessageKey` below is then a plain union, so a typo is
 * a compile error and a second language cannot ship half-translated (see `index.ts`).
 */
export const en = {
  "app.name": "Hospitality Operating System",

  // Design-token specimen (development only)
  "design.title": "Design tokens",
  "design.subtitle": "Transcribed from DESIGN_SYSTEM.md v1.0.0. Every value measured.",
  "design.surfaces": "Surfaces",
  "design.ramp": "Neutral ramp",
  "design.accent": "Accent — one token, five verified values",
  "design.semantic": "Semantic state",
  "design.type": "Type",
  "design.density": "Density",
  "design.surface.portalLight": "Portal — light, default",
  "design.surface.portalDark": "Portal — dark, preference",
  "design.surface.terminal": "Terminal — pure white",
  "design.noWarning": "There is no warning colour, and that is the decision.",

  // Sample content used by the specimen — real strings, never lorem
  "dashboard.todayRevenue": "Today’s revenue",
  "dashboard.todayRevenueNote": "Before platform fee deduction",
  "dashboard.todayTips": "Tips today",
  "dashboard.topStaff": "Top staff today",
  "terminal.yourBill": "Your bill",
  "terminal.pay": "Pay",
  "state.paymentReceived": "Payment received",
  "state.cardDeclined": "Card declined",
} as const;

export type MessageKey = keyof typeof en;
