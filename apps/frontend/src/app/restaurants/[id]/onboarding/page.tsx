import type { JSX } from "react";
import { ConnectPayments } from "./connect-payments";

/**
 * Connect Payments (`UX_MAP.md`) — reached from the Dashboard banner, which until now named an
 * action the Portal could not perform: the backend has minted Stripe onboarding links since
 * Sprint 3 and no screen had ever called that route.
 */
export default async function ConnectPaymentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  return <ConnectPayments restaurantId={id} arrival="direct" />;
}
