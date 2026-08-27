import type { SessionMembership } from "./destination";

/**
 * Where the session lives, and an open question that must not be lost.
 *
 * The API returns `accessToken` and `refreshToken` in the JSON body (`API_Contract.md`, Login), so
 * the browser has to put them somewhere. `localStorage` is what makes the agreed login test
 * expressible — "no token in storage after a failed attempt" — and it is what every reference in
 * the folder does.
 *
 * **It is also readable by any script that runs on the page.** An httpOnly, SameSite cookie set by
 * the backend would not be, and is the better end state; it needs a backend change (the API would
 * set a cookie rather than return a token) and therefore its own decision, not a quiet choice made
 * here while building a form. Raised explicitly rather than settled: today there are no real users
 * and no third-party scripts on any page, so the exposure is theoretical; both of those stop being
 * true before the first pilot.
 */

const STORAGE_KEY = "hos.session";

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; locale: string };
  memberships: SessionMembership[];
}

export function saveSession(session: StoredSession): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function readSession(): StoredSession | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    // A corrupted value is treated as no session rather than crashing the app on load. Clearing it
    // keeps the next load clean instead of failing the same way forever.
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function clearSession(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

export { STORAGE_KEY };
