import type { JSX } from "react";
import { ConnectPayments } from "../connect-payments";

/**
 * Where Stripe sends the person when the link is no longer usable — `refresh_url`.
 *
 * **This is the expired-link case, and it is the reason it must not be silent.** An Account Link
 * lives about five minutes and is single-use (#125, measured), and a mail client that follows
 * links to scan them burns one without anyone intending to. Stripe redirects here precisely when
 * the link cannot be used, so the screen says the link expired and offers a fresh one — rather
 * than rendering the same page as if nothing had happened.
 */
export default async function OnboardingRefreshPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  return <ConnectPayments restaurantId={id} arrival="expired" />;
}
