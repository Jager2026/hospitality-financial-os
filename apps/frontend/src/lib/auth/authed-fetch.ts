import {
  apiGetAuthed,
  apiPatchAuthed,
  apiPost,
  apiPostAuthed,
  type ApiResult,
} from "../api/client";
import { clearSession, readSession, saveSession, type StoredSession } from "./session";

/**
 * Every authenticated read the Portal makes, and the one place a token is renewed.
 *
 * **Why this exists at all.** The access token lives fifteen minutes and nothing renewed it, so a
 * dashboard left open on a counter stopped working mid-shift and said only that it could not load.
 * That is how it was reported — "two states broken" — when what had happened was that the session
 * had quietly ended between one screen and the next.
 *
 * **Why the renewal is SINGLE-FLIGHT, which is the whole difficulty.** Refresh tokens rotate: each
 * use mints a new one and invalidates the old, and presenting an already-rotated token is the
 * signature of a stolen credential being replayed — so the backend revokes the entire token family
 * and signs the person out of every session they have (`token.service.ts`).
 *
 * The Dashboard issues **two** requests at once by design (ADR-063). On expiry both would fail,
 * both would refresh, and the second would present the token the first had just rotated away.
 *
 * > A naive implementation does not merely duplicate a call. **It converts an ordinary expiry into
 * > a forced global logout**, and it does so more reliably the more the screen fetches in parallel.
 *
 * So concurrent callers share one in-flight refresh. The promise is the lock; there is nothing to
 * remember to hold.
 *
 * **The terminal case is not silent either.** If the refresh itself fails — an expired or revoked
 * refresh token — the session is cleared and the caller is told the session ended, which is a
 * different fact from "the server said no" and is worded differently on screen.
 */

/** The refresh endpoint answers with the same shape as login, so the whole session is replaced. */
type RefreshResponse = StoredSession & { id: string };

/**
 * The shared in-flight refresh. Module-level on purpose: the point is that two DIFFERENT callers,
 * in different components, converge on one request. A per-hook or per-component guard would look
 * identical on any screen that fetches once and fail on the screen that does not.
 */
let inFlightRefresh: Promise<StoredSession | null> | null = null;

/** Test seam. Nothing in the app calls this; the specs use it so one case cannot leak into another. */
export function __resetRefreshStateForTests(): void {
  inFlightRefresh = null;
}

async function refreshOnce(): Promise<StoredSession | null> {
  inFlightRefresh ??= (async (): Promise<StoredSession | null> => {
    try {
      const current = readSession();
      if (current === null) return null;

      const result = await apiPost<RefreshResponse>("/auth/refresh", {
        refreshToken: current.refreshToken,
      });
      if (!result.ok) return null;

      // The response carries fresh memberships as well as fresh tokens, so the whole session is
      // replaced rather than patched. A Membership disabled since login stops being on the client
      // at the first renewal instead of surviving until the next sign-in.
      const next: StoredSession = {
        accessToken: result.data.accessToken,
        refreshToken: result.data.refreshToken,
        user: result.data.user,
        memberships: result.data.memberships,
      };
      saveSession(next);
      return next;
    } finally {
      // Cleared here rather than after the awaiters resolve: everyone already holding this promise
      // still receives its value, and the next expiry — minutes away — starts a fresh flight.
      inFlightRefresh = null;
    }
  })();

  return await inFlightRefresh;
}

/**
 * A GET that carries the session, renews it once if the server says it has expired, and replays.
 *
 * The token is read at call time rather than passed in, and that is load-bearing: a component that
 * captured the token when it mounted would keep sending the old one after a renewal, and every
 * request after the first expiry would refresh again.
 */
export async function authedGet<T>(path: string): Promise<ApiResult<T>> {
  const session = readSession();
  if (session === null) {
    return { ok: false, error: { code: "SESSION_MISSING", message: "", status: 0 } };
  }

  const first = await apiGetAuthed<T>(path, session.accessToken);
  // Only 401 means "this token is no longer good". A 403 is an authorization decision about a
  // valid session and renewing would change nothing — it would just spend a rotation.
  if (first.ok || first.error.status !== 401) return first;

  const renewed = await refreshOnce();
  if (renewed === null) {
    clearSession();
    return { ok: false, error: { code: "SESSION_ENDED", message: "", status: 401 } };
  }

  const second = await apiGetAuthed<T>(path, renewed.accessToken);
  if (!second.ok && second.error.status === 401) {
    // A fresh token refused immediately. Retrying again is the infinite loop this guards against:
    // the renewal worked and the answer is still no, so the session is over.
    clearSession();
    return { ok: false, error: { code: "SESSION_ENDED", message: "", status: 401 } };
  }
  return second;
}

/**
 * A POST that carries the session, with the same single renewal and replay as `authedGet`.
 *
 * **The replay is what needs care here, and it is safe for exactly one reason: the only caller
 * asks for a Stripe onboarding link, and asking twice mints two links rather than charging
 * anything twice.** That is not a general property of POST. A request that moves money, or that
 * creates something the caller counts, must not be replayed blindly on a 401 — it needs an
 * idempotency key, or a caller that decides for itself. When the second such caller arrives, that
 * decision belongs to it, not to this function.
 */
export async function authedPost<T>(path: string, body: unknown = {}): Promise<ApiResult<T>> {
  const session = readSession();
  if (session === null) {
    return { ok: false, error: { code: "SESSION_MISSING", message: "", status: 0 } };
  }

  const first = await apiPostAuthed<T>(path, session.accessToken, body);
  if (first.ok || first.error.status !== 401) return first;

  const renewed = await refreshOnce();
  if (renewed === null) {
    clearSession();
    return { ok: false, error: { code: "SESSION_ENDED", message: "", status: 401 } };
  }

  const second = await apiPostAuthed<T>(path, renewed.accessToken, body);
  if (!second.ok && second.error.status === 401) {
    clearSession();
    return { ok: false, error: { code: "SESSION_ENDED", message: "", status: 401 } };
  }
  return second;
}

/**
 * A PATCH that carries the session, with the same single renewal and replay as `authedGet`.
 *
 * **The replay question `authedPost` raises is answered differently here, and in this direction it
 * is easier rather than harder.** A PATCH of venue settings sends the fields the person edited and
 * sets them to the values they typed, so applying it twice leaves the row exactly as applying it
 * once did. That is idempotent by the shape of the request rather than by a key — and it is a
 * property of *this* endpoint, not of the verb. A future PATCH that increments something, or that
 * appends, would need its caller to decide for itself, exactly as `authedPost`'s comment says.
 */
export async function authedPatch<T>(path: string, body: unknown = {}): Promise<ApiResult<T>> {
  const session = readSession();
  if (session === null) {
    return { ok: false, error: { code: "SESSION_MISSING", message: "", status: 0 } };
  }

  const first = await apiPatchAuthed<T>(path, session.accessToken, body);
  if (first.ok || first.error.status !== 401) return first;

  const renewed = await refreshOnce();
  if (renewed === null) {
    clearSession();
    return { ok: false, error: { code: "SESSION_ENDED", message: "", status: 401 } };
  }

  const second = await apiPatchAuthed<T>(path, renewed.accessToken, body);
  if (!second.ok && second.error.status === 401) {
    clearSession();
    return { ok: false, error: { code: "SESSION_ENDED", message: "", status: 401 } };
  }
  return second;
}
