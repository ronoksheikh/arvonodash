/**
 * Steadfast reports "partial_delivered" both when the customer kept some items and when they
 * refused the product but paid the rider the delivery charge. The collected amount tells them
 * apart: less than the cheapest item means nothing was kept.
 */
export type PartialOutcome = "charge_only" | "some_items";

export function partialOutcome(collected: number | null | undefined, items: { price: number; quantity: number }[]): PartialOutcome {
  const prices = items.filter((i) => i.quantity > 0 && i.price > 0).map((i) => i.price);
  if (!prices.length) return "some_items";
  return (collected ?? 0) < Math.min(...prices) ? "charge_only" : "some_items";
}

export const PARTIAL_OUTCOME_LABEL: Record<PartialOutcome, string> = {
  charge_only: "Delivery charge paid · product returned",
  some_items: "Partially delivered · some items returned",
};
