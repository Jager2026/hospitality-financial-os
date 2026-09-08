import type { JSX } from "react";
import { TransactionDetailView } from "./transaction-detail";

/** One transaction's breakdown — a page of its own so it can be linked to, which is what an owner
 * does with it when an accountant asks about a figure. */
export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string; transactionId: string }>;
}): Promise<JSX.Element> {
  const { id, transactionId } = await params;
  return <TransactionDetailView restaurantId={id} transactionId={transactionId} />;
}
