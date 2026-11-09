/**
 * Stored-value limits and the feature gate (server-only).
 *
 * Gift cards and store credit are ON in the zero-env demo (mock driver) and OFF
 * in real mode unless GIFT_CARDS_ENABLED=1 AND a code pepper
 * (GIFT_CARD_CODE_PEPPER, >= 32 chars) is configured: without a stable pepper no
 * code could ever be looked up again, so the feature fails closed.
 */
import { isRealMode } from "@/lib/auth/signing-secret";
import { codePepper } from "./codes";

/** Smallest gift card sale / reload, in cents. */
export const GIFT_CARD_MIN_CENTS = 500;
/** Largest single sale / reload, in cents. */
export const GIFT_CARD_MAX_LOAD_CENTS = 50_000;
/** A card's balance may never exceed this through sales/reloads (refunds may). */
export const GIFT_CARD_MAX_BALANCE_CENTS = 100_000;
/** Largest single store-credit issue, in cents. */
export const STORE_CREDIT_MAX_CENTS = 50_000;
/** Above this, store credit needs an owner/manager (default $25). */
export const STORE_CREDIT_APPROVAL_DEFAULT_CENTS = 2_500;

export function storeCreditApprovalThresholdCents(): number {
  const raw = Number(process.env.STORE_CREDIT_APPROVAL_CENTS);
  return Number.isInteger(raw) && raw >= 0 ? raw : STORE_CREDIT_APPROVAL_DEFAULT_CENTS;
}

/** A non-manager's store credit issued per day (UTC) above this needs a manager (default $100). */
export const STORE_CREDIT_DAILY_CAP_DEFAULT_CENTS = 10_000;

export function storeCreditDailyCapCents(): number {
  const raw = Number(process.env.STORE_CREDIT_DAILY_CAP_CENTS);
  return Number.isInteger(raw) && raw >= 0 ? raw : STORE_CREDIT_DAILY_CAP_DEFAULT_CENTS;
}

export function giftCardsEnabled(): boolean {
  if (!codePepper()) return false;
  if (!isRealMode()) return true;
  return process.env.GIFT_CARDS_ENABLED === "1";
}

/** A sale / reload amount within limits. */
export function validLoadAmount(cents: unknown): cents is number {
  return (
    typeof cents === "number" &&
    Number.isInteger(cents) &&
    cents >= GIFT_CARD_MIN_CENTS &&
    cents <= GIFT_CARD_MAX_LOAD_CENTS
  );
}

/** A store-credit amount within limits. */
export function validStoreCreditAmount(cents: unknown): cents is number {
  return (
    typeof cents === "number" &&
    Number.isInteger(cents) &&
    cents > 0 &&
    cents <= STORE_CREDIT_MAX_CENTS
  );
}
