/**
 * Card readers: registration, listing with live status, and the readiness gate.
 *
 * Server-driven "discovery and connect" is just this: our list of the location's
 * registered readers (`terminal_readers`) merged with each reader's live
 * `status`/`action` from Stripe. There is no SDK connection to manage; a reader
 * that comes back online simply works.
 *
 * In simulated mode (no Stripe key / training mode / mock driver) every location
 * has one VIRTUAL reader, `tmr_sim_<locationId>`, always online, no Stripe call.
 */
import { getPosDriver } from "@/lib/db";
import type { TerminalReader } from "@/lib/db/payment-types";
import {
  CardPaymentsNotReadyError,
  isCardReady,
  resolveCardConnectAccountId,
} from "../connect";
import { assertLiveKeyAllowed, cardReaderMode, type CardReaderMode } from "../env";
import { StripeError } from "../providers/stripe-client";
import {
  deleteReader,
  registerReader,
  retrieveReader,
  type StripeReaderAction,
} from "../providers/stripe-terminal-api";
import { ensureTerminalLocation } from "./locations";

export const SIM_READER_PREFIX = "tmr_sim_";

export function simulatedReaderId(locationId: string): string {
  return `${SIM_READER_PREFIX}${locationId}`;
}

export function isSimulatedReaderId(id: string): boolean {
  return id.startsWith(SIM_READER_PREFIX);
}

export class ReaderNotFoundError extends Error {
  constructor() {
    super("That card reader isn't registered for this location.");
    this.name = "ReaderNotFoundError";
  }
}

export class ReaderRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReaderRegistrationError";
  }
}

export interface ReaderActionView {
  status: "in_progress" | "succeeded" | "failed" | null;
  failureCode: string | null;
  failureMessage: string | null;
  paymentIntentId: string | null;
}

export interface ReaderView {
  id: string;
  label: string;
  deviceType: string | null;
  serialNumber: string | null;
  /** `unknown` when Stripe could not be reached for its live status. */
  status: "online" | "offline" | "unknown";
  simulated: boolean;
  action: ReaderActionView | null;
}

export function readerActionView(
  action: StripeReaderAction | null | undefined,
): ReaderActionView | null {
  if (!action) return null;
  return {
    status: action.status ?? null,
    failureCode: action.failure_code ?? null,
    failureMessage: action.failure_message ?? null,
    paymentIntentId: action.process_payment_intent?.payment_intent ?? null,
  };
}

function virtualReader(locationId: string): ReaderView {
  return {
    id: simulatedReaderId(locationId),
    label: "Simulated reader",
    deviceType: "simulated",
    serialNumber: null,
    status: "online",
    simulated: true,
    action: null,
  };
}

/** A DB reader row is usable only on the account + key mode it was registered under. */
function readerRowValid(
  row: TerminalReader,
  tenantId: string,
  locationId: string,
  accountId: string | null,
  mode: CardReaderMode,
): boolean {
  return (
    row.tenant_id === tenantId &&
    row.location_id === locationId &&
    !!accountId &&
    row.connect_account_id === accountId &&
    row.livemode === (mode === "stripe_live")
  );
}

/** The connected account to use for reader work, without a Stripe round trip. */
async function storedAccountId(tenantId: string): Promise<string | null> {
  return (await getPosDriver().getConnectAccount(tenantId))?.account_id ?? null;
}

/** Registered, still-valid reader rows at a location (real modes only). */
async function validReaderRows(
  tenantId: string,
  locationId: string,
  accountId: string | null,
  mode: CardReaderMode,
): Promise<TerminalReader[]> {
  const rows = await getPosDriver().listTerminalReaders(tenantId, locationId);
  return rows.filter((r) => readerRowValid(r, tenantId, locationId, accountId, mode));
}

/** Whether the location has at least one usable registered reader (no Stripe call). */
export async function locationHasReader(
  tenantId: string,
  locationId: string,
): Promise<boolean> {
  const mode = cardReaderMode();
  if (mode === "simulated") return true;
  const accountId = await storedAccountId(tenantId);
  return (await validReaderRows(tenantId, locationId, accountId, mode)).length > 0;
}

/**
 * The in-store card gate: card shows only when the tenant is card-ready (a
 * charges-enabled connected account) AND the location has a registered reader.
 * Always true in simulated mode (the virtual reader).
 */
export async function isInStoreCardReady(
  tenantId: string,
  locationId: string | null | undefined,
): Promise<boolean> {
  if (!(await isCardReady(tenantId))) return false;
  if (!locationId) return cardReaderMode() === "simulated";
  return locationHasReader(tenantId, locationId);
}

/** The location's readers merged with each reader's live status. */
export async function listReadersWithStatus(
  tenantId: string,
  locationId: string,
): Promise<ReaderView[]> {
  const mode = cardReaderMode();
  if (mode === "simulated") return [virtualReader(locationId)];
  const accountId = await storedAccountId(tenantId);
  const rows = await validReaderRows(tenantId, locationId, accountId, mode);
  return Promise.all(
    rows.map(async (row): Promise<ReaderView> => {
      const view: ReaderView = {
        id: row.id,
        label: row.label,
        deviceType: row.device_type,
        serialNumber: row.serial_number,
        status: "unknown",
        simulated: row.device_type?.startsWith("simulated") ?? false,
        action: null,
      };
      try {
        const live = await retrieveReader(row.connect_account_id, row.id);
        view.status = live.status === "online" ? "online" : "offline";
        view.action = readerActionView(live.action);
      } catch {
        // Keep `unknown`: the cashier can still try, and Stripe will say why not.
      }
      return view;
    }),
  );
}

export type NotReadyReason = "connect_not_ready" | "no_reader";

export interface CardReadiness {
  mode: CardReaderMode;
  ready: boolean;
  notReadyReason: NotReadyReason | null;
  readers: ReaderView[];
}

/** Everything the terminal needs to decide whether to offer Card. */
export async function getCardReadiness(
  tenantId: string,
  locationId: string,
): Promise<CardReadiness> {
  const mode = cardReaderMode();
  if (!(await isCardReady(tenantId))) {
    return { mode, ready: false, notReadyReason: "connect_not_ready", readers: [] };
  }
  const readers = await listReadersWithStatus(tenantId, locationId);
  if (readers.length === 0) {
    return { mode, ready: false, notReadyReason: "no_reader", readers };
  }
  return { mode, ready: true, notReadyReason: null, readers };
}

/**
 * Resolve a reader for a charge and check it belongs to this tenant + location
 * (and the current account + key mode). The simulated virtual reader is only
 * valid in simulated mode, and only for its own location.
 */
export async function resolveReaderForCharge(
  tenantId: string,
  locationId: string,
  readerId: string,
  accountId: string | null,
): Promise<{ id: string; simulated: boolean }> {
  const mode = cardReaderMode();
  if (mode === "simulated") {
    if (readerId !== simulatedReaderId(locationId)) throw new ReaderNotFoundError();
    return { id: readerId, simulated: true };
  }
  if (isSimulatedReaderId(readerId)) throw new ReaderNotFoundError();
  const row = await getPosDriver().getTerminalReader(readerId);
  if (!row || !readerRowValid(row, tenantId, locationId, accountId, mode)) {
    throw new ReaderNotFoundError();
  }
  return { id: row.id, simulated: false };
}

/** Pairing codes look like `apple-orange-banana`; test mode adds `simulated-*`. */
const CODE_RE = /^[a-z0-9]+(-[a-z0-9]+){0,4}$/i;

/**
 * Register a reader by the pairing code it shows (S700: Settings > Generate
 * pairing code) on the location's Terminal Location. Test mode also accepts
 * `simulated-wpe` for a simulated reader.
 */
export async function registerTerminalReader(input: {
  tenantId: string;
  locationId: string;
  registrationCode: string;
  label: string;
}): Promise<TerminalReader> {
  const mode = cardReaderMode();
  if (mode === "simulated") {
    throw new ReaderRegistrationError(
      "Card readers can't be registered in simulated mode: every location already has a built-in simulated reader.",
    );
  }
  const code = input.registrationCode.trim();
  if (!CODE_RE.test(code) || code.length > 60) {
    throw new ReaderRegistrationError("Enter the pairing code shown on the reader.");
  }
  const isSimulatedCode = code.toLowerCase().startsWith("simulated");
  if (isSimulatedCode && mode !== "stripe_test") {
    throw new ReaderRegistrationError("Simulated readers are only available in Stripe test mode.");
  }
  const label = input.label.trim().slice(0, 80) || "Card reader";

  assertLiveKeyAllowed();
  const accountId = await resolveCardConnectAccountId(input.tenantId);
  if (!accountId || accountId.startsWith("acct_sim_")) throw new CardPaymentsNotReadyError();
  // Needs a Terminal Location (and so a saved address) to register against.
  const tl = await ensureTerminalLocation({
    tenantId: input.tenantId,
    locationId: input.locationId,
  });
  if (!tl.stripe_location_id) throw new ReaderRegistrationError("Set up the terminal location first.");

  const reader = await registerReader(accountId, {
    registrationCode: code,
    label,
    stripeLocationId: tl.stripe_location_id,
  });
  const now = new Date().toISOString();
  return getPosDriver().upsertTerminalReader({
    id: reader.id,
    tenant_id: input.tenantId,
    location_id: input.locationId,
    connect_account_id: accountId,
    label: reader.label || label,
    device_type: reader.device_type ?? null,
    serial_number: reader.serial_number ?? null,
    livemode: mode === "stripe_live",
    created_at: now,
    updated_at: now,
  });
}

/** Remove a reader (Stripe first, then our row). */
export async function removeTerminalReader(input: {
  tenantId: string;
  locationId: string;
  readerId: string;
}): Promise<void> {
  const driver = getPosDriver();
  const row = await driver.getTerminalReader(input.readerId);
  if (!row || row.tenant_id !== input.tenantId || row.location_id !== input.locationId) {
    throw new ReaderNotFoundError();
  }
  if (cardReaderMode() !== "simulated") {
    try {
      await deleteReader(row.connect_account_id, row.id);
    } catch (err) {
      // Already gone on Stripe's side: still drop our row.
      if (!(err instanceof StripeError && err.code === "resource_missing")) throw err;
    }
  }
  await driver.deleteTerminalReader(row.id);
}
