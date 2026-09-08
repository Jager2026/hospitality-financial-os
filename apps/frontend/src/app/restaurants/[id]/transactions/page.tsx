import type { JSX } from "react";
import { TransactionsView } from "./transactions-view";

/**
 * Transactions — `UX_MAP.md`. The second screen an owner reaches, and they reach it because a
 * figure on the Dashboard raised a question.
 *
 * Under `/restaurants/{id}/` because a transaction list is always one venue's: the endpoint takes
 * a `restaurantId` filter, and an owner with three venues asking "what happened at six" means one
 * of them.
 */
export default async function TransactionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  return <TransactionsView restaurantId={id} />;
}
