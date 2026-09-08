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

  // Destinations after login. Create Your Restaurant is still a stub — it arrives with its own
  // slice; the Restaurants list below is built.
  "createRestaurant.title": "Create your restaurant",
  "createRestaurant.explain":
    "This is the business that takes the payments — the details below are the ones Stripe and your invoices need. It takes a couple of minutes, and everything except the country and currency can be changed later.",
  "createRestaurant.field.name": "Restaurant name",
  "createRestaurant.field.legalName": "Registered company name",
  "createRestaurant.hint.legalName":
    "As it appears in the company register, not the name on the door.",
  "createRestaurant.field.companyNumber": "Company registration number",
  "createRestaurant.field.vatNumber": "VAT number",
  "createRestaurant.field.email": "Contact email",
  "createRestaurant.hint.email": "Where Stripe writes about this restaurant’s account.",
  "createRestaurant.field.phone": "Phone",
  "createRestaurant.field.address": "Address",
  "createRestaurant.field.timezone": "Time zone",
  "createRestaurant.hint.timezone":
    "Used to decide which working day a late-night payment belongs to.",
  "createRestaurant.fixed":
    "Country: Lithuania. Currency: euro. Both are fixed when the Stripe account is created and cannot be changed afterwards — a different country or currency means a separate restaurant.",
  "createRestaurant.action.create": "Create restaurant",
  "createRestaurant.action.working": "Creating…",
  "createRestaurant.action.check": "Check what was created",
  "createRestaurant.action.checking": "Checking…",
  "createRestaurant.ambiguous.title": "Which business is this restaurant for?",
  "createRestaurant.ambiguous.explain":
    "Your account covers more than one business, and this screen cannot yet ask which one a new restaurant belongs to. Adding it to the wrong one is not something that can be undone, so it does not guess. Choosing between businesses is not built yet.",
  "createRestaurant.agreement.agree":
    "I accept the Stripe connected-account agreement on behalf of this business.",
  "createRestaurant.error.agreementRequired":
    "Please accept the Stripe agreement before creating the restaurant — the account cannot be opened without it.",
  "createRestaurant.error.agreementUnavailable":
    "We can’t load the Stripe agreement right now, so we can’t record that you accepted it. Reload the page in a moment — nothing was created.",
  "createRestaurant.error.refused":
    "The restaurant was not created. Nothing has been set up, and nothing was charged — the details above are still here, so you can correct them and try again.",
  "createRestaurant.error.rejected":
    "Some of these details were not accepted. Nothing was created. Check the registration number, VAT number and email, then try again.",
  "createRestaurant.error.notAllowed":
    "This account cannot create a restaurant for that business. Creating one needs an owner’s account.",
  "createRestaurant.error.unknownOutcome":
    "We did not get an answer, so we cannot tell whether the restaurant was created. Trying again could create a second one, which is why there is no second attempt offered here — check first.",
  "createRestaurant.error.verifiedAbsent":
    "Checked: no restaurant was created. Nothing was left behind, so it is safe to try again.",
  "restaurants.title": "Your restaurants",
  "restaurants.loading": "Loading your restaurants…",
  "restaurants.error.title": "We could not load your restaurants",
  "restaurants.error.explain":
    "The list could not be fetched. Your restaurants are unaffected — this screen simply has nothing to show yet.",
  "restaurants.flag.setupNotStarted": "Card setup not started",
  "restaurants.flag.cannotTakeCards": "Cannot take cards yet",
  "restaurants.empty.title": "Let’s add your first restaurant",
  "restaurants.empty.explain":
    "Your account is ready. A restaurant is where payments, staff and figures live, so it is the next thing to create — it takes a few minutes and you can change every detail later.",
  "restaurants.empty.action": "Add a restaurant",
  "dashboard.title": "Dashboard",
  "screen.notBuilt":
    "This screen isn’t built yet. Logging in reached it, which is what is being tested.",

  // ── The Dashboard, first real Portal screen ──────────────────────────────────────────────
  // Every caption says SHIFT rather than "today" (ADR-065): a screen that shows shift-scoped
  // figures under a calendar-day word is the exact ambiguity that ADR exists to remove.
  "dashboard.nav.restaurants": "Restaurants",
  "dashboard.nav.signOut": "Sign out",
  "dashboard.shift.openedAt": "Shift opened",
  "dashboard.shift.closedAt": "Shift closed",
  "dashboard.shift.open": "Open now",
  "dashboard.shift.businessDate": "Business day",
  "dashboard.revenue": "Shift revenue",
  // Option (b), Founder decision. The API sends "Before platform fee deduction" (ADR-026), which
  // tells an owner something will be taken and not how much — a caveat that raises a question the
  // screen cannot answer, because GET /dashboard carries no fee figure. This says what the number
  // IS rather than what it is not. Naming the amount is option (a), waiting on that field.
  "dashboard.revenueNote": "All sales taken on this shift",
  "dashboard.tips": "Tips to staff",
  "dashboard.averageBill": "Average bill",
  "dashboard.averageTip": "Average tip",
  "dashboard.transactions": "Sales",
  "dashboard.afterMidnight.title": "Of that, after midnight",
  "dashboard.afterMidnight.explain":
    "This shift was still open past midnight, so part of its money belongs to the next calendar day. That is why this total and a bank statement can disagree — both are right.",
  "dashboard.empty.title": "The shift is open. Nothing has been sold yet.",
  "dashboard.empty.explain":
    "This is what a normal morning looks like. Figures appear here as sales are taken — nothing is wrong, and nothing is being hidden.",
  "dashboard.noShift.title": "No shift has been opened here yet.",
  "dashboard.noShift.explain":
    "A shift opens with the first sale of the working day, or when someone opens it. Until then there is no working day to report on.",
  // Connect Payments (UX_MAP.md). Four states, and the two that ask for nothing say so plainly.
  "connect.loading": "Loading this restaurant’s payment setup…",
  "connect.error.title": "We could not load the payment setup",
  "connect.error.explain":
    "This restaurant’s Stripe status could not be fetched. Nothing about the restaurant has changed — this screen simply has nothing to show yet.",
  "connect.start.title": "Set up card payments",
  "connect.start.explain":
    "Stripe verifies every business that takes card payments, and hosts that step itself — we never see or store the documents. It usually takes a few minutes, and you can leave and come back.",
  // Shown only when a link has actually been minted for this venue before (Sprint 15's own
  // column). It used to be chosen by `onboardingStatus === IN_PROGRESS`, which is true of a venue
  // seconds old — so a new owner was told to resume something they had never begun. Now that the
  // two states are distinguishable, this one can say what it means again.
  //
  // "Where you left off" is deliberately absent even here: the column records that a link was
  // handed over, not that anybody opened it or typed anything.
  "connect.resume.title": "Continue setting up card payments",
  "connect.resume.explain":
    "You’ve been sent to Stripe for this restaurant before. Continuing opens it again — anything already provided is kept, and Stripe will only ask for what is still missing.",
  "connect.asks.identity": "Who you are — an identity document for the person responsible.",
  "connect.asks.business": "The business — registration and tax details for this restaurant.",
  "connect.asks.bank": "Where money goes — the bank account payouts are sent to.",
  "connect.action.start": "Continue to Stripe",
  // Not "continue where you left off": the column says a link was handed over, never that anybody
  // opened it. The test asserting the absence of that phrase caught this string after the heading
  // and body had already been corrected — three places said it, and two fixes read as done.
  "connect.action.resume": "Continue to Stripe",
  "connect.action.working": "Opening Stripe…",
  "connect.later": "I’ll do this later",
  "connect.expired.explain":
    "That setup link had expired — they are single-use and last a few minutes, and email apps sometimes open them in the background. Nothing was lost; start again below.",
  "connect.returned.explain":
    "You’re back from Stripe. What Stripe has told us so far is below — if verification is still running, this will change on its own.",
  "connect.review.title": "Stripe is reviewing this restaurant",
  "connect.review.explain":
    "Nothing is needed from you. Stripe is checking what has already been sent, which can take a little time. This screen will show the result when there is one — there is nothing to fill in meanwhile.",
  "connect.complete.title": "Card payments are set up",
  "connect.complete.explain":
    "Stripe has verified this restaurant. Cards can be taken and payouts reach your bank — there is nothing left to do here.",
  "connect.complete.action": "Go to the dashboard",
  "connect.notAllowed.explain":
    "Setting up payments is the owner’s to do. Your account can see where this restaurant stands, and the person who owns it can finish the setup.",
  "connect.refused.rateLimited":
    "Too many setup links have been requested for this restaurant in the last hour. Nothing is wrong — links expire quickly, so there is a limit on how many can be made. Wait a few minutes and try again.",
  "connect.refused.notAllowed":
    "Stripe setup could not be started for this restaurant from this account. Setting up payments needs an owner’s account, and this restaurant needs a Stripe account of its own before setup can begin.",
  "connect.refused.unavailable":
    "The setup link could not be created just now. Nothing has changed for this restaurant — try again in a moment.",
  // Transactions — UX_MAP.md. Reached from the Dashboard when a figure raised a question.
  "transactions.title": "Transactions",
  // Said plainly rather than implied. ADR-065 puts operational screens on shifts, and this list
  // cannot be one: `Transaction` carries no shift, and the endpoint offers no shift filter.
  "transactions.scope":
    "Every payment taken at this restaurant, newest first — not only the open shift. The dashboard is the screen that follows the shift.",
  "transactions.loading": "Loading transactions…",
  "transactions.filter.status": "Status",
  "transactions.filter.any": "Any status",
  "transactions.row.tip": "tip",
  "transactions.status.completed": "Completed",
  "transactions.status.partiallyRefunded": "Partly refunded",
  "transactions.status.refunded": "Refunded",
  "transactions.status.disputed": "Disputed",
  "transactions.pages.previous": "Previous",
  "transactions.pages.next": "Next",
  // Two empties, and they must not read alike: one says no money has come in, the other says this
  // question excluded whatever did.
  "transactions.empty.title": "No payments have been taken here yet.",
  "transactions.empty.explain":
    "Payments appear here as they are taken, each with what the customer paid and what was left as a tip. Nothing is wrong and nothing is hidden — there is simply nothing yet.",
  "transactions.emptyFilter.title": "No payments match this filter.",
  "transactions.emptyFilter.explain":
    "This restaurant may well have taken payments — none of them have the status you selected. Clearing the filter shows everything again.",
  "transactions.emptyFilter.action": "Clear the filter",
  "transactions.error.title": "We could not load the transactions",
  "transactions.error.explain":
    "The list could not be fetched. Nothing here is out of date — there is nothing here.",
  // A Waiter holds no permissions at all, so `reports.view` refuses them the whole list. Saying
  // "something went wrong" would send somebody looking for a fault that does not exist.
  "transactions.error.forbidden":
    "Your account cannot see this restaurant’s transactions. Payment records are available to owners and managers.",

  "transaction.error.title": "We could not show this transaction",
  "transaction.error.notFound":
    "This transaction could not be found. It may belong to a restaurant your account cannot see, or it may not exist.",
  "transaction.back": "Back to transactions",
  "transaction.line.restaurant": "The restaurant’s share",
  "transaction.line.tip": "Tip to staff",
  "transaction.line.platformFee": "Our fee",
  "transaction.line.tax": "Tax",
  "transaction.line.processingFee": "Card processing fee",
  // ADR-025: unavailable is not zero, and in a money breakdown a blank reads as zero.
  "transaction.unavailable": "Not available",
  "transaction.refunds.title": "Refunds",
  "transaction.refunds.tipReturned": "tip returned",
  "transaction.chargebacks.title": "Chargebacks",

  "dashboard.stripe.action": "Set up payments",
  "dashboard.stripe.cards.title": "Card payments are not switched on here yet",
  "dashboard.stripe.cards.explain":
    "Stripe has not finished verifying this restaurant, so no card can be taken at this venue — tips included. Completing this restaurant’s payment setup with Stripe is the one thing that changes it. Everything else on this screen works normally.",
  "dashboard.stripe.payouts.title": "Payouts are not switched on yet",
  "dashboard.stripe.payouts.explain":
    "Card payments can be taken, and the money is being held at Stripe rather than lost. It reaches your bank account once Stripe finishes verifying this restaurant’s payout details.",
  "dashboard.error.explain":
    "The figures could not be fetched. Nothing here is out of date — there is nothing here.",
  "dashboard.expired.title": "Your session has ended",
  "dashboard.expired.explain":
    "You were signed out after fifteen minutes. Nothing is wrong with the restaurant or its figures — sign in again and they will be here.",
  "dashboard.expired.action": "Sign in again",
  "dashboard.seeTransactions": "See every payment",
  "dashboard.nav.backToRestaurants": "All restaurants",
  "dashboard.error.title": "We could not load this dashboard",
  "dashboard.error.retry": "Try again",
  "dashboard.error.unreachable": "We can’t reach the server right now.",
  "dashboard.error.forbidden": "This account cannot read this restaurant’s figures.",
  "dashboard.loading": "Loading the current shift…",
  "notFound.title": "That page does not exist",
  "notFound.explain": "The link may be old, or the address may have a typo in it.",
  "notFound.home": "Go to Restaurants",
  "error.title": "Something went wrong",
  "error.explain": "The screen stopped rather than showing you a figure it could not stand behind.",
  "error.retry": "Try again",

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
