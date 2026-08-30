import { Controller, Get } from "@nestjs/common";
import {
  CURRENT_PLATFORM_TERMS_VERSION,
  CURRENT_STRIPE_AGREEMENT_VERSION,
} from "../common/agreements/agreement-versions";

export interface CurrentAgreements {
  platformTerms: { version: string };
  stripeConnectedAccount: { version: string };
}

/**
 * The current revision of each agreement, served to whatever screen is about to ask someone to
 * accept one (ADR-049).
 *
 * **Why an endpoint instead of a constant compiled into the frontend.** The alternative is a second
 * copy of these strings in the Portal's own source, and this project has already paid twice for a
 * hand-copied duplicate of server-side truth (`test/global-setup.ts`'s permission matrix; the
 * fixture Role literals). Here the drift would be worse than usual in one specific way: the client
 * would be asserting *what a person was shown*, from a build that may predate the revision. With
 * the version fetched, the value submitted is the value this page actually rendered with, which is
 * what makes the mismatch rejection (`TERMS_VERSION_MISMATCH`, 409) mean something — the terms
 * changed while the tab was open — instead of meaning "the frontend was deployed late".
 *
 * Public and unauthenticated by design: a person has to be able to read the terms *before* they
 * have an account, and both values are constants with no personal data and nothing to enumerate.
 *
 * Both agreements are returned together, not one per route. The Stripe consent is collected at
 * restaurant creation by a different screen, and giving it a second endpoint would be two places
 * to keep in step for no gain.
 *
 * The honest limit, recorded rather than glossed: this endpoint states which revision is current,
 * not what it says. The text lives in a document served elsewhere, so "the version you were shown"
 * is only as accurate as that link. Today both are the placeholder and no document exists at all —
 * see `agreement-versions.ts` for the gate that keeps this off a real restaurant's screen.
 */
@Controller("agreements")
export class AgreementsController {
  @Get("current")
  current(): CurrentAgreements {
    return {
      platformTerms: { version: CURRENT_PLATFORM_TERMS_VERSION },
      stripeConnectedAccount: { version: CURRENT_STRIPE_AGREEMENT_VERSION },
    };
  }
}
