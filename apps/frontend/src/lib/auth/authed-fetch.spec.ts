import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRefreshStateForTests, authedGet } from "./authed-fetch";
import { STORAGE_KEY, type StoredSession } from "./session";

/**
 * The single-flight guarantee, tested where it can actually be pinned down.
 *
 * A browser test can prove the screen recovers; only this can prove it recovered with **exactly
 * one** refresh. The distinction is the whole reason the guard exists: two refreshes rotate the
 * token twice, the second presents an already-rotated one, and the backend reads that as a stolen
 * credential and revokes the family — an ordinary expiry turned into a forced global logout.
 */

const SESSION: StoredSession = {
  accessToken: "access-old",
  refreshToken: "refresh-old",
  user: { id: "u1", email: "owner@example.test", locale: "en" },
  memberships: [],
};

function storage(): Record<string, string> {
  const store: Record<string, string> = {};
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    },
  });
  return store;
}

/** Counts what was asked of the network, so an assertion can be about calls rather than outcomes. */
function transport(options: { acceptRefresh: boolean }) {
  const calls: string[] = [];
  let accessToken = "access-old";

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api\/v1/, "");
    calls.push(path);

    if (path === "/auth/refresh") {
      if (!options.acceptRefresh) {
        return response(401, { success: false, error: { code: "AUTH_INVALID", message: "" } });
      }
      accessToken = "access-new";
      return response(200, {
        success: true,
        data: {
          id: "u1",
          accessToken,
          refreshToken: "refresh-new",
          user: SESSION.user,
          memberships: [],
        },
      });
    }

    const sent = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    if (sent !== `Bearer ${accessToken}`) {
      return response(401, { success: false, error: { code: "AUTH_INVALID", message: "" } });
    }
    return response(200, { success: true, data: { path } });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, expire: () => void (accessToken = "access-rotated-away") };
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("authedGet — renewal is shared, never repeated", () => {
  beforeEach(() => {
    __resetRefreshStateForTests();
    const store = storage();
    store[STORAGE_KEY] = JSON.stringify(SESSION);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renews once and replays, so the caller sees a success rather than an error", async () => {
    const { calls, expire } = transport({ acceptRefresh: true });
    expire();

    const result = await authedGet<{ path: string }>("/dashboard?restaurantId=r1");

    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(1);
  });

  // THE ONE THIS FILE EXISTS FOR. Two concurrent requests, both holding a dead token, must produce
  // exactly ONE refresh. An implementation without the shared promise produces two — and the
  // second presents a token the first has already rotated away.
  it("makes exactly one refresh for two requests that expire together", async () => {
    const { calls, expire } = transport({ acceptRefresh: true });
    expire();

    const [a, b] = await Promise.all([
      authedGet<{ path: string }>("/dashboard?restaurantId=r1"),
      authedGet<{ path: string }>("/restaurants/r1"),
    ]);

    expect(a.ok, "the first request did not recover").toBe(true);
    expect(b.ok, "the second request did not recover").toBe(true);
    expect(
      calls.filter((c) => c === "/auth/refresh"),
      "each request refreshed on its own — the second would present a rotated-out token, which " +
        "the backend reads as a stolen credential and answers by revoking the whole family",
    ).toHaveLength(1);
  });

  it("ends the session instead of looping when the refresh itself is refused", async () => {
    const { calls, expire } = transport({ acceptRefresh: false });
    expire();

    const result = await authedGet<{ path: string }>("/dashboard?restaurantId=r1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_ENDED");
    expect(
      calls.filter((c) => c === "/auth/refresh"),
      "it retried a refusal",
    ).toHaveLength(1);
    expect(
      window.localStorage.getItem(STORAGE_KEY),
      "a session that cannot be renewed must not stay in storage",
    ).toBeNull();
  });

  it("does not spend a rotation on a 403, which renewing cannot change", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url).replace(/^.*\/api\/v1/, ""));
        return response(403, {
          success: false,
          error: { code: "PERMISSION_DENIED", message: "" },
        });
      }),
    );

    const result = await authedGet("/dashboard?restaurantId=r1");

    expect(result.ok).toBe(false);
    expect(calls.filter((c) => c === "/auth/refresh")).toHaveLength(0);
  });
});
