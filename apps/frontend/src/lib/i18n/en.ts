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
  // The product NAME is not here on purpose: a brand name is not translated (ADR-040,
  // DESIGN_SYSTEM.md Product Identity). It lives as PRODUCT_NAME in components/wordmark.tsx.
  "app.tagline": "Financial infrastructure for restaurants, cafés, and bars.",

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

  // Log In — UX_MAP.md, "Getting In"
  "login.email": "Email",
  "login.password": "Password",
  "login.submit": "Log in",
  "login.submitting": "Logging in…",
  // "Invalid email or password" deliberately does not say which was wrong: telling an attacker
  // that an email exists turns a password guess into an account-enumeration tool. The API already
  // answers both cases identically (AUTH_INVALID); this wording matches rather than widening it.
  "login.error.invalid": "That email and password don’t match an account.",
  // ADR-028 rate limiting. UX_MAP.md: say so plainly rather than showing a generic failure that
  // reads like a wrong password — a person who is told "wrong password" ten times will change a
  // password that was never wrong.
  "login.error.tooManyAttempts":
    "Too many attempts. Wait a minute and try again — your password hasn’t changed.",
  "login.error.unreachable": "We can’t reach the server right now. Nothing was sent.",

  // Destinations after login — stubs for now, real screens arrive with their own work
  "createRestaurant.title": "Create your restaurant",
  "restaurants.title": "Your restaurants",
  "dashboard.title": "Dashboard",
  "screen.notBuilt":
    "This screen isn’t built yet. Logging in reached it, which is what is being tested.",

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
