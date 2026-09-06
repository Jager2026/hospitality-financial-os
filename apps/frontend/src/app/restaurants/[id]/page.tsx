import type { JSX } from "react";
import { DashboardView } from "./dashboard-view";

/**
 * One Restaurant's Dashboard — where a restaurant-scoped Membership lands after login
 * (`UX_MAP.md`, `destination.ts`).
 *
 * **The screen lives at `/restaurants/:id` rather than at `/dashboard`, and that is the existing
 * decision rather than a new one.** A Dashboard is always exactly one Restaurant's view: the API's
 * own query DTO requires `restaurantId` for that reason, and an org-wide Owner lands on the
 * Restaurants list instead. A bare `/dashboard` would have to guess which venue is meant.
 */
export default async function RestaurantDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  return <DashboardView restaurantId={id} />;
}
