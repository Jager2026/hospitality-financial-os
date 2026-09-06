"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type JSX, type ReactNode } from "react";
import { readSession, type StoredSession } from "./session";

/**
 * The gate on every authenticated screen: no session, no render, and a redirect to Log In.
 *
 * **Why this is not `middleware.ts`, which is the file anyone would look for first.**
 * Next.js middleware runs on the server, before the page is sent, and can read only what the
 * browser puts on the request — cookies and headers. **This application's session lives in
 * `localStorage`** (`session.ts`), which the server never sees. A middleware written against it
 * would compile, run on every request, find nothing every time, and either redirect everybody or
 * nobody. It would be a guard that cannot observe the thing it guards.
 *
 * So the guard is where the session actually is. **The redirect is real either way** — that is
 * what the end-to-end test asserts, and removing this component makes it fail.
 *
 * **What this costs, stated rather than left to be discovered:** the check happens in the browser,
 * so a person with the developer tools open can reach the markup of a screen without a session.
 * That is not a data leak — every figure on it comes from an API call that the backend refuses
 * without a valid token, which is where authorization actually lives (`JwtAuthGuard`). What is
 * protected here is the *journey*, not the data.
 *
 * **What would make a middleware possible: moving the session into a cookie.** That is already a
 * recorded decision with a trigger (`IMPLEMENTATION_PLAN.md` — session tokens move to an httpOnly
 * cookie before the first pilot restaurant), and it needs a backend change, so it is not something
 * to decide while building a screen. When it lands, this component becomes the second lock rather
 * than the only one.
 */
export function RequireSession({
  children,
}: {
  children: (session: StoredSession) => ReactNode;
}): JSX.Element | null {
  const router = useRouter();
  const [session, setSession] = useState<StoredSession | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const current = readSession();
    if (current === null) {
      router.replace("/login");
      return;
    }
    setSession(current);
    setChecked(true);
  }, [router]);

  // Nothing is rendered until the answer is known. Rendering the screen first and redirecting
  // afterwards would put a Dashboard on the display of somebody who is not logged in, however
  // briefly — and "briefly" is a screenshot.
  if (!checked || session === null) return null;

  return <>{children(session)}</>;
}
