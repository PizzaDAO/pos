/**
 * Whether the checkout dialog may be dismissed with Esc. Never on the
 * confirmation or waiting steps, nor while a payment request is in flight, so a
 * stray keypress cannot hide the order number or an in-progress payment.
 */
export function canEscDismissCheckout(
  step: "fulfillment" | "identity" | "payment" | "waiting" | "done",
  loading: boolean,
): boolean {
  return !loading && step !== "done" && step !== "waiting";
}
