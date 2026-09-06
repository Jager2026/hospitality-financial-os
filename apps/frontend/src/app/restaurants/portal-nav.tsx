"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { JSX } from "react";
import { Wordmark } from "../../components/wordmark";
import { clearSession } from "../../lib/auth/session";
import { t } from "../../lib/i18n";

/**
 * One line of navigation, which is the whole of it.
 *
 * The Portal has exactly two destinations a signed-in person can reach today — the Restaurants
 * list and this Dashboard — so a sidebar would be furniture for rooms that do not exist. It grows
 * when there is somewhere to grow to.
 */
export function PortalNav(): JSX.Element {
  const router = useRouter();

  return (
    <nav className="border-b border-rule">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link href="/restaurants" className="flex items-center gap-3">
          <Wordmark />
          <span className="sr-only">{t("dashboard.nav.restaurants")}</span>
        </Link>
        <button
          type="button"
          onClick={() => {
            // Clearing before navigating, not after: the redirect is what the person sees, and a
            // token that outlives the click by even one render is a token the next screen could
            // still read.
            clearSession();
            router.replace("/login");
          }}
          className="text-small text-muted underline"
        >
          {t("dashboard.nav.signOut")}
        </button>
      </div>
    </nav>
  );
}
