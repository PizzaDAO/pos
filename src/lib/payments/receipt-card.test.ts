import { describe, it, expect } from "vitest";
import type { Payment } from "@/lib/db";
import { cardReceiptOf } from "./receipt";

const payment = (raw: Record<string, unknown> | null) =>
  ({ id: "p1", raw }) as unknown as Payment;

describe("card receipt fields", () => {
  it("formats the brand/last4 summary and the EMV fields", () => {
    const card = cardReceiptOf(
      payment({
        card_receipt: {
          brand: "visa",
          last4: "4242",
          read_method: "contactless_emv",
          application_preferred_name: "Visa Credit",
          dedicated_file_name: "A0000000031010",
          account_type: "credit",
          authorization_code: "SIM123",
        },
      }),
    );
    expect(card).toEqual({
      summary: "Visa •••• 4242",
      entryMethod: "Tap",
      applicationName: "Visa Credit",
      aid: "A0000000031010",
      accountType: "credit",
      authCode: "SIM123",
    });
  });

  it("is null for cash/crypto tenders and unsettled card tenders", () => {
    expect(cardReceiptOf(payment(null))).toBeNull();
    expect(cardReceiptOf(payment({ simulated: true }))).toBeNull();
  });

  it("tolerates missing fields", () => {
    const card = cardReceiptOf(payment({ card_receipt: { brand: "amex" } }));
    expect(card?.summary).toBe("Amex");
    expect(card?.aid).toBeNull();
  });
});
