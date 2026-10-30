/**
 * Thin wrappers over Stripe's Terminal API for the SERVER-DRIVEN integration
 * (no Terminal JS, no connection tokens). Every call runs on the TENANT's
 * connected account (`Stripe-Account`), because with direct charges the
 * connected account owns the Location, Reader, Configuration and PaymentIntent.
 *
 * Docs (checked 2026-10-29):
 *  - Server-driven overview:  https://docs.stripe.com/terminal/payments/setup-integration?terminal-sdk-platform=server-driven
 *  - Collect a payment:       https://docs.stripe.com/terminal/payments/collect-card-payment?terminal-sdk-platform=server-driven
 *  - Terminal + Connect:      https://docs.stripe.com/terminal/features/connect?connect-charge-type=direct
 *  - Locations:               https://docs.stripe.com/api/terminal/locations
 *  - Readers:                 https://docs.stripe.com/api/terminal/readers
 *  - Configuration (tipping): https://docs.stripe.com/api/terminal/configuration
 *  - On-reader tips:          https://docs.stripe.com/terminal/features/collecting-tips/on-reader
 *  - Test helpers:            https://docs.stripe.com/terminal/references/testing
 *
 * Nothing here is reached in simulated mode (see `cardReaderMode`).
 */
import { isStripeTestKey } from "../env";
import {
  stripeDelete,
  stripeGet,
  stripeRequest,
} from "./stripe-client";

/** Stripe `terminal.reader.action` (the in-flight server-driven action). */
export interface StripeReaderAction {
  type?: string;
  status?: "in_progress" | "succeeded" | "failed";
  failure_code?: string | null;
  failure_message?: string | null;
  process_payment_intent?: { payment_intent?: string } | null;
}

export interface StripeReader {
  id: string;
  label?: string | null;
  device_type?: string | null;
  serial_number?: string | null;
  /** `online` | `offline` (offline after ~2 min without a signal). */
  status?: string | null;
  livemode?: boolean;
  location?: string | null;
  action?: StripeReaderAction | null;
}

/** The slice of a card_present charge we keep for the printed receipt. */
export interface StripeCardPresent {
  brand?: string | null;
  last4?: string | null;
  read_method?: string | null;
  receipt?: {
    application_preferred_name?: string | null;
    dedicated_file_name?: string | null;
    account_type?: string | null;
    authorization_response_code?: string | null;
  } | null;
}

export interface StripeTerminalPaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  metadata?: Record<string, string> | null;
  application_fee_amount?: number | null;
  /** On-reader tips land here (`amount_details.tip.amount`). */
  amount_details?: { tip?: { amount?: number | null } | null } | null;
  last_payment_error?: {
    code?: string | null;
    decline_code?: string | null;
    message?: string | null;
    type?: string | null;
  } | null;
  latest_charge?:
    | string
    | {
        id?: string;
        payment_method_details?: { card_present?: StripeCardPresent | null } | null;
      }
    | null;
}

export interface TerminalAddressParams {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

/** POST /v1/terminal/locations */
export function createLocation(
  stripeAccount: string,
  params: { displayName: string; address: TerminalAddressParams; configurationId?: string | null },
): Promise<{ id: string }> {
  return stripeRequest<{ id: string }>(
    "/terminal/locations",
    {
      display_name: params.displayName,
      address: params.address,
      configuration_overrides: params.configurationId ?? undefined,
    },
    { stripeAccount },
  );
}

/** POST /v1/terminal/locations/:id */
export function updateLocation(
  stripeAccount: string,
  id: string,
  params: { displayName?: string; address?: TerminalAddressParams; configurationId?: string | null },
): Promise<{ id: string }> {
  return stripeRequest<{ id: string }>(
    `/terminal/locations/${id}`,
    {
      display_name: params.displayName,
      address: params.address,
      configuration_overrides: params.configurationId ?? undefined,
    },
    { stripeAccount },
  );
}

/**
 * POST /v1/terminal/configurations: the on-reader tipping presets (percent
 * integers, Stripe allows up to 3) for one currency.
 */
export function createConfiguration(
  stripeAccount: string,
  params: { name: string; currency: string; tipPercentages: number[] },
): Promise<{ id: string }> {
  return stripeRequest<{ id: string }>(
    "/terminal/configurations",
    {
      name: params.name,
      tipping: {
        [params.currency.toLowerCase()]: { percentages: params.tipPercentages },
      },
    },
    { stripeAccount },
  );
}

/** POST /v1/terminal/configurations/:id */
export function updateConfiguration(
  stripeAccount: string,
  id: string,
  params: { name?: string; currency: string; tipPercentages: number[] },
): Promise<{ id: string }> {
  return stripeRequest<{ id: string }>(
    `/terminal/configurations/${id}`,
    {
      name: params.name,
      tipping: {
        [params.currency.toLowerCase()]: { percentages: params.tipPercentages },
      },
    },
    { stripeAccount },
  );
}

/**
 * POST /v1/terminal/readers: register by the pairing code the reader shows
 * (S700: Settings > Generate pairing code). In test mode the code
 * `simulated-wpe` creates a simulated reader.
 */
export function registerReader(
  stripeAccount: string,
  params: { registrationCode: string; label: string; stripeLocationId: string },
): Promise<StripeReader> {
  return stripeRequest<StripeReader>(
    "/terminal/readers",
    {
      registration_code: params.registrationCode,
      label: params.label,
      location: params.stripeLocationId,
    },
    { stripeAccount },
  );
}

/** DELETE /v1/terminal/readers/:id */
export function deleteReader(stripeAccount: string, id: string): Promise<unknown> {
  return stripeDelete(`/terminal/readers/${id}`, { stripeAccount });
}

/** GET /v1/terminal/readers/:id (live `status` and in-flight `action`). */
export function retrieveReader(
  stripeAccount: string,
  id: string,
): Promise<StripeReader> {
  return stripeGet<StripeReader>(`/terminal/readers/${id}`, { stripeAccount });
}

export interface ProcessConfig {
  /** Hide on-reader tipping (POS or no tips). */
  skipTipping?: boolean;
  /** Pre-tip subtotal tip percentages are computed on (reader tip mode). */
  tipAmountEligible?: number;
  /** Let the customer cancel from the reader. */
  enableCustomerCancellation?: boolean;
}

/**
 * POST /v1/terminal/readers/:id/process_payment_intent. The reader collects the
 * card and confirms the PaymentIntent itself (never confirm card_present
 * server-side). `idempotencyKey` is per ATTEMPT (`<paymentId>:process:<n>`).
 */
export function processPaymentIntent(
  stripeAccount: string,
  readerId: string,
  paymentIntentId: string,
  config: ProcessConfig,
  idempotencyKey: string,
): Promise<StripeReader> {
  return stripeRequest<StripeReader>(
    `/terminal/readers/${readerId}/process_payment_intent`,
    {
      payment_intent: paymentIntentId,
      process_config: {
        enable_customer_cancellation: config.enableCustomerCancellation ? true : undefined,
        skip_tipping: config.skipTipping ? true : undefined,
        tipping:
          config.tipAmountEligible !== undefined
            ? { amount_eligible: config.tipAmountEligible }
            : undefined,
      },
    },
    { stripeAccount, idempotencyKey },
  );
}

/** POST /v1/terminal/readers/:id/cancel_action (`terminal_reader_busy` mid-auth). */
export function cancelReaderAction(
  stripeAccount: string,
  readerId: string,
): Promise<StripeReader> {
  return stripeRequest<StripeReader>(
    `/terminal/readers/${readerId}/cancel_action`,
    {},
    { stripeAccount },
  );
}

/**
 * `cancel_action` ONLY if the reader is still working on THIS PaymentIntent. A
 * reader can already have moved on to another payment (another tablet, a new
 * tender), and cancel_action would wipe that customer's screen. Returns true
 * when a cancel_action was sent. Errors from cancel_action (e.g.
 * `terminal_reader_busy`) propagate; a failed reader lookup skips the cancel
 * (the caller still cancels the PaymentIntent, which makes a late tap fail).
 */
export async function cancelReaderActionForIntent(
  stripeAccount: string,
  readerId: string,
  paymentIntentId: string,
): Promise<boolean> {
  let reader: StripeReader;
  try {
    reader = await retrieveReader(stripeAccount, readerId);
  } catch {
    return false;
  }
  if (reader.action?.process_payment_intent?.payment_intent !== paymentIntentId) {
    return false;
  }
  await cancelReaderAction(stripeAccount, readerId);
  return true;
}

/** GET /v1/payment_intents/:id with the latest charge expanded (receipt fields). */
export function retrievePaymentIntent(
  stripeAccount: string,
  id: string,
): Promise<StripeTerminalPaymentIntent> {
  return stripeGet<StripeTerminalPaymentIntent>(
    `/payment_intents/${id}?expand%5B%5D=latest_charge`,
    { stripeAccount },
  );
}

/** POST /v1/payment_intents/:id/cancel */
export function cancelPaymentIntent(
  stripeAccount: string,
  id: string,
): Promise<{ id: string; status: string }> {
  return stripeRequest<{ id: string; status: string }>(
    `/payment_intents/${id}/cancel`,
    {},
    { stripeAccount },
  );
}

/**
 * POST /v1/test_helpers/terminal/readers/:id/present_payment_method: a SIMULATED
 * reader taps a test card. TEST KEYS ONLY. `amountTip` simulates an on-reader tip;
 * `4000000000000002` declines.
 */
export function presentPaymentMethod(
  stripeAccount: string,
  readerId: string,
  params: { cardNumber?: string; amountTip?: number } = {},
): Promise<StripeReader> {
  if (!isStripeTestKey()) {
    throw new Error("present_payment_method is a test-mode helper (sk_test_ key required).");
  }
  return stripeRequest<StripeReader>(
    `/test_helpers/terminal/readers/${readerId}/present_payment_method`,
    {
      type: "card_present",
      card_present: params.cardNumber ? { number: params.cardNumber } : undefined,
      amount_tip: params.amountTip && params.amountTip > 0 ? params.amountTip : undefined,
    },
    { stripeAccount },
  );
}
