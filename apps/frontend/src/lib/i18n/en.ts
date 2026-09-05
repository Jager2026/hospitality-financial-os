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
  "design.subtitle":
    "Transcribed from DESIGN_SYSTEM.md. Every value measured, against every surface it can land on.",
  "design.surfaces": "Surfaces",
  "design.ramp": "Neutral ramp — the terminal's material only",
  "design.accent": "Accent — one value, and one ink that may sit on it",
  "design.semantic": "Semantic state",
  "design.type": "Type",
  "design.density": "Density",
  "design.surface.portal": "Portal — the only Portal surface",
  "design.surface.terminal": "Terminal — pure white",
  "design.text": "Text — three levels, on every surface",
  "design.ladder": "The Portal ladder",
  "design.onAccentRule":
    "Text on an accent fill is the ink and nothing else. The light text measures 1.08 on the yellow — not low contrast, invisible.",
  "design.brandingPalette":
    "The five-value branding palette (accent-palette.ts) is a separate, unshipped feature. It assumes two Portal appearances and defaults to the abolished amber, so it governs nothing here and is not rendered.",
  "design.terminalBoundary":
    "The accent fill measures 1.28 against this ground. The button's own text is fine; its BOUNDARY is not, and WCAG asks 3:1 for a control edge.",
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
  "login.noAccount": "Don’t have an account?",
  "login.createAccount": "Create one",

  // Register — UX_MAP.md, "Getting In"; the agreement block is ADR-049
  "register.email": "Email",
  "register.displayName": "Your name",
  "register.displayNameHint": "Colleagues see this when choosing who served a table.",
  "register.password": "Password",
  "register.passwordHint": "At least 8 characters.",
  "register.submit": "Create account",
  "register.submitting": "Creating your account…",
  "register.haveAccount": "Already have an account?",
  "register.logIn": "Log in",

  // The checkbox covers the Terms only. The Privacy Policy is linked and explained, never ticked:
  // our basis for processing is the contract with the person, not consent (ADR-049), and a
  // checkbox there would promise a withdrawal right that does not exist. The notice says why, so
  // the absence reads as deliberate. Links sit outside the checkbox label on purpose — a link
  // inside a label toggles the checkbox when clicked.
  "register.terms.agree": "I agree to the Terms of Service.",
  "register.terms.link": "Read the Terms of Service",
  "register.privacy.notice":
    "We explain what we collect and why in our Privacy Policy. It describes what we do — there’s nothing to tick.",
  "register.privacy.link": "Read the Privacy Policy",

  "register.error.termsRequired":
    "Please agree to the Terms of Service before creating an account.",
  "register.error.termsChanged":
    "The Terms of Service changed while this page was open. Reload the page and read them again before continuing.",
  // Fails closed, and says so. Without a version there is no honest record of what was agreed to,
  // so the account is not created rather than created with a blank.
  "register.error.termsUnavailable":
    "We can’t load the Terms of Service right now, so we can’t record that you agreed to them. Reload the page in a moment.",
  // Deliberately vague, and this is the one place the screen says less than it knows: confirming
  // that an address already has an account turns this form into an enumeration tool.
  "register.error.rejected":
    "We can’t create an account with these details. If you already have one, log in instead.",
  // ADR-055. Without its own string this arrives as "check the details above", which is false:
  // nothing about the details is wrong, and the person cannot fix it by editing the form.
  "register.error.unavailable":
    "Sign-ups aren’t open yet — our terms of service haven’t been published. Nothing was created.",
  "register.error.invalid": "Check the details above and try again.",
  "register.error.tooManyAttempts": "Too many attempts. Wait a minute and try again.",
  "register.error.unreachable": "We can’t reach the server right now. Nothing was sent.",

  // ADR-032. Four lines because this rejection is the one people misread, and each line answers a
  // different question: what to do, why, what it does NOT mean, and what "different" means here.
  // The third line exists because the common reading is "someone broke into my account" — the
  // finding is about the password, not about this person. The mechanism behind it is never named
  // on screen; it is an implementation detail, and naming it invites the same misreading in a new
  // form.
  "register.error.breached.title": "Choose a different password",
  "register.error.breached.explain":
    "This password has appeared in a known data breach and may be easier for attackers to guess.",
  "register.error.breached.notYou":
    "This is about the password itself — it has been seen in lists collected from other services.",
  "register.error.breached.action": "Please choose a unique password you haven’t used elsewhere.",

  // Close A Venue — UX_MAP.md; ADR-054. The screen itself is not built yet (the restaurant
  // management screens are stubs), and these strings are here so the wording is settled before
  // someone writes it in a hurry next to a destructive button. Never "delete": restaurants close,
  // and their accounting is kept. Never "permanently" either — reopen is planned, and copy that
  // forecloses it would have to be rewritten the moment it ships.
  "closeVenue.title": "Close this venue",
  "closeVenue.whatHappens":
    "The venue stops trading through PlainTabs. It disappears from your venues, stops taking payments, and nobody can be invited to it.",
  "closeVenue.historyKept":
    "Its payments, transactions and reports stay exactly as they are. Closing a venue never changes what it earned.",
  // The one thing a person could otherwise get wrong about their own money. Factual, no legal
  // characterisation — and it must stay word-for-word aligned with the Terms of Service, which
  // says the same thing in its own voice.
  "closeVenue.stripe":
    "Your Stripe account stays yours. We stop sending payments through it, and it remains open — closing it is something only you can do, by contacting Stripe directly.",
  "closeVenue.confirm": "Close venue",
  "closeVenue.cancel": "Keep it open",

  // Terms and Privacy — real routes so the links on Register are not dead. Neither document is
  // written; the pages say so plainly rather than showing a plausible-looking placeholder
  // (IMPLEMENTATION_PLAN.md, Blocking Gate Before The First Pilot Restaurant).
  "terms.title": "Terms of Service",
  "privacy.title": "Privacy Policy",
  "agreement.unpublished":
    "This document hasn’t been written yet. Until it exists, no real restaurant should be signing up — and any acceptance recorded before then would be a record of agreement to nothing.",

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
