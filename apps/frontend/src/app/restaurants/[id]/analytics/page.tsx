import type { JSX } from "react";
import { AnalyticsView } from "./analytics-view";

/**
 * Analytics — `UX_MAP.md`. Five areas of one question, over one period, read as shifts.
 */
export default async function AnalyticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  return <AnalyticsView restaurantId={id} />;
}
