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

/** Reads a public resource. No credentials — the two callers so far (the terms version a person
 * must be able to see before they have an account) precede any session. */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  return await send<T>(path, { method: "GET" });
}

async function send<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api/v1${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
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
