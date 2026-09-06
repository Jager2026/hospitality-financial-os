import type { JSX, ReactNode } from "react";
import { PortalNav } from "./portal-nav";

/**
 * The Portal shell — everything under `/restaurants` is a signed-in screen.
 *
 * The layout is where the shell belongs rather than the page: `error.tsx` and `loading.tsx` beside
 * this file inherit it, so a failure or a wait is still framed by the product rather than appearing
 * as a bare sentence on a black page.
 */
export default function PortalLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="min-h-screen bg-ground text-body">
      <PortalNav />
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
