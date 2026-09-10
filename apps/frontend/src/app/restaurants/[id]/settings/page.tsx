import type { JSX } from "react";
import { SettingsView } from "./settings-view";

/**
 * Venue settings — `UX_MAP.md`. Everything about one venue that an owner can change, and an honest
 * account of the two things they cannot change yet.
 */
export default async function SettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  return <SettingsView restaurantId={id} />;
}
