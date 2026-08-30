import { apiGet, type ApiResult } from "./client";

/** Mirrors `GET /agreements/current` (API_Contract.md, AGREEMENTS). Declared here rather than
 * imported from the backend: the Portal is a separate build with its own `rootDir`, and this is
 * the ordinary client/server boundary duplication — the same reason `StoredSession` is declared in
 * `auth/session.ts` rather than pulled from `AuthResult`. */
export interface CurrentAgreements {
  platformTerms: { version: string };
  stripeConnectedAccount: { version: string };
}

/**
 * The revision of the platform terms this page is about to show someone (ADR-049).
 *
 * Fetched rather than compiled in. A constant in this bundle would be a second copy of server-side
 * truth, and would let a build that predates a revision assert what a person was shown — which is
 * precisely the claim the acceptance record makes. Fetching it also gives the server's
 * `TERMS_VERSION_MISMATCH` rejection a real meaning: the terms changed while this tab was open.
 */
export async function fetchCurrentAgreements(): Promise<ApiResult<CurrentAgreements>> {
  return await apiGet<CurrentAgreements>("/agreements/current");
}
