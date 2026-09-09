import type { JSX } from "react";
import { StaffView } from "./staff-view";

/**
 * Staff — `UX_MAP.md`. The screen an owner reaches to answer "who works here", and the only place
 * the product offers to add somebody.
 *
 * Under `/restaurants/{id}/` because staff is always one venue's: the list endpoint takes a
 * Restaurant, and an invitation is scoped to one (ADR-005) unless it is deliberately org-wide,
 * which this screen does not offer — an org-wide grant is a wider thing than "add a waiter", and
 * offering it from a venue's own page would make it the accidental default.
 */
export default async function StaffPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  return <StaffView restaurantId={id} />;
}
