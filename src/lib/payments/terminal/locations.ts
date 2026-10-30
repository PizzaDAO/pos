/**
 * Stripe Terminal Location + tipping Configuration per POS location.
 *
 * One Terminal Location (`tml_`) per `locations` row, created lazily on the
 * tenant's CONNECTED account, plus one Terminal Configuration (`tmc_`) carrying
 * the on-reader tip presets (from `payment_settings.tip_presets_bps`). The row in
 * `terminal_locations` records the connected account and key mode the ids were
 * made under; a different account (re-onboarding) or a test<->live key flip
 * invalidates them and they are recreated.
 *
 * In simulated mode nothing touches Stripe: the row still stores the tip mode
 * (so the setting works in a zero-env demo) with `tml_sim_` ids.
 */
import { getPosDriver } from "@/lib/db";
import type {
  TerminalAddress,
  TerminalLocation,
  TerminalTipMode,
} from "@/lib/db/payment-types";
import { TERMINAL_TIP_MODES } from "@/lib/db/payment-types";
import {
  CardPaymentsNotReadyError,
  resolveCardConnectAccountId,
} from "../connect";
import { assertLiveKeyAllowed, cardReaderMode } from "../env";
import {
  createConfiguration,
  createLocation,
  updateConfiguration,
  updateLocation,
} from "../providers/stripe-terminal-api";

export const DEFAULT_TIP_MODE: TerminalTipMode = "reader";

/** The location's address is needed before a Stripe Terminal Location can exist. */
export class TerminalAddressRequiredError extends Error {
  constructor() {
    super("Add the location's street address first: Stripe requires it to register card readers.");
    this.name = "TerminalAddressRequiredError";
  }
}

export class TerminalLocationNotFoundError extends Error {
  constructor() {
    super("Location not found for this tenant.");
    this.name = "TerminalLocationNotFoundError";
  }
}

export function isTerminalTipMode(v: unknown): v is TerminalTipMode {
  return typeof v === "string" && (TERMINAL_TIP_MODES as readonly string[]).includes(v);
}

const US_STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT " +
    "NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY " +
    "PR GU VI AS MP"
  ).split(" "),
);

/** Validate + normalize an address from untrusted input (US only in v1). */
export function parseTerminalAddress(
  input: unknown,
): { ok: true; address: TerminalAddress } | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "address is required." };
  }
  const a = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const line1 = str(a.line1);
  const line2 = str(a.line2);
  const city = str(a.city);
  const state = str(a.state).toUpperCase();
  const postal = str(a.postal_code);
  const country = (str(a.country) || "US").toUpperCase();
  if (!line1 || line1.length > 200) return { ok: false, error: "Street address is required." };
  if (line2.length > 200) return { ok: false, error: "Address line 2 is too long." };
  if (!city || city.length > 100) return { ok: false, error: "City is required." };
  if (country !== "US") return { ok: false, error: "Only US addresses are supported." };
  if (!US_STATES.has(state)) return { ok: false, error: "State must be a 2-letter US state code." };
  if (!/^\d{5}(-\d{4})?$/.test(postal)) {
    return { ok: false, error: "ZIP code must be 5 digits (or ZIP+4)." };
  }
  return {
    ok: true,
    address: {
      line1,
      ...(line2 ? { line2 } : {}),
      city,
      state,
      postal_code: postal,
      country,
    },
  };
}

/**
 * Tip presets (bps) as the whole-percent integers Stripe's reader tipping takes
 * (1..100, at most 3, de-duplicated, ascending).
 */
export function tipPercentagesFromBps(bps: readonly number[]): number[] {
  const pct = new Set<number>();
  for (const b of bps) {
    const p = Math.round(b / 100);
    if (p >= 1 && p <= 100) pct.add(p);
  }
  return [...pct].sort((x, y) => x - y).slice(0, 3);
}

function sameAddress(a: TerminalAddress | null, b: TerminalAddress | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The stored tip mode for a location (default `reader`). */
export async function getTerminalTipMode(
  locationId: string,
): Promise<TerminalTipMode> {
  return (await getPosDriver().getTerminalLocation(locationId))?.tip_mode ?? DEFAULT_TIP_MODE;
}

export interface EnsureTerminalLocationInput {
  tenantId: string;
  locationId: string;
  /** New address to save (else the stored one is used). */
  address?: TerminalAddress;
  /** New tip mode to save (else the stored one is kept). */
  tipMode?: TerminalTipMode;
}

/**
 * Create or repair this location's Terminal Location + tipping Configuration and
 * persist the result. Idempotent: a valid row with nothing changed makes no
 * Stripe call. Throws `CardPaymentsNotReadyError` (no charges-enabled connected
 * account), `TerminalAddressRequiredError`, or a `StripeError`.
 */
export async function ensureTerminalLocation(
  input: EnsureTerminalLocationInput,
): Promise<TerminalLocation> {
  const driver = getPosDriver();
  const location = (await driver.listLocations(input.tenantId)).find(
    (l) => l.id === input.locationId,
  );
  if (!location) throw new TerminalLocationNotFoundError();

  const existing = await driver.getTerminalLocation(input.locationId);
  const now = new Date().toISOString();
  const tipMode = input.tipMode ?? existing?.tip_mode ?? DEFAULT_TIP_MODE;
  const address = input.address ?? existing?.address ?? null;
  const mode = cardReaderMode();

  const base: TerminalLocation = {
    location_id: input.locationId,
    tenant_id: input.tenantId,
    connect_account_id: null,
    stripe_location_id: null,
    configuration_id: null,
    livemode: false,
    address,
    tip_mode: tipMode,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  if (mode === "simulated") {
    return driver.upsertTerminalLocation({
      ...base,
      stripe_location_id: `tml_sim_${input.locationId}`,
    });
  }

  assertLiveKeyAllowed();
  const accountId = await resolveCardConnectAccountId(input.tenantId);
  if (!accountId || accountId.startsWith("acct_sim_")) {
    throw new CardPaymentsNotReadyError();
  }
  if (!address) throw new TerminalAddressRequiredError();
  const livemode = mode === "stripe_live";

  const valid =
    !!existing &&
    existing.connect_account_id === accountId &&
    existing.livemode === livemode &&
    !!existing.stripe_location_id &&
    !existing.stripe_location_id.startsWith("tml_sim_");

  // On-reader tipping presets, from this location's tip presets.
  const settings = await driver.getPaymentSettings(input.tenantId, input.locationId);
  const percentages = tipPercentagesFromBps(settings.tip_presets_bps);
  let configurationId = valid ? (existing?.configuration_id ?? null) : null;
  if (tipMode === "reader" && percentages.length > 0) {
    if (configurationId) {
      await updateConfiguration(accountId, configurationId, {
        currency: settings.currency,
        tipPercentages: percentages,
      });
    } else {
      const cfg = await createConfiguration(accountId, {
        name: `${location.name} tipping`,
        currency: settings.currency,
        tipPercentages: percentages,
      });
      configurationId = cfg.id;
    }
  }

  let stripeLocationId = valid ? existing!.stripe_location_id! : null;
  if (!stripeLocationId) {
    const created = await createLocation(accountId, {
      displayName: location.name,
      address,
      configurationId,
    });
    stripeLocationId = created.id;
  } else if (
    !sameAddress(existing?.address ?? null, address) ||
    configurationId !== (existing?.configuration_id ?? null)
  ) {
    await updateLocation(accountId, stripeLocationId, {
      displayName: location.name,
      address,
      configurationId,
    });
  }

  return driver.upsertTerminalLocation({
    ...base,
    connect_account_id: accountId,
    stripe_location_id: stripeLocationId,
    configuration_id: configurationId,
    livemode,
  });
}
