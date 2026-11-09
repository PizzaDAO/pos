/**
 * Recipient delivery hook for gift cards bought online. INERT: nothing is ever
 * sent. It is called once, when the card activates (its sale settled), with the
 * re-derived code, and reports what it did. Wiring a real email provider means
 * implementing the `enabled` branch behind GIFT_CARD_EMAIL_DELIVERY=1 (off by
 * default); until then the buyer sees the code on the confirmation screen.
 */
import type { StoredValueAccount } from "./types";

export interface DeliveryRequest {
  account: Pick<StoredValueAccount, "id" | "tenant_id" | "recipient_email" | "recipient_name" | "code_last4">;
  /** Display-formatted code. Never logged. */
  code: string;
  amountCents: number;
  currency: string;
}

export type DeliveryOutcome =
  | { status: "skipped"; reason: "no_recipient" | "disabled" | "not_configured" };

export function giftCardEmailDeliveryEnabled(): boolean {
  return process.env.GIFT_CARD_EMAIL_DELIVERY === "1";
}

export async function deliverGiftCard(req: DeliveryRequest): Promise<DeliveryOutcome> {
  if (!req.account.recipient_email) return { status: "skipped", reason: "no_recipient" };
  if (!giftCardEmailDeliveryEnabled()) return { status: "skipped", reason: "disabled" };
  // No email provider is wired yet: never send, never log the code.
  console.info(
    `[giftcards] email delivery requested for card ••••${req.account.code_last4} (no provider configured; not sent)`,
  );
  return { status: "skipped", reason: "not_configured" };
}
