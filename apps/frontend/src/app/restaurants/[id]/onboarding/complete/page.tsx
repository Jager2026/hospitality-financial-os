import type { JSX } from "react";
import { ConnectPayments } from "../connect-payments";

/**
 * Where Stripe sends the person when they finish — `return_url`, built by the backend as
 * `${FRONTEND_URL}/restaurants/${id}/onboarding/complete` (`restaurant.service.ts`).
 *
 * **This route existed on Stripe's side and not on ours.** Anyone who completed onboarding landed
 * on a 404 at the end of the one flow the product most needs to go well.
 *
 * It re-reads the venue rather than trusting the arrival: `return_url` means "the person came
 * back", never "the account is now verified" — Stripe may still be reviewing, and it is
 * `GET /restaurants/{id}` (which re-reads Stripe) that knows.
 */
export default async function OnboardingCompletePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  return <ConnectPayments restaurantId={id} arrival="returned" />;
}
