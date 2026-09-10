/**
 * The one place the browser talks to the API.
 *
 * Unwraps the envelope `API_Contract.md` defines — `{ success, data, meta }` on success,
 * `{ success, error: { code, message } }` on failure — so no screen has to know the shape, and a
 * failure arrives as a typed value rather than a thrown string.
 */

export interface ApiError {
  code: string;
  message: string;
  status: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return await send<T>(path, { method: "POST", body: JSON.stringify(body) });
}

/** Reads a public resource. No credentials — its callers (the terms version a person must be able
 * to see before they have an account) precede any session. */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  return await send<T>(path, { method: "GET" });
}

/**
 * Reads a resource that requires a session.
 *
 * **Separate from `apiGet` deliberately, rather than an optional flag on it.** Whether a request
 * carries credentials is the difference between a public document and a person is money, and a
 * boolean argument makes that difference easy to get wrong by omission — the failure would be a
 * screen silently reading nothing, or a token attached to a route that should never see one.
 * Two names cannot be confused by forgetting an argument.
 *
 * Returns `SESSION_MISSING` rather than sending an unauthenticated request. A 401 from the server
 * and "we never had a token" are different facts, and a screen that cannot tell them apart cannot
 * word them differently.
 */
export async function apiPostAuthed<T>(
  path: string,
  accessToken: string | null,
  body: unknown,
): Promise<ApiResult<T>> {
  if (accessToken === null || accessToken === "") {
    return { ok: false, error: { code: "SESSION_MISSING", message: "", status: 0 } };
  }
  return await send<T>(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
}

export async function apiPatchAuthed<T>(
  path: string,
  accessToken: string | null,
  body: unknown,
): Promise<ApiResult<T>> {
  if (accessToken === null || accessToken === "") {
    return { ok: false, error: { code: "SESSION_MISSING", message: "", status: 0 } };
  }
  return await send<T>(path, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
}

export async function apiGetAuthed<T>(
  path: string,
  accessToken: string | null,
): Promise<ApiResult<T>> {
  if (accessToken === null || accessToken === "") {
    return { ok: false, error: { code: "SESSION_MISSING", message: "", status: 0 } };
  }
  return await send<T>(path, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function send<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api/v1${path}`, {
      ...init,
      // init.headers last: a caller-supplied Authorization must survive, and spreading it after
      // the default is what makes that true rather than hoped for.
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  } catch {
    // The network itself failed — no response to read a code from. Distinguished from an API
    // rejection because the two need different wording: one is "we could not reach us", the other
    // is "we heard you and said no" (DESIGN_SYSTEM.md, The Mirror Risk).
    return { ok: false, error: { code: "NETWORK_UNAVAILABLE", message: "", status: 0 } };
  }

  const payload = (await response.json().catch(() => null)) as {
    success: boolean;
    data?: T;
    error?: { code: string; message: string };
  } | null;

  if (!response.ok || !payload?.success) {
    return {
      ok: false,
      error: {
        code: payload?.error?.code ?? "UNKNOWN",
        message: payload?.error?.message ?? "",
        status: response.status,
      },
    };
  }
  return { ok: true, data: payload.data as T };
}
