/**
 * Supabase-backed PosDriver — the LIVE persistence implementation.
 *
 * Implements the exact same `PosDriver` contract as the in-memory `mock.ts`, so
 * `getPosDriver()` can swap to it WITHOUT touching any call site. It is selected
 * in `client.ts` only when the Supabase env vars are present; otherwise the mock
 * remains the default (the app must build/run/test with zero env vars).
 *
 * Design:
 *   * One `@supabase/supabase-js` client is constructed lazily from env. On the
 *     SERVER we use the service-role key (so background/API writes work) but
 *     EVERY tenant-scoped query carries an explicit tenant_id/location_id filter,
 *     so service-role usage never crosses tenants even though it bypasses RLS
 *     (see supabase/README.md). In the browser the anon key + the user's session
 *     would be used and RLS enforces scope; this module is intended for
 *     server-side use (route handlers / RSC), matching the mock's call sites.
 *   * The relational order graph (orders -> order_items -> order_item_modifiers)
 *     is read back and re-assembled into the same `Order` object the mock
 *     returns. Computed/structured fields (totals, fulfillment, report snapshots,
 *     raw rail data) are stored as jsonb and round-tripped verbatim.
 *   * Menu reads fold per-location overrides + 86 exactly like the mock's
 *     `assembleMenu`, so the terminal/shop are byte-for-byte equivalent.
 *
 * Money is always integer minor units; nothing here uses floats.
 */
import { MarketplaceStoreTakenError } from "@/lib/marketplace/guard";
import {
  assertNoSimulatedOverwrite,
  isConnectedForHealth,
} from "@/lib/payments/connect-status";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { captureError } from "@/lib/observability";
import type {
  Printer,
  PrintJob,
  PrintLocationSettings,
} from "@/lib/printing/types";
import type { PosDriver } from "./driver";
import type { AdjustmentRecord } from "./adjustment-types";
import type {
  ItemSize,
  Menu,
  MenuCategoryWithItems,
  MenuItem,
  MenuItemDetail,
  MenuModifierGroup,
  Modifier,
  ModifierGroup,
  Order,
  OrderItem,
  OrderItemModifier,
  OrderStatus,
  OrderTotals,
  StoreSettings,
} from "./menu-types";
import type {
  ConnectAccount,
  Payment,
  PaymentSessionRow,
  AllergenPublicationRecord,
  PaymentSettings,
  TerminalLocation,
  TerminalReader,
} from "./payment-types";
import {
  LiveTenderConflictError,
  PaymentSessionConflictError,
} from "./payment-types";
import { isLiveOrderStatus, isUnpaidOnlineStatus } from "./menu-types";
import type { Customer, DeliveryRecord } from "./customer-types";
import type {
  BusinessDayClose,
  CategoryInput,
  DateRange,
  DrawerReconciliation,
  InventoryItem,
  InventoryItemView,
  InventoryMovement,
  ItemInput,
  ItemInventoryLink,
  LocationMenuOverride,
  ModifierGroupInput,
  ModifierInput,
  MovementReason,
  OverrideInput,
  OverrideTargetType,
  SalesReport,
  Shift,
  ShiftCashEvent,
  SizeInput,
  Staff,
  StaffSession,
} from "./backoffice-types";
import { normalizeModuleRoles } from "./backoffice-types";
import type {
  InventoryOwner,
  Location,
  Membership,
  Tenant,
  TenantSettings,
  User,
} from "./types";
import type {
  AuditLogEntry,
  OnboardingStep,
  PendingBillingCheckout,
  PlanTier,
  Subscription,
  TenantHealth,
  TenantOnboarding,
} from "./saas-types";
import { ONBOARDING_STEPS } from "./saas-types";
import { buildStarterMenu } from "@/lib/saas/menu-template";
import { buildSalesReport, locationBusinessDate } from "@/lib/reports";
import { EMPTY_BUNDLE, type OwnerReportBundle } from "@/lib/owner-reports";
import { fetchAllPages, safeKeyset } from "./paging";

// ---------------------------------------------------------------------------
// Config + client construction (lazy; never at module load).
// ---------------------------------------------------------------------------

export interface SupabaseDriverConfig {
  url: string;
  /** Service-role key (server) when available, else anon key. */
  key: string;
}

/**
 * Resolve Supabase config from the environment at CALL time. Prefers the
 * service-role key on the server (so writes succeed), falling back to the anon
 * key. Returns null when not configured so callers stay on the mock driver.
 */
export function readSupabaseConfig(): SupabaseDriverConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const key = serviceKey || anonKey;
  if (!url || !key) return null;
  return { url, key };
}

function genUuid(): string {
  // crypto.randomUUID is available in Node 18+ and the browser.
  return globalThis.crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Slugify a name into a URL-safe base slug (uniqueness handled by caller). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tenant"
  );
}

// ---------------------------------------------------------------------------
// Row <-> domain mappers. The DB stores enums/jsonb that map 1:1 to the TS
// shapes; these helpers normalise nullable columns the mock returns as `null`
// and re-assemble structured blobs.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function mapTenant(r: Row): Tenant {
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    status: r.status as Tenant["status"],
    suspended_by_platform: r.suspended_by_platform === true,
    created_at: r.created_at as string,
  };
}

function mapLocation(r: Row): Location {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    name: r.name as string,
    slug: r.slug as string,
    timezone: r.timezone as string,
    business_day_cutoff_minutes: (r.business_day_cutoff_minutes as number | null) ?? 0,
    address: (r.address as string | null) ?? null,
    address_line1: (r.address_line1 as string | null) ?? null,
    address_line2: (r.address_line2 as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    region: (r.region as string | null) ?? null,
    postal_code: (r.postal_code as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    lat: (r.lat as number | null) ?? null,
    lng: (r.lng as number | null) ?? null,
    created_at: r.created_at as string,
  };
}

function mapTenantSettings(r: Row): TenantSettings {
  return {
    tenant_id: r.tenant_id as string,
    inventory_owner: (r.inventory_owner as InventoryOwner) ?? "pos_basic",
    updated_at: r.updated_at as string,
  };
}

function mapUser(r: Row): User {
  return {
    id: r.id as string,
    email: r.email as string,
    created_at: r.created_at as string,
  };
}

function mapStoreSettings(r: Row): StoreSettings {
  return {
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    currency: r.currency as string,
    tax_rate_bps: r.tax_rate_bps as number,
    tip_presets_bps: (r.tip_presets_bps as number[]) ?? [],
    kds_thresholds:
      (r.kds_thresholds as StoreSettings["kds_thresholds"]) ?? undefined,
    fulfillment: (r.fulfillment as StoreSettings["fulfillment"]) ?? undefined,
    marketplace: (r.marketplace as StoreSettings["marketplace"]) ?? undefined,
    adjustment_policy:
      (r.adjustment_policy as StoreSettings["adjustment_policy"] | null) ?? undefined,
  };
}

function mapAdjustmentRecord(r: Row): AdjustmentRecord {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    order_id: r.order_id as string,
    kind: r.kind as AdjustmentRecord["kind"],
    status: r.status as AdjustmentRecord["status"],
    amount_cents: r.amount_cents as number,
    tip_cents: (r.tip_cents as number | null) ?? 0,
    lines: (r.lines as AdjustmentRecord["lines"] | null) ?? [],
    allocations: (r.allocations as AdjustmentRecord["allocations"] | null) ?? [],
    reason_code: r.reason_code as string,
    reason_text: (r.reason_text as string | null) ?? null,
    staff_id: (r.staff_id as string | null) ?? null,
    actor_user_id: r.actor_user_id as string,
    approved_by: (r.approved_by as string | null) ?? null,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
    claimed_until: (r.claimed_until as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapPaymentSettings(r: Row): PaymentSettings {
  return {
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    currency: r.currency as string,
    platform_fee_bps: r.platform_fee_bps as number,
    platform_fee_flat_cents: r.platform_fee_flat_cents as number,
    tip_presets_bps: (r.tip_presets_bps as number[]) ?? [],
  };
}

function mapOrder(r: Row, items: OrderItem[]): Order {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    status: r.status as OrderStatus,
    channel: r.channel as Order["channel"],
    currency: r.currency as string,
    items,
    discount_cents: r.discount_cents as number,
    totals: r.totals as Order["totals"],
    notes: (r.notes as string | null) ?? null,
    order_number: r.order_number as string,
    customer_id: (r.customer_id as string | null) ?? null,
    staff_id: (r.staff_id as string | null) ?? null,
    fulfillment: (r.fulfillment as Order["fulfillment"]) ?? undefined,
    source: (r.source as Order["source"] | null) ?? undefined,
    hold: (r.hold as Order["hold"] | null) ?? null,
    core_ext: (r.core_ext as Order["core_ext"] | null) ?? null,
    adjustments: (r.adjustments as Order["adjustments"] | null) ?? null,
    version: (r.version as number | null) ?? 1,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapPayment(r: Row): Payment {
  return {
    id: r.id as string,
    order_id: r.order_id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    rail: r.rail as Payment["rail"],
    status: r.status as Payment["status"],
    amount_cents: r.amount_cents as number,
    tip_cents: r.tip_cents as number,
    application_fee_cents: r.application_fee_cents as number,
    currency: r.currency as string,
    charge_id: (r.charge_id as string | null) ?? null,
    connect_account_id: (r.connect_account_id as string | null) ?? null,
    crypto_tx_hash: (r.crypto_tx_hash as string | null) ?? null,
    crypto_chain: (r.crypto_chain as string | null) ?? null,
    cash_tendered_cents: (r.cash_tendered_cents as number | null) ?? null,
    cash_change_cents: (r.cash_change_cents as number | null) ?? null,
    refunded_cents: r.refunded_cents as number,
    // Absent on a database that predates the column: tipRefundedCents() then
    // applies the legacy tip-first rule.
    ...(typeof r.tip_refunded_cents === "number"
      ? { tip_refunded_cents: r.tip_refunded_cents as number }
      : {}),
    ...(typeof r.refund_reserved_cents === "number"
      ? { refund_reserved_cents: r.refund_reserved_cents as number }
      : {}),
    refund_ids: (r.refund_ids as string[] | null) ?? [],
    refunds: (r.refunds as Payment["refunds"] | null) ?? [],
    method: (r.method as string | null) ?? null,
    processor: (r.processor as string | null) ?? null,
    processor_ref: (r.processor_ref as string | null) ?? null,
    collection: (r.collection as string | null) ?? null,
    staff_id: (r.staff_id as string | null) ?? null,
    simulated: r.simulated as boolean,
    raw: (r.raw as Record<string, unknown> | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapPaymentSession(r: Row): PaymentSessionRow {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    order_id: r.order_id as string,
    payment_id: (r.payment_id as string | null) ?? null,
    status: r.status as PaymentSessionRow["status"],
    url: r.url as string,
    stripe_session_id: (r.stripe_session_id as string | null) ?? null,
    currency: r.currency as string,
    amount_cents: r.amount_cents as number,
    tip_cents: r.tip_cents as number,
    application_fee_cents: r.application_fee_cents as number,
    idempotency_key: r.idempotency_key as string,
    request_hash: r.request_hash as string,
    success_url: r.success_url as string,
    cancel_url: (r.cancel_url as string | null) ?? null,
    // timestamptz comes back as "…+00:00": normalise to the Z form.
    expires_at: new Date(r.expires_at as string).toISOString(),
    simulated: r.simulated as boolean,
    created_at: new Date(r.created_at as string).toISOString(),
    updated_at: new Date(r.updated_at as string).toISOString(),
  };
}

function mapInventoryItem(r: Row): InventoryItem {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    name: r.name as string,
    unit: r.unit as InventoryItem["unit"],
    on_hand: r.on_hand as number,
    low_threshold: r.low_threshold as number,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapInventoryMovement(r: Row): InventoryMovement {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    inventory_item_id: r.inventory_item_id as string,
    reason: r.reason as MovementReason,
    delta: r.delta as number,
    resulting_on_hand: r.resulting_on_hand as number,
    order_id: (r.order_id as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

function mapStaff(r: Row, opts?: { includePin?: boolean }): Staff {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    name: r.name as string,
    role: r.role as Staff["role"],
    active: r.active as boolean,
    // pin_hash is only carried for server-side PIN verification (getStaffById);
    // list/upsert results omit it so it never reaches the client.
    pin_hash: opts?.includePin
      ? ((r.pin_hash as string | null) ?? null)
      : undefined,
    pin_previous_hash: opts?.includePin
      ? ((r.pin_previous_hash as string | null) ?? null)
      : undefined,
    pin_previous_until: opts?.includePin
      ? ((r.pin_previous_until as string | null) ?? null)
      : undefined,
    user_id: (r.user_id as string | null) ?? null,
    location_ids: (r.location_ids as string[] | null) ?? [],
    module_roles: normalizeModuleRoles(r.module_roles),
    contact_email: (r.contact_email as string | null) ?? null,
    contact_phone: (r.contact_phone as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

function mapShift(r: Row): Shift {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    staff_id: r.staff_id as string,
    status: r.status as Shift["status"],
    opened_at: r.opened_at as string,
    closed_at: (r.closed_at as string | null) ?? null,
    opening_float_cents: r.opening_float_cents as number,
    counted_cents: (r.counted_cents as number | null) ?? null,
    close_note: (r.close_note as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

function mapCustomer(r: Row): Customer {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    email: (r.email as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    verified: r.verified as boolean,
    email_verified_at: (r.email_verified_at as string | null) ?? null,
    phone_verified_at: (r.phone_verified_at as string | null) ?? null,
    marketing: (r.marketing as Customer["marketing"] | null) ?? {},
    tags: (r.tags as string[] | null) ?? [],
    external_ids: (r.external_ids as Record<string, string> | null) ?? {},
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapDelivery(r: Row): DeliveryRecord {
  return {
    id: r.id as string,
    order_id: r.order_id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    provider: r.provider as string,
    status: r.status as DeliveryRecord["status"],
    zone_id: (r.zone_id as string | null) ?? null,
    fee_cents: r.fee_cents as number,
    currency: r.currency as string,
    eta_minutes: (r.eta_minutes as number | null) ?? null,
    provider_delivery_id: (r.provider_delivery_id as string | null) ?? null,
    tracking_ref: (r.tracking_ref as string | null) ?? null,
    dropoff: r.dropoff as DeliveryRecord["dropoff"],
    driver_name: (r.driver_name as string | null) ?? null,
    driver_phone: (r.driver_phone as string | null) ?? null,
    simulated: r.simulated as boolean,
    dispatch_attempts: (r.dispatch_attempts as number | null) ?? 0,
    dispatch_error: (r.dispatch_error as string | null) ?? null,
    dispatch_next_at: (r.dispatch_next_at as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapAllergenPublication(r: Row): AllergenPublicationRecord {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    version: r.version as string,
    payload_hash: r.payload_hash as string,
    location_ids: (r.location_ids as string[] | null) ?? null,
    row_count: r.row_count as number,
    published_by: (r.published_by as string | null) ?? null,
    published_at: r.published_at as string,
  };
}

function mapSubscription(r: Row): Subscription {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    tier: r.tier as PlanTier,
    status: r.status as Subscription["status"],
    current_period_end: r.current_period_end as string,
    trial_end: (r.trial_end as string | null) ?? null,
    cancel_at_period_end: r.cancel_at_period_end as boolean,
    simulated: r.simulated as boolean,
    stripe_customer_id: (r.stripe_customer_id as string | null) ?? null,
    stripe_subscription_id: (r.stripe_subscription_id as string | null) ?? null,
    last_event_created:
      r.last_event_created == null ? null : Number(r.last_event_created),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapPendingBillingCheckout(r: Row): PendingBillingCheckout {
  return {
    tenant_id: r.tenant_id as string,
    session_id: r.session_id as string,
    tier: r.tier as PlanTier,
    url: r.url as string,
    expires_at: r.expires_at as string,
    created_at: r.created_at as string,
  };
}

function mapOnboarding(r: Row): TenantOnboarding {
  return {
    tenant_id: r.tenant_id as string,
    current_step: r.current_step as OnboardingStep,
    completed_steps: (r.completed_steps as OnboardingStep[]) ?? [],
    live: r.live as boolean,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapAudit(r: Row): AuditLogEntry {
  return {
    id: r.id as string,
    actor_user_id: r.actor_user_id as string,
    actor_label: r.actor_label as string,
    action: r.action as AuditLogEntry["action"],
    tenant_id: (r.tenant_id as string | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

function mapOverride(r: Row): LocationMenuOverride {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    target_type: r.target_type as OverrideTargetType,
    target_id: r.target_id as string,
    price_cents: (r.price_cents as number | null) ?? null,
    available: (r.available as boolean | null) ?? null,
    updated_at: r.updated_at as string,
  };
}

function mapConnect(r: Row): ConnectAccount {
  return {
    tenant_id: r.tenant_id as string,
    account_id: r.account_id as string,
    status: r.status as ConnectAccount["status"],
    charges_enabled: r.charges_enabled as boolean,
    payouts_enabled: r.payouts_enabled as boolean,
    details_submitted: r.details_submitted as boolean,
    simulated: r.simulated as boolean,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapTerminalLocation(r: Row): TerminalLocation {
  return {
    location_id: r.location_id as string,
    tenant_id: r.tenant_id as string,
    connect_account_id: (r.connect_account_id as string | null) ?? null,
    stripe_location_id: (r.stripe_location_id as string | null) ?? null,
    configuration_id: (r.configuration_id as string | null) ?? null,
    livemode: (r.livemode as boolean) ?? false,
    address: (r.address as TerminalLocation["address"]) ?? null,
    tip_mode: r.tip_mode as TerminalLocation["tip_mode"],
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapTerminalReader(r: Row): TerminalReader {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    connect_account_id: r.connect_account_id as string,
    label: (r.label as string) ?? "",
    device_type: (r.device_type as string | null) ?? null,
    serial_number: (r.serial_number as string | null) ?? null,
    livemode: (r.livemode as boolean) ?? false,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapPrinter(r: Row): Printer {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    label: (r.label as string) ?? "",
    protocol: r.protocol as Printer["protocol"],
    format: r.format as Printer["format"],
    columns: r.columns as Printer["columns"],
    token_hash: r.token_hash as string,
    last_seen_at: (r.last_seen_at as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

function mapPrintJob(r: Row): PrintJob {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    location_id: r.location_id as string,
    printer_id: r.printer_id as string,
    order_id: (r.order_id as string | null) ?? null,
    kind: r.kind as PrintJob["kind"],
    document: r.document as PrintJob["document"],
    status: r.status as PrintJob["status"],
    attempts: (r.attempts as number) ?? 0,
    error: (r.error as string | null) ?? null,
    dedupe_key: (r.dedupe_key as string | null) ?? null,
    created_at: r.created_at as string,
    expires_at: r.expires_at as string,
    claimed_at: (r.claimed_at as string | null) ?? null,
    done_at: (r.done_at as string | null) ?? null,
    retry_after: (r.retry_after as string | null) ?? null,
  };
}

function mapPrintSettings(r: Row): PrintLocationSettings {
  return {
    location_id: r.location_id as string,
    tenant_id: r.tenant_id as string,
    auto_print: (r.auto_print as boolean) ?? false,
    updated_at: r.updated_at as string,
  };
}

// ---------------------------------------------------------------------------
// Driver factory.
// ---------------------------------------------------------------------------

export function createSupabaseDriver(config: SupabaseDriverConfig): PosDriver {
  const sb: SupabaseClient = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /** Throw on a Supabase error; return data otherwise. */
  function unwrap<T>(res: {
    data: T | null;
    error: { message: string; code?: string } | null;
  }): T {
    if (res.error) {
      // Keep the Postgres SQLSTATE (e.g. 40P01) so callers can tell a
      // retryable conflict from a real failure.
      throw Object.assign(new Error(`Supabase: ${res.error.message}`), {
        code: res.error.code,
      });
    }
    return res.data as T;
  }

  // -- Menu assembly (mirrors mock.assembleMenu, folding overrides + 86) ------
  async function assembleMenu(
    tenantId: string,
    locationId: string,
    includeUnavailable = false,
  ): Promise<Menu> {
    const [cats, items, sizes, groups, mods, links, overrides] =
      await Promise.all([
        sb
          .from("menu_categories")
          .select("*")
          .eq("tenant_id", tenantId)
          .order("sort_order"),
        sb.from("menu_items").select("*").eq("tenant_id", tenantId),
        sb.from("item_sizes").select("*"),
        sb.from("modifier_groups").select("*").eq("tenant_id", tenantId),
        sb.from("modifiers").select("*"),
        sb.from("item_modifier_groups").select("*"),
        sb
          .from("location_menu_overrides")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId),
      ]);

    const categoryRows = unwrap(cats) as Row[];
    const itemRows = unwrap(items) as Row[];
    const sizeRows = unwrap(sizes) as Row[];
    const groupRows = unwrap(groups) as Row[];
    const modRows = unwrap(mods) as Row[];
    const linkRows = unwrap(links) as Row[];
    const overrideRows = (unwrap(overrides) as Row[]).map(mapOverride);

    const ov = (type: OverrideTargetType, targetId: string) =>
      overrideRows.find(
        (o) => o.target_type === type && o.target_id === targetId,
      );

    const buildItemDetail = (itemRow: Row): MenuItemDetail => {
      const item: MenuItem = {
        id: itemRow.id as string,
        tenant_id: itemRow.tenant_id as string,
        category_id: itemRow.category_id as string,
        name: itemRow.name as string,
        description: (itemRow.description as string | null) ?? null,
        is_half_and_half_capable: itemRow.is_half_and_half_capable as boolean,
        station: itemRow.station as MenuItem["station"],
      };
      const itemSizes: ItemSize[] = sizeRows
        .filter((s) => s.item_id === item.id)
        .sort((a, b) => (a.sort_order as number) - (b.sort_order as number))
        .map((s) => {
          const o = ov("size", s.id as string);
          return {
            id: s.id as string,
            item_id: s.item_id as string,
            name: s.name as string,
            price_cents:
              o?.price_cents != null
                ? o.price_cents
                : (s.price_cents as number),
            sort_order: s.sort_order as number,
          };
        });

      const groupLinks = linkRows
        .filter((l) => l.item_id === item.id)
        .sort((a, b) => (a.sort_order as number) - (b.sort_order as number));

      const modifierGroups: MenuModifierGroup[] = groupLinks
        .map((link) => {
          const g = groupRows.find((x) => x.id === link.group_id);
          if (!g) return null;
          const group: ModifierGroup = {
            id: g.id as string,
            tenant_id: g.tenant_id as string,
            name: g.name as string,
            min_select: g.min_select as number,
            max_select: g.max_select as number,
            supports_half: g.supports_half as boolean,
          };
          const groupMods: Modifier[] = modRows
            .filter((m) => m.group_id === group.id)
            .filter(
              (m) =>
                includeUnavailable ||
                ov("modifier", m.id as string)?.available !== false,
            )
            .sort((a, b) => (a.sort_order as number) - (b.sort_order as number))
            .map((m) => {
              const o = ov("modifier", m.id as string);
              return {
                id: m.id as string,
                group_id: m.group_id as string,
                name: m.name as string,
                price_cents:
                  o?.price_cents != null
                    ? o.price_cents
                    : (m.price_cents as number),
                sort_order: m.sort_order as number,
              };
            });
          return { ...group, modifiers: groupMods };
        })
        .filter((g): g is MenuModifierGroup => g !== null);

      return { ...item, sizes: itemSizes, modifierGroups };
    };

    const categories: MenuCategoryWithItems[] = categoryRows.map((c) => {
      const catItems = itemRows
        .filter((i) => i.category_id === c.id)
        .filter(
          (i) =>
            includeUnavailable ||
            ov("item", i.id as string)?.available !== false,
        )
        .map(buildItemDetail);
      return {
        id: c.id as string,
        tenant_id: c.tenant_id as string,
        name: c.name as string,
        sort_order: c.sort_order as number,
        items: catItems,
      };
    });

    return { tenantId, locationId, categories };
  }

  // -- Order graph read (orders + items + modifiers) --------------------------
  async function readOrderRow(orderRow: Row): Promise<Order> {
    return (await readOrderRows([orderRow]))[0] as Order;
  }

  /**
   * Chunked `in` query that PAGES each chunk with `.range()` over a stable total
   * order (parent column, then id), so nothing past PostgREST's row cap is lost.
   * Callers re-sort in memory when they need a business order (sort_order, ...).
   */
  async function selectIn(
    table: string,
    column: string,
    ids: string[],
    tieBreak = "id",
  ): Promise<Row[]> {
    const out: Row[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      out.push(
        ...(await fetchAllPages<Row>(async (from, to) =>
          unwrap(
            await sb
              .from(table)
              .select("*")
              .in(column, chunk)
              .order(column)
              .order(tieBreak)
              .range(from, to),
          ) as Row[],
        )),
      );
    }
    return out;
  }

  /** Batch order-graph read: 2 queries per 100 orders, not 2 per order. */
  async function readOrderRows(orderRows: Row[]): Promise<Order[]> {
    if (orderRows.length === 0) return [];
    const itemRows = await selectIn(
      "order_items",
      "order_id",
      orderRows.map((r) => r.id as string),
    );
    itemRows.sort((a, b) => (a.sort_order as number) - (b.sort_order as number));
    const modRows = await selectIn(
      "order_item_modifiers",
      "order_item_id",
      itemRows.map((r) => r.id as string),
    );
    modRows.sort((a, b) => (a.sort_order as number) - (b.sort_order as number));
    const modsByItem = new Map<string, Row[]>();
    for (const m of modRows) {
      const k = m.order_item_id as string;
      if (!modsByItem.has(k)) modsByItem.set(k, []);
      modsByItem.get(k)!.push(m);
    }
    const itemsByOrder = new Map<string, Row[]>();
    for (const r of itemRows) {
      const k = r.order_id as string;
      if (!itemsByOrder.has(k)) itemsByOrder.set(k, []);
      itemsByOrder.get(k)!.push(r);
    }
    return orderRows.map((orderRow) => {
      const items: OrderItem[] = (
        itemsByOrder.get(orderRow.id as string) ?? []
      ).map((ir) => ({
        id: ir.id as string,
        item_id: ir.item_id as string,
        item_name: ir.item_name as string,
        station: (ir.station as OrderItem["station"]) ?? undefined,
        size_id: (ir.size_id as string | null) ?? null,
        size_name: (ir.size_name as string | null) ?? null,
        base_price_cents: ir.base_price_cents as number,
        quantity: ir.quantity as number,
        modifiers: (modsByItem.get(ir.id as string) ?? []).map((m) => ({
          group_id: m.group_id as string,
          group_name: m.group_name as string,
          modifier_id: m.modifier_id as string,
          modifier_name: m.modifier_name as string,
          price_cents: m.price_cents as number,
          placement: m.placement as OrderItemModifier["placement"],
        })),
        notes: (ir.notes as string | null) ?? null,
        voided: ir.voided as boolean,
        unit_price_cents: ir.unit_price_cents as number,
        line_total_cents: ir.line_total_cents as number,
        fired_at: (ir.fired_at as string | null) ?? null,
        voided_at: (ir.voided_at as string | null) ?? null,
        status_at_void: (ir.status_at_void as string | null) ?? null,
      }));
      return mapOrder(orderRow, items);
    });
  }

  /** Write an order's line items + modifiers (delete-then-insert children). */
  async function writeOrderItems(
    orderId: string,
    items: OrderItem[],
  ): Promise<void> {
    // Children cascade on order delete, but on a fresh insert there are none.
    const itemRows = items.map((line, idx) => ({
      id: line.id,
      order_id: orderId,
      item_id: line.item_id,
      item_name: line.item_name,
      station: line.station ?? null,
      size_id: line.size_id,
      size_name: line.size_name,
      base_price_cents: line.base_price_cents,
      quantity: line.quantity,
      notes: line.notes,
      voided: line.voided,
      unit_price_cents: line.unit_price_cents,
      line_total_cents: line.line_total_cents,
      sort_order: idx,
    }));
    if (itemRows.length > 0) {
      unwrap(await sb.from("order_items").insert(itemRows).select());
    }
    const modRows = items.flatMap((line) =>
      line.modifiers.map((m, idx) => ({
        id: genUuid(),
        order_item_id: line.id,
        group_id: m.group_id,
        group_name: m.group_name,
        modifier_id: m.modifier_id,
        modifier_name: m.modifier_name,
        price_cents: m.price_cents,
        placement: m.placement,
        sort_order: idx,
      })),
    );
    if (modRows.length > 0) {
      unwrap(await sb.from("order_item_modifiers").insert(modRows).select());
    }
  }

  // -- Inventory movement (read level, apply delta, write ledger) -------------
  async function applyMovementInternal(input: {
    inventoryItemId: string;
    reason: MovementReason;
    delta: number;
    orderId?: string | null;
    note?: string | null;
  }): Promise<{ item: InventoryItem; movement: InventoryMovement } | null> {
    const existing = unwrap(
      await sb
        .from("inventory_items")
        .select("*")
        .eq("id", input.inventoryItemId)
        .maybeSingle(),
    ) as Row | null;
    if (!existing) return null;
    const item = mapInventoryItem(existing);
    const newOnHand = Math.max(0, item.on_hand + input.delta);
    const updated = mapInventoryItem(
      unwrap(
        await sb
          .from("inventory_items")
          .update({ on_hand: newOnHand, updated_at: nowIso() })
          .eq("id", item.id)
          .select()
          .single(),
      ) as Row,
    );
    const movement = mapInventoryMovement(
      unwrap(
        await sb
          .from("inventory_movements")
          .insert({
            id: genUuid(),
            tenant_id: item.tenant_id,
            location_id: item.location_id,
            inventory_item_id: item.id,
            reason: input.reason,
            delta: input.delta,
            resulting_on_hand: newOnHand,
            order_id: input.orderId ?? null,
            note: input.note ?? null,
          })
          .select()
          .single(),
      ) as Row,
    );
    return { item: updated, movement };
  }

  /** Resolve the location-scoped inventory row for a template id (by name). */
  async function resolveLocationInventory(
    templateInventoryId: string,
    tenantId: string,
    locationId: string,
  ): Promise<InventoryItem | undefined> {
    const tplRow = unwrap(
      await sb
        .from("inventory_items")
        .select("*")
        .eq("id", templateInventoryId)
        .maybeSingle(),
    ) as Row | null;
    if (!tplRow) return undefined;
    const template = mapInventoryItem(tplRow);
    if (template.location_id === locationId) return template;
    const match = unwrap(
      await sb
        .from("inventory_items")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("location_id", locationId)
        .eq("name", template.name)
        .maybeSingle(),
    ) as Row | null;
    return match ? mapInventoryItem(match) : undefined;
  }

  async function depleteForOrder(order: Order): Promise<void> {
    // Back-of-house owns inventory for this tenant: POS must not deplete.
    const settingsRow = unwrap(
      await sb
        .from("tenant_settings")
        .select("*")
        .eq("tenant_id", order.tenant_id)
        .maybeSingle(),
    ) as Row | null;
    if (settingsRow && settingsRow.inventory_owner === "backofhouse") return;
    const links = (
      unwrap(
        await sb
          .from("item_inventory_links")
          .select("*")
          .eq("tenant_id", order.tenant_id),
      ) as Row[]
    ).map(
      (r): ItemInventoryLink => ({
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        source_type: r.source_type as ItemInventoryLink["source_type"],
        source_id: r.source_id as string,
        inventory_item_id: r.inventory_item_id as string,
        qty_per_unit: r.qty_per_unit as number,
      }),
    );

    const consumption = new Map<string, number>();
    const addLink = async (
      sourceType: "item" | "modifier",
      sourceId: string,
      units: number,
    ) => {
      for (const link of links) {
        if (link.source_type !== sourceType || link.source_id !== sourceId) {
          continue;
        }
        const inv = await resolveLocationInventory(
          link.inventory_item_id,
          order.tenant_id,
          order.location_id,
        );
        if (!inv) continue;
        consumption.set(
          inv.id,
          (consumption.get(inv.id) ?? 0) + link.qty_per_unit * units,
        );
      }
    };

    for (const line of order.items) {
      if (line.voided) continue;
      await addLink("item", line.item_id, line.quantity);
      for (const mod of line.modifiers) {
        await addLink("modifier", mod.modifier_id, line.quantity);
      }
    }

    // Per-item idempotent: skip inventory rows this order already depleted.
    const already = new Set(
      (
        unwrap(
          await sb
            .from("inventory_movements")
            .select("inventory_item_id")
            .eq("order_id", order.id)
            .eq("reason", "depletion"),
        ) as Row[]
      ).map((r) => r.inventory_item_id as string),
    );
    for (const [invId, qty] of consumption) {
      if (qty <= 0) continue;
      if (already.has(invId)) continue;
      await applyMovementInternal({
        inventoryItemId: invId,
        reason: "depletion",
        delta: -qty,
        orderId: order.id,
        note: `Sold on order ${order.order_number}`,
      });
    }
  }

  // -- Drawer reconciliation (shared by report + close) -----------------------
  function reconcileFromEvents(
    shift: Shift,
    events: ShiftCashEvent[],
  ): DrawerReconciliation {
    let cashSales = 0;
    let paidIn = 0;
    let payouts = 0;
    for (const e of events) {
      if (e.type === "sale") cashSales += e.amount_cents;
      else if (e.type === "paid_in") paidIn += e.amount_cents;
      else payouts += Math.abs(e.amount_cents);
    }
    const expected = shift.opening_float_cents + cashSales + paidIn - payouts;
    const counted = shift.counted_cents;
    return {
      opening_float_cents: shift.opening_float_cents,
      cash_sales_cents: cashSales,
      paid_in_cents: paidIn,
      payouts_cents: payouts,
      expected_cents: expected,
      counted_cents: counted,
      over_short_cents: counted == null ? null : counted - expected,
    };
  }

  async function nextOrderNumber(
    tenantId: string,
    locationId: string,
  ): Promise<string> {
    // Sequential A-#### per location, derived from the current order count.
    const { count } = await sb
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("location_id", locationId);
    return `A-${String((count ?? 0) + 1).padStart(4, "0")}`;
  }

  // -------------------------------------------------------------------------
  // PosDriver implementation.
  // -------------------------------------------------------------------------
  const driver: PosDriver = {
    name: "supabase",

    // -- Tenancy + self-serve SaaS -----------------------------------------
    async listTenants() {
      return (
        unwrap(
          await sb.from("tenants").select("*").order("created_at"),
        ) as Row[]
      ).map(mapTenant);
    },

    async getTenant(tenantId) {
      const r = unwrap(
        await sb.from("tenants").select("*").eq("id", tenantId).maybeSingle(),
      ) as Row | null;
      return r ? mapTenant(r) : null;
    },

    async createTenant(input) {
      const now = nowIso();
      const existingSlugs = new Set(
        ((unwrap(await sb.from("tenants").select("slug")) as Row[]) ?? []).map(
          (r) => r.slug as string,
        ),
      );
      let slug = slugify(input.businessName);
      if (existingSlugs.has(slug)) {
        let n = 2;
        while (existingSlugs.has(`${slug}-${n}`)) n += 1;
        slug = `${slug}-${n}`;
      }
      const tenant = mapTenant(
        unwrap(
          await sb
            .from("tenants")
            .insert({
              id: genUuid(),
              name: input.businessName.trim(),
              slug,
              status: "suspended",
              created_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );

      const email = input.ownerEmail.trim().toLowerCase();
      let ownerRow = unwrap(
        await sb.from("users").select("*").eq("email", email).maybeSingle(),
      ) as Row | null;
      if (!ownerRow) {
        ownerRow = unwrap(
          await sb
            .from("users")
            .insert({ id: genUuid(), email, created_at: now })
            .select()
            .single(),
        ) as Row;
      }
      const owner = mapUser(ownerRow);

      // Owner membership so RLS lets them operate the tenant immediately.
      unwrap(
        await sb
          .from("memberships")
          .insert({
            id: genUuid(),
            user_id: owner.id,
            tenant_id: tenant.id,
            role: "owner",
            created_at: now,
          })
          .select(),
      );

      unwrap(
        await sb
          .from("tenant_onboarding")
          .insert({
            tenant_id: tenant.id,
            current_step: "location",
            completed_steps: ["business"],
            live: false,
            created_at: now,
            updated_at: now,
          })
          .select(),
      );

      return { tenant, owner };
    },

    async setTenantStatus(tenantId, status, opts) {
      // The platform flag is written in the SAME update as the status.
      const patch: Row = { status };
      if (opts?.byPlatform) patch.suspended_by_platform = status === "suspended";
      const r = unwrap(
        await sb
          .from("tenants")
          .update(patch)
          .eq("id", tenantId)
          .select()
          .maybeSingle(),
      ) as Row | null;
      return r ? mapTenant(r) : null;
    },

    async setLocationCountry(tenantId, locationId, country) {
      const r = unwrap(
        await sb
          .from("locations")
          .update({ country })
          .eq("id", locationId)
          .eq("tenant_id", tenantId)
          .select()
          .maybeSingle(),
      ) as Row | null;
      return r ? mapLocation(r) : null;
    },

    async createLocation(input) {
      const now = nowIso();
      // Slugs are unique per tenant (unique (tenant_id, slug)); "track" is
      // reserved by the legacy storefront tracking route.
      const existingSlugs = new Set([
        "track",
        ...(
          (unwrap(
            await sb
              .from("locations")
              .select("slug")
              .eq("tenant_id", input.tenant_id),
          ) as Row[]) ?? []
        ).map((r) => r.slug as string),
      ]);
      let slug = slugify(input.name);
      if (existingSlugs.has(slug)) {
        let n = 2;
        while (existingSlugs.has(`${slug}-${n}`)) n += 1;
        slug = `${slug}-${n}`;
      }
      const location = mapLocation(
        unwrap(
          await sb
            .from("locations")
            .insert({
              id: genUuid(),
              tenant_id: input.tenant_id,
              name: input.name.trim(),
              slug,
              timezone: input.timezone ?? "America/New_York",
              address: input.address ?? null,
              // Only sent when given: a database without the column keeps working.
              ...(input.country ? { country: input.country } : {}),
              created_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );

      // Default store + payment settings for the new location.
      unwrap(
        await sb.from("store_settings").insert({
          tenant_id: input.tenant_id,
          location_id: location.id,
          currency: "USD",
          tax_rate_bps: 825,
          tip_presets_bps: [1500, 1800, 2000],
          kds_thresholds: { warn_seconds: 300, urgent_seconds: 600 },
          fulfillment: {
            pickup_enabled: true,
            delivery_enabled: false,
            prep_minutes: 20,
            scheduling_lead_minutes: 15,
            scheduling_horizon_days: 5,
            hours: Array.from({ length: 7 }, (_, weekday) => ({
              weekday,
              open: "11:00",
              close: "22:00",
              closed: false,
            })),
            delivery_providers: ["in_house_manual"],
            pickup_address: input.address ?? undefined,
            delivery_zones: [],
          },
        }),
      );
      unwrap(
        await sb.from("payment_settings").insert({
          tenant_id: input.tenant_id,
          location_id: location.id,
          currency: "USD",
          platform_fee_bps: 250,
          platform_fee_flat_cents: 10,
          tip_presets_bps: [1500, 1800, 2000],
        }),
      );

      return location;
    },

    async importStarterMenu(tenantId) {
      const existing = unwrap(
        await sb
          .from("menu_categories")
          .select("id")
          .eq("tenant_id", tenantId)
          .limit(1),
      ) as Row[];
      if (existing.length > 0) return;
      const tpl = buildStarterMenu(tenantId);
      unwrap(await sb.from("menu_categories").insert(tpl.categories).select());
      unwrap(await sb.from("menu_items").insert(tpl.items).select());
      unwrap(await sb.from("item_sizes").insert(tpl.sizes).select());
      unwrap(
        await sb.from("modifier_groups").insert(tpl.modifierGroups).select(),
      );
      unwrap(await sb.from("modifiers").insert(tpl.modifiers).select());
      unwrap(
        await sb
          .from("item_modifier_groups")
          .insert(tpl.itemModifierGroups)
          .select(),
      );
    },

    // -- Onboarding --------------------------------------------------------
    async getOnboarding(tenantId) {
      const r = unwrap(
        await sb
          .from("tenant_onboarding")
          .select("*")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapOnboarding(r) : null;
    },

    async completeOnboardingStep(tenantId, step) {
      const now = nowIso();
      const existing = await this.getOnboarding(tenantId);
      const base: TenantOnboarding = existing ?? {
        tenant_id: tenantId,
        current_step: "business",
        completed_steps: [],
        live: false,
        created_at: now,
        updated_at: now,
      };
      const completed = base.completed_steps.includes(step)
        ? base.completed_steps
        : [...base.completed_steps, step];
      const next =
        ONBOARDING_STEPS.find((s) => !completed.includes(s)) ?? "go_live";
      const updated = mapOnboarding(
        unwrap(
          await sb
            .from("tenant_onboarding")
            .upsert({
              tenant_id: tenantId,
              current_step: next,
              completed_steps: completed,
              live: base.live,
              created_at: base.created_at,
              updated_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );
      return updated;
    },

    async goLive(tenantId) {
      const ob = await this.completeOnboardingStep(tenantId, "go_live");
      const updated = mapOnboarding(
        unwrap(
          await sb
            .from("tenant_onboarding")
            .update({ live: true, updated_at: nowIso() })
            .eq("tenant_id", tenantId)
            .select()
            .single(),
        ) as Row,
      );
      await sb.from("tenants").update({ status: "active" }).eq("id", tenantId);
      return { ...ob, ...updated };
    },

    // -- Subscriptions -----------------------------------------------------
    async getSubscription(tenantId) {
      const r = unwrap(
        await sb
          .from("subscriptions")
          .select("*")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapSubscription(r) : null;
    },

    async upsertSubscription(sub) {
      const existing = await this.getSubscription(sub.tenant_id);
      const merged = mapSubscription(
        unwrap(
          await sb
            .from("subscriptions")
            .upsert({
              ...sub,
              created_at: existing?.created_at ?? sub.created_at ?? nowIso(),
              updated_at: nowIso(),
            })
            .select()
            .single(),
        ) as Row,
      );
      return merged;
    },

    async advanceSubscriptionStatus(tenantId, status) {
      const sub = await this.getSubscription(tenantId);
      if (!sub) return null;
      const updated = mapSubscription(
        unwrap(
          await sb
            .from("subscriptions")
            .update({
              status,
              current_period_end:
                status === "active"
                  ? new Date(Date.now() + 30 * 86_400_000).toISOString()
                  : sub.current_period_end,
              trial_end: status === "active" ? null : sub.trial_end,
              updated_at: nowIso(),
            })
            .eq("tenant_id", tenantId)
            .select()
            .single(),
        ) as Row,
      );
      return updated;
    },

    async changeSubscriptionTier(tenantId, tier) {
      const sub = await this.getSubscription(tenantId);
      if (!sub) return null;
      const updated = mapSubscription(
        unwrap(
          await sb
            .from("subscriptions")
            .update({ tier, updated_at: nowIso() })
            .eq("tenant_id", tenantId)
            .select()
            .single(),
        ) as Row,
      );
      return updated;
    },

    async getPendingBillingCheckout(tenantId) {
      const r = unwrap(
        await sb
          .from("billing_checkout_sessions")
          .select("*")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapPendingBillingCheckout(r) : null;
    },

    async claimPendingBillingCheckout(rec) {
      // Drop an EXPIRED record first, then insert on the tenant_id primary
      // key: of two concurrent claims exactly one insert wins; the loser gets
      // a unique violation and reads the winner.
      unwrap(
        await sb
          .from("billing_checkout_sessions")
          .delete()
          .eq("tenant_id", rec.tenant_id)
          .lte("expires_at", nowIso())
          .select("tenant_id"),
      );
      const ins = await sb
        .from("billing_checkout_sessions")
        .insert(rec)
        .select()
        .single();
      if (!ins.error) {
        return { claimed: true, current: mapPendingBillingCheckout(ins.data as Row) };
      }
      if ((ins.error as { code?: string }).code !== "23505") {
        throw new Error(`Supabase: ${ins.error.message}`);
      }
      const current = await this.getPendingBillingCheckout(rec.tenant_id);
      if (!current) throw new Error("Supabase: billing checkout claim raced");
      return { claimed: false, current };
    },

    async clearPendingBillingCheckout(tenantId, sessionId) {
      unwrap(
        await sb
          .from("billing_checkout_sessions")
          .delete()
          .eq("tenant_id", tenantId)
          .eq("session_id", sessionId)
          .select("tenant_id"),
      );
    },

    // -- Platform admin + health -------------------------------------------
    async isPlatformAdmin(userId) {
      const r = unwrap(
        await sb
          .from("platform_admins")
          .select("user_id")
          .eq("user_id", userId)
          .maybeSingle(),
      ) as Row | null;
      return r !== null;
    },

    async listPlatformAdmins() {
      return (
        unwrap(await sb.from("platform_admins").select("*")) as Row[]
      ).map((r) => ({
        user_id: r.user_id as string,
        created_at: r.created_at as string,
      }));
    },

    async getUser(userId) {
      const r = unwrap(
        await sb.from("users").select("*").eq("id", userId).maybeSingle(),
      ) as Row | null;
      return r ? mapUser(r) : null;
    },

    async getUserEmails(userIds) {
      const out = new Map<string, string>();
      const ids = [...new Set(userIds)];
      for (let i = 0; i < ids.length; i += 100) {
        const rows = unwrap(
          await sb.from("users").select("id,email").in("id", ids.slice(i, i + 100)),
        ) as Row[];
        for (const r of rows) out.set(r.id as string, r.email as string);
      }
      return out;
    },

    async getUserByEmail(email) {
      const r = unwrap(
        await sb
          .from("users")
          .select("*")
          .ilike("email", email.trim())
          .maybeSingle(),
      ) as Row | null;
      return r ? mapUser(r) : null;
    },

    async listMembershipsForUser(userId) {
      return (
        unwrap(
          await sb.from("memberships").select("*").eq("user_id", userId),
        ) as Row[]
      ).map((r) => ({
        id: r.id as string,
        user_id: r.user_id as string,
        tenant_id: r.tenant_id as string,
        role: r.role as Membership["role"],
        created_at: r.created_at as string,
      }));
    },

    async listTenantHealth() {
      const tenantsList = await this.listTenants();
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const out: TenantHealth[] = [];
      for (const t of tenantsList) {
        const locs = unwrap(
          await sb.from("locations").select("id").eq("tenant_id", t.id),
        ) as Row[];
        const recent = unwrap(
          await sb
            .from("orders")
            .select("totals,status")
            .eq("tenant_id", t.id)
            .not("status", "in", "(voided,awaiting_payment,abandoned)")
            .gte("created_at", since),
        ) as Row[];
        const connect = await this.getConnectAccount(t.id);
        out.push({
          tenant_id: t.id,
          name: t.name,
          slug: t.slug,
          status: t.status,
          location_count: locs.length,
          recent_order_count: recent.length,
          recent_gross_cents: recent.reduce(
            (sum, o) =>
              sum +
              ((o.totals as { total_cents?: number } | null)?.total_cents ?? 0),
            0,
          ),
          subscription: await this.getSubscription(t.id),
          onboarding: await this.getOnboarding(t.id),
          connected: isConnectedForHealth(connect),
        });
      }
      return out;
    },

    // -- Audit log ---------------------------------------------------------
    async appendAuditLog(entry) {
      return mapAudit(
        unwrap(
          await sb
            .from("audit_log")
            .insert({ ...entry, id: genUuid(), created_at: nowIso() })
            .select()
            .single(),
        ) as Row,
      );
    },

    async listAuditLog(tenantId) {
      let q = sb
        .from("audit_log")
        .select("*")
        .order("created_at", { ascending: false });
      if (tenantId) q = q.eq("tenant_id", tenantId);
      return (unwrap(await q) as Row[]).map(mapAudit);
    },

    // -- Locations + menu read ---------------------------------------------
    async listLocations(tenantId) {
      return (
        unwrap(
          await sb
            .from("locations")
            .select("*")
            .eq("tenant_id", tenantId)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true }),
        ) as Row[]
      ).map(mapLocation);
    },

    async getTenantBySlug(slug) {
      const r = unwrap(
        await sb.from("tenants").select("*").eq("slug", slug).maybeSingle(),
      ) as Row | null;
      return r ? mapTenant(r) : null;
    },

    async getLocationBySlugs(tenantSlug, locationSlug) {
      // tenants.slug is globally unique; locations.slug is unique per tenant
      // (unique (tenant_id, slug)) — so the pair resolves at most one row.
      const tenant = await this.getTenantBySlug(tenantSlug);
      if (!tenant) return null;
      const r = unwrap(
        await sb
          .from("locations")
          .select("*")
          .eq("tenant_id", tenant.id)
          .eq("slug", locationSlug)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapLocation(r) : null;
    },

    async listLocationsBySlug(slug) {
      // NOT maybeSingle(): several tenants may share a location slug.
      return (
        unwrap(
          await sb.from("locations").select("*").eq("slug", slug).limit(50),
        ) as Row[]
      ).map(mapLocation);
    },

    async getMenu(tenantId, locationId, opts) {
      return assembleMenu(tenantId, locationId, opts?.includeUnavailable);
    },

    async getStoreSettings(tenantId, locationId) {
      const r = unwrap(
        await sb
          .from("store_settings")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .maybeSingle(),
      ) as Row | null;
      if (r) return mapStoreSettings(r);
      return {
        tenant_id: tenantId,
        location_id: locationId,
        currency: "USD",
        tax_rate_bps: 0,
        tip_presets_bps: [1500, 1800, 2000],
        kds_thresholds: { warn_seconds: 300, urgent_seconds: 600 },
      };
    },

    async setAdjustmentPolicy(tenantId, locationId, policy) {
      const updated = unwrap(
        await sb
          .from("store_settings")
          .update({ adjustment_policy: policy })
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .select()
          .maybeSingle(),
      ) as Row | null;
      if (updated) return mapStoreSettings(updated);
      // No row yet: create one carrying the same defaults getStoreSettings serves.
      const d = await this.getStoreSettings(tenantId, locationId);
      const inserted = unwrap(
        await sb
          .from("store_settings")
          .upsert({
            tenant_id: tenantId,
            location_id: locationId,
            currency: d.currency,
            tax_rate_bps: d.tax_rate_bps,
            tip_presets_bps: d.tip_presets_bps,
            kds_thresholds: d.kds_thresholds ?? null,
            adjustment_policy: policy,
          })
          .select()
          .single(),
      ) as Row;
      return mapStoreSettings(inserted);
    },

    async listOrderAdjustments(orderId) {
      return (
        unwrap(
          await sb
            .from("order_adjustments")
            .select("*")
            .eq("order_id", orderId)
            .order("created_at")
            .order("id"),
        ) as Row[]
      ).map(mapAdjustmentRecord);
    },

    async listOrderAdjustmentsForOrders(orderIds) {
      if (orderIds.length === 0) return [];
      return (await selectIn("order_adjustments", "order_id", orderIds)).map(mapAdjustmentRecord);
    },

    async beginOrderRefund(record) {
      const out = unwrap(
        await sb.rpc("begin_order_refund", { p_record: record }),
      ) as { outcome: string; record?: Row; line_id?: string; available?: number };
      if (out.outcome === "ok" || out.outcome === "duplicate") {
        return { outcome: out.outcome, record: mapAdjustmentRecord(out.record as Row) };
      }
      if (out.outcome === "exceeds") {
        return {
          outcome: "exceeds",
          line_id: out.line_id ?? "",
          available: out.available ?? 0,
        };
      }
      return { outcome: "not_found" };
    },

    async reopenOrderRefund(orderId, id) {
      const out = unwrap(
        await sb.rpc("reopen_order_refund", { p_order_id: orderId, p_id: id }),
      ) as { outcome: string; record?: Row; line_id?: string; available?: number };
      if (out.outcome === "ok" || out.outcome === "duplicate") {
        return { outcome: out.outcome, record: mapAdjustmentRecord(out.record as Row) };
      }
      if (out.outcome === "exceeds") {
        return { outcome: "exceeds", line_id: out.line_id ?? "", available: out.available ?? 0 };
      }
      return { outcome: "not_found" };
    },

    async claimOrderAdjustment(orderId, id, untilIso) {
      return (
        unwrap(
          await sb.rpc("claim_order_adjustment", {
            p_order_id: orderId,
            p_id: id,
            p_until: untilIso,
          }),
        ) === true
      );
    },

    async listStalePendingRefunds(beforeIso, limit) {
      return (
        unwrap(
          await sb
            .from("order_adjustments")
            .select("*")
            .eq("status", "pending")
            .eq("kind", "refund")
            .lt("updated_at", beforeIso)
            .order("updated_at")
            .limit(Math.min(Math.max(limit, 1), 200)),
        ) as Row[]
      ).map(mapAdjustmentRecord);
    },

    async finishOrderAdjustment(orderId, id, patch) {
      const out = unwrap(
        await sb.rpc("finish_order_adjustment", {
          p_order_id: orderId,
          p_id: id,
          p_status: patch.status,
          p_allocations: patch.allocations,
          p_meta: patch.meta ?? null,
          // Only sent when set: callers that release the claim work against
          // the function before and after 20261114000500.
          ...(patch.keepClaim ? { p_keep_claim: true } : {}),
        }),
      ) as Row | null;
      return out ? mapAdjustmentRecord(out) : null;
    },

    async applyOrderEdit(write) {
      const out = unwrap(
        await sb.rpc("apply_order_edit", { p_write: write }),
      ) as { outcome: string; record?: Row; reason?: string };
      if (out.outcome === "ok") {
        const order = await this.getOrder(write.orderId);
        if (!order) return { outcome: "not_found" };
        return { outcome: "ok", order, record: mapAdjustmentRecord(out.record as Row) };
      }
      if (out.outcome === "duplicate") {
        return { outcome: "duplicate", record: mapAdjustmentRecord(out.record as Row) };
      }
      if (out.outcome === "stale") return { outcome: "stale" };
      if (out.outcome === "invalid_state") {
        return { outcome: "invalid_state", reason: out.reason ?? "invalid" };
      }
      return { outcome: "not_found" };
    },

    async setMarketplaceSettings(tenantId, locationId, marketplace) {
      // Touch ONLY the marketplace column: never rewrite tax/tips/currency from a
      // possibly stale read.
      const updated = unwrap(
        await sb
          .from("store_settings")
          .update({ marketplace })
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .select(),
      ) as Row[];
      if (updated[0]) return mapStoreSettings(updated[0]);
      // No settings row yet: create it from the defaults.
      const base = await this.getStoreSettings(tenantId, locationId);
      const r = unwrap(
        await sb
          .from("store_settings")
          .upsert(
            {
              tenant_id: tenantId,
              location_id: locationId,
              currency: base.currency,
              tax_rate_bps: base.tax_rate_bps,
              tip_presets_bps: base.tip_presets_bps,
              kds_thresholds: base.kds_thresholds ?? null,
              marketplace,
            },
            { onConflict: "tenant_id,location_id", ignoreDuplicates: true },
          )
          .select(),
      ) as Row[];
      return r[0] ? mapStoreSettings(r[0]) : { ...base, marketplace };
    },

    async findMarketplaceLocations(provider, storeId) {
      const rows = unwrap(
        await sb
          .from("marketplace_stores")
          .select("tenant_id,location_id")
          .eq("provider", provider)
          .eq("store_id", storeId)
          .limit(2),
      ) as Row[];
      return rows.map((r) => ({
        tenant_id: r.tenant_id as string,
        location_id: r.location_id as string,
      }));
    },

    async assignMarketplaceStore(input) {
      if (input.storeId === null) {
        unwrap(
          await sb
            .from("marketplace_stores")
            .delete()
            .eq("provider", input.provider)
            .eq("location_id", input.locationId),
        );
        return;
      }
      // ONE upsert on (location_id, provider): it replaces this location's store,
      // and a clash with another location's store id (primary key) fails the whole
      // statement, leaving the old assignment intact.
      const { error } = await sb.from("marketplace_stores").upsert(
        {
          provider: input.provider,
          store_id: input.storeId,
          tenant_id: input.tenantId,
          location_id: input.locationId,
          assigned_by: input.assignedBy ?? null,
          assigned_at: new Date().toISOString(),
        },
        { onConflict: "location_id,provider" },
      );
      if (error) {
        if (error.code === "23505") throw new MarketplaceStoreTakenError();
        throw new Error(error.message);
      }
    },

    async findMarketplaceOrdersByRef(provider, externalId) {
      const rows = unwrap(
        await sb
          .from("orders")
          .select("*")
          .eq("source->>type", "marketplace")
          .eq("source->>module", provider)
          .eq("source->>external_ref", externalId)
          .limit(5),
      ) as Row[];
      return readOrderRows(rows);
    },

    // -- Orders ------------------------------------------------------------
    async createOrder(input) {
      const existingRow = unwrap(
        await sb.from("orders").select("*").eq("id", input.id).maybeSingle(),
      ) as Row | null;
      if (existingRow) return readOrderRow(existingRow);

      const now = nowIso();
      const orderNumber =
        input.order_number ??
        (await nextOrderNumber(input.tenant_id, input.location_id));
      const status = input.status ?? "placed";
      const orderRow = unwrap(
        await sb
          .from("orders")
          .insert({
            id: input.id,
            tenant_id: input.tenant_id,
            location_id: input.location_id,
            status,
            channel: input.channel,
            currency: input.currency,
            discount_cents: input.discount_cents,
            totals: input.totals,
            notes: input.notes,
            order_number: orderNumber,
            customer_id: input.customer_id ?? null,
            staff_id: input.staff_id ?? null,
            fulfillment: input.fulfillment ?? null,
            source: input.source ?? null,
            hold: input.hold ?? null,
            // Only sent when set, so shop and terminal inserts keep working on a
            // database that predates the column.
            ...(input.core_ext ? { core_ext: input.core_ext } : {}),
            // Same: only with comps/discounts (migration 20261113001000).
            ...(input.adjustments?.length ? { adjustments: input.adjustments } : {}),
            created_at: now,
            updated_at: now,
          })
          .select()
          .single(),
      ) as Row;
      // PostgREST has no multi-statement transaction, so the order + its lines
      // are not atomic by themselves. Compensate: if writing the lines fails,
      // delete the order row (its children cascade) so a failed insert can never
      // leave an item-less `placed` order on the KDS, then surface the error.
      // (Chosen over an RPC to avoid a new SQL function + migration that cannot
      // be exercised without a live database; the client's retry is idempotent
      // on the order id, so a clean rollback makes the retry safe.)
      try {
        await writeOrderItems(input.id, input.items);
      } catch (err) {
        const { error: delErr } = await sb
          .from("orders")
          .delete()
          .eq("id", input.id);
        if (delErr) {
          // The rollback itself failed: an item-less order may remain. Log it
          // loudly (and to the error sink) so it can be cleaned up.
          captureError(new Error(`createOrder rollback failed: ${delErr.message}`), {
            scope: "createOrder",
            orderId: input.id,
          });
          console.error(
            `[createOrder] rollback delete failed for order ${input.id}: ${delErr.message}`,
          );
        }
        throw err;
      }
      const order = await readOrderRow(orderRow);
      // An online order awaiting payment (or abandoned) consumes nothing: it is
      // depleted by `depleteInventoryForOrder` once payment finalizes. Held
      // (draft) orders deplete when released (updateOrderStatus).
      if (
        order.status !== "voided" &&
        order.status !== "draft" &&
        !isUnpaidOnlineStatus(order.status)
      ) {
        await depleteForOrder(order);
      }
      return order;
    },

    async getOrder(id) {
      const r = unwrap(
        await sb.from("orders").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? readOrderRow(r) : null;
    },

    async listOrders(tenantId, locationId, opts) {
      // Default 1000 = main's behavior (PostgREST's implicit cap) for callers
      // that pass no limit (reports, EOD); explicit limits are clamped to it.
      const limit = Math.min(Math.max(opts?.limit ?? 1000, 1), 1000);
      const offset = opts?.offset ?? 0;
      let q = sb
        .from("orders")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("location_id", locationId);
      if (opts?.from) q = q.gte("created_at", opts.from);
      if (opts?.to) q = q.lte("created_at", opts.to);
      // Explicit range: never rely on PostgREST's implicit row cap.
      const rows = unwrap(
        await q
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(offset, offset + limit - 1),
      ) as Row[];
      return readOrderRows(rows);
    },

    async listOrderHeads(tenantId, opts) {
      const limit = Math.min(Math.max(opts.limit, 1), 500);
      let q = sb
        .from("orders")
        .select("id,tenant_id,location_id,created_at,status,hold,currency,staff_id,totals")
        .eq("tenant_id", tenantId);
      if (opts.locationIds) q = q.in("location_id", opts.locationIds);
      if (opts.createdFrom) q = q.gte("created_at", opts.createdFrom);
      if (opts.createdTo) q = q.lte("created_at", opts.createdTo);
      if (opts.statuses) q = q.in("status", opts.statuses);
      if (opts.after) {
        const { created_at: c, id } = safeKeyset(opts.after);
        q = q.or(`created_at.gt.${c},and(created_at.eq.${c},id.gt.${id})`);
      }
      const asc = !opts.newestFirst;
      const rows = unwrap(
        await q
          .order("created_at", { ascending: asc })
          .order("id", { ascending: asc })
          .limit(limit),
      ) as Row[];
      return rows.map((r) => ({
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        location_id: r.location_id as string,
        created_at: new Date(r.created_at as string).toISOString(),
        status: r.status as OrderStatus,
        hold: r.hold ?? null,
        currency: r.currency as string,
        staff_id: (r.staff_id as string | null) ?? null,
        totals: r.totals as OrderTotals,
      }));
    },

    async getOrdersByIds(tenantId, ids) {
      const rows: Row[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        rows.push(
          ...(unwrap(
            await sb
              .from("orders")
              .select("*")
              .eq("tenant_id", tenantId)
              .in("id", ids.slice(i, i + 100))
              .order("id")
              .limit(100),
          ) as Row[]),
        );
      }
      return readOrderRows(rows);
    },

    async listRefundedPayments(tenantId, opts) {
      let q = sb
        .from("payments")
        .select("*")
        .eq("tenant_id", tenantId)
        .gt("refunded_cents", 0)
        .gte("updated_at", opts.since);
      if (opts.locationIds) q = q.in("location_id", opts.locationIds);
      const rows = unwrap(
        await q
          .order("updated_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(Math.min(Math.max(opts.limit, 1), 1000)),
      ) as Row[];
      return rows.map(mapPayment);
    },

    async listOrdersPage(tenantId, locationId, opts) {
      const limit = Math.min(Math.max(opts.limit, 1), 500);
      let q = sb
        .from("orders")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("location_id", locationId);
      if (opts.createdFrom) q = q.gte("created_at", opts.createdFrom);
      if (opts.createdTo) q = q.lte("created_at", opts.createdTo);
      if (opts.updatedSince) q = q.gte("updated_at", opts.updatedSince);
      if (opts.after) {
        const { created_at: c, id } = safeKeyset(opts.after);
        q = q.or(`created_at.gt.${c},and(created_at.eq.${c},id.gt.${id})`);
      }
      const rows = unwrap(
        await q
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(limit),
      ) as Row[];
      return readOrderRows(rows);
    },

    async casOrderStatus(id, from, to) {
      const leavingHold = from.includes("draft") && to !== "draft";
      // Compare-and-set in ONE statement: only the caller that still sees a
      // `from` status updates the row (and so owns the side effects).
      const updated = unwrap(
        await sb
          .from("orders")
          .update({
            status: to,
            updated_at: nowIso(),
            ...(leavingHold ? { hold: null } : {}),
          })
          .eq("id", id)
          .in("status", from)
          .select(),
      ) as Row[];
      const row = updated[0];
      if (row) {
        const order = await readOrderRow(row);
        // Only the winner of a draft -> live transition depletes inventory.
        if (leavingHold && isLiveOrderStatus(to)) await depleteForOrder(order);
        return { ok: true, order } as const;
      }
      const current = unwrap(
        await sb.from("orders").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      if (!current) return { ok: false, reason: "not_found" } as const;
      return {
        ok: false,
        reason: "conflict",
        order: await readOrderRow(current),
      } as const;
    },

    async extendOrderHold(id, tenantId, expect, next) {
      // Compare-and-set in ONE statement: only still-held (`draft`) orders whose
      // hold expires exactly when the caller computed from. A concurrent
      // release / cancel / expiry (status moves) or extension (expiry moves)
      // updates zero rows. The orders_core_version trigger bumps `version`.
      let q = sb
        .from("orders")
        .update({ hold: next, updated_at: nowIso() })
        .eq("id", id)
        .eq("tenant_id", tenantId)
        .eq("status", "draft");
      q =
        expect.expires_at === null
          ? q.is("hold->>expires_at", null)
          : q.eq("hold->>expires_at", expect.expires_at);
      const updated = unwrap(await q.select()) as Row[];
      if (updated[0]) {
        return { ok: true, order: await readOrderRow(updated[0]) } as const;
      }
      const current = unwrap(
        await sb.from("orders").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      if (!current || current.tenant_id !== tenantId) {
        return { ok: false, reason: "not_found" } as const;
      }
      return {
        ok: false,
        reason: "conflict",
        order: await readOrderRow(current),
      } as const;
    },

    async cancelOrder(id, tenantId) {
      // One SQL function: lock the order row, check in-flight/captured tenders,
      // void abandoned ones, transition to voided. All or nothing.
      const res = unwrap(
        await sb.rpc("core_cancel_order", { p_order_id: id, p_tenant_id: tenantId }),
      ) as { ok: boolean; reason?: string } | null;
      const row = unwrap(
        await sb.from("orders").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      if (!row || row.tenant_id !== tenantId) return { ok: false, reason: "not_found" } as const;
      const order = await readOrderRow(row);
      if (res?.ok) return { ok: true, order } as const;
      return {
        ok: false,
        reason: (res?.reason ?? "not_cancelable") as "not_cancelable" | "in_flight" | "captured",
        order,
      } as const;
    },

    async listPaymentsForOrders(orderIds) {
      const out = new Map<string, Payment[]>();
      const payRows = await selectIn("payments", "order_id", orderIds);
      payRows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      for (const r of payRows) {
        const p = mapPayment(r);
        const list = out.get(p.order_id) ?? [];
        list.push(p);
        out.set(p.order_id, list);
      }
      return out;
    },

    async getCustomers(ids) {
      return (await selectIn("customers", "id", ids)).map(mapCustomer);
    },

    async customerOrderStats(tenantId, customerIds) {
      const out = new Map<
        string,
        { order_count: number; last_order_at: string | null; lifetime_spend_cents: number }
      >();
      for (let i = 0; i < customerIds.length; i += 100) {
        const chunk = customerIds.slice(i, i + 100);
        const rows = await fetchAllPages<Row>(async (from, to) =>
          unwrap(
            await sb
              .from("orders")
              .select("id,customer_id,totals,created_at,status")
              .eq("tenant_id", tenantId)
              .in("customer_id", chunk)
              .not("status", "in", "(voided,draft)")
              .order("customer_id")
              .order("id")
              .range(from, to),
          ) as Row[],
        );
        for (const r of rows) {
          const id = r.customer_id as string;
          const st = out.get(id) ?? { order_count: 0, last_order_at: null, lifetime_spend_cents: 0 };
          st.order_count += 1;
          st.lifetime_spend_cents += (r.totals as { total_cents?: number })?.total_cents ?? 0;
          const at = r.created_at as string;
          if (!st.last_order_at || at > st.last_order_at) st.last_order_at = at;
          out.set(id, st);
        }
      }
      return out;
    },

    async listStaffWithPin(tenantId) {
      const rows = unwrap(
        await sb
          .from("staff")
          .select("id")
          .eq("tenant_id", tenantId)
          .not("pin_hash", "is", null),
      ) as Row[];
      return new Set(rows.map((r) => r.id as string));
    },

    async updateOrderStatus(id, status) {
      const before = unwrap(
        await sb.from("orders").select("status").eq("id", id).maybeSingle(),
      ) as Row | null;
      if (!before) return null;
      const prior = before.status as OrderStatus;
      // CAS on the status we read: a concurrent writer that already moved the
      // order makes this a no-op returning the current row (and, crucially,
      // does NOT deplete inventory a second time).
      const res = await this.casOrderStatus(id, [prior], status);
      if (res.ok) return res.order;
      return res.reason === "conflict" ? res.order : null;
    },

    async transitionOrderStatus(id, from, to, patch) {
      // Compare-and-set: the WHERE clause is the lock. Zero rows back means
      // another caller already moved the order out of `from`.
      const cas = async (statuses: OrderStatus[], extra: Row) =>
        unwrap(
          await sb
            .from("orders")
            .update({
              status: to,
              ...(patch?.fulfillment ? { fulfillment: patch.fulfillment } : {}),
              ...extra,
              updated_at: nowIso(),
            })
            .eq("id", id)
            .in("status", statuses)
            .select()
            .maybeSingle(),
        ) as Row | null;
      // Leaving a hold (main's settlement moves `["draft","placed"] -> "paid"`):
      // try the `draft` CAS first so the winner KNOWS it left a hold. It clears
      // `hold` and, for a live target, depletes the stock a held order never
      // consumed (per-item idempotent), exactly like casOrderStatus.
      if (from.includes("draft") && to !== "draft") {
        const r = await cas(["draft"], { hold: null });
        if (r) {
          const order = await readOrderRow(r);
          if (isLiveOrderStatus(to)) await depleteForOrder(order);
          return order;
        }
        const rest = from.filter((s) => s !== "draft");
        if (rest.length === 0) return null;
        const r2 = await cas(rest, {});
        return r2 ? readOrderRow(r2) : null;
      }
      const r = await cas(from, {});
      return r ? readOrderRow(r) : null;
    },

    async depleteInventoryForOrder(orderId) {
      const r = unwrap(
        await sb.from("orders").select("*").eq("id", orderId).maybeSingle(),
      ) as Row | null;
      if (!r) return;
      await depleteForOrder(await readOrderRow(r)); // per-item idempotent
    },

    async listAwaitingPaymentOrders(createdBefore, opts) {

      let q = sb
        .from("orders")
        .select("*")
        .eq("status", "awaiting_payment")
        .lt("created_at", createdBefore);
      if (opts?.after) {
        q = q.or(
          `created_at.gt.${opts.after.created_at},and(created_at.eq.${opts.after.created_at},id.gt.${opts.after.id})`,
        );
      }
      if (opts?.checkoutMode) {
        // Filter in SQL: other deployments' orders are never even scanned.
        q = q.or(
          `fulfillment->>checkout_mode.eq.${opts.checkoutMode},fulfillment->>checkout_mode.is.null`,
        );
      }
      if (opts?.foreignOf) {
        q = q
          .not("fulfillment->>checkout_mode", "is", null)
          .neq("fulfillment->>checkout_mode", opts.foreignOf)
          .is("fulfillment->>foreign_alerted_at", null);
      }
      const rows = unwrap(
        await q
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(opts?.limit ?? 1000),
      ) as Row[];
      return Promise.all(rows.map((r) => readOrderRow(r)));
    },

    async listUnfinalizedPaidOrders(paidBefore, limit = 100, asOf = nowIso()) {
      const rows = unwrap(
        await sb
          .from("orders")
          .select("*")
          .in("status", ["paid", "in_kitchen", "ready", "recall", "out_for_delivery"])
          .not("fulfillment->>paid_at", "is", null)
          .lt("fulfillment->>paid_at", paidBefore)
          .is("fulfillment->>finalized_at", null)
          .or(`fulfillment->>recovery_next_at.is.null,fulfillment->>recovery_next_at.lte.${asOf}`)
          .order("fulfillment->>paid_at", { ascending: true })
          .limit(limit),
      ) as Row[];
      return Promise.all(rows.map((r) => readOrderRow(r)));
    },

    // Atomic (one UPDATE inside the RPC): no read-modify-write window.
    async mergeOrderFulfillment(id, patch) {
      const rows = unwrap(
        await sb.rpc("merge_order_fulfillment", {
          p_order_id: id,
          p_patch: patch,
        }),
      ) as Row[] | null;
      const r = rows?.[0];
      return r ? readOrderRow(r) : null;
    },

    async claimLatePayment(orderId, claim, staleBeforeIso) {
      const rows = unwrap(
        await sb.rpc("claim_late_payment", {
          p_order_id: orderId,
          p_claim: claim,
          p_stale_before: staleBeforeIso,
        }),
      ) as Row[] | null;
      const r = rows?.[0];
      return r ? readOrderRow(r) : null;
    },

    async updateLatePayment(orderId, patch) {
      const rows = unwrap(
        await sb.rpc("update_late_payment", {
          p_order_id: orderId,
          p_patch: patch,
        }),
      ) as Row[] | null;
      const r = rows?.[0];
      return r ? readOrderRow(r) : null;
    },

    async listOpenLatePayments(tenantId, locationId, limit = 100) {
      const rows = unwrap(
        await sb
          .from("orders")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .not("fulfillment->late_payment", "is", null)
          .or(
            "fulfillment->late_payment->>resolved.is.null,fulfillment->late_payment->>resolved.eq.refund_owed_manual",
          )
          .order("updated_at", { ascending: false })
          .limit(limit),
      ) as Row[];
      return Promise.all(rows.map((r) => readOrderRow(r)));
    },

    // -- Payments ----------------------------------------------------------
    async getPaymentSettings(tenantId, locationId) {
      const r = unwrap(
        await sb
          .from("payment_settings")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .maybeSingle(),
      ) as Row | null;
      if (r) return mapPaymentSettings(r);
      return {
        tenant_id: tenantId,
        location_id: locationId,
        currency: "USD",
        platform_fee_bps: 250,
        platform_fee_flat_cents: 10,
        tip_presets_bps: [1500, 1800, 2000],
      };
    },

    async upsertPayment(payment) {
      const existing = unwrap(
        await sb
          .from("payments")
          .select("created_at")
          .eq("id", payment.id)
          .maybeSingle(),
      ) as Row | null;
      const now = nowIso();
      // Refund bookkeeping (refunded_cents, refund_ids, a `refunded` status) is
      // owned by the atomic reserve/release RPCs. A whole-row upsert from a stale
      // snapshot must never overwrite it on an existing tender.
      // tip_refunded_cents is never written here (the column defaults to 0 on
      // insert; only the reserve/release RPCs move it).
      const {
        tip_refunded_cents: _tr,
        refund_reserved_cents: _rr,
        ...insertable
      } = payment;
      void _tr;
      void _rr;
      const {
        refunded_cents: _rc,
        refund_ids: _ri,
        refunds: _rf,
        ...writable
      } = insertable;
      void _rc;
      void _ri;
      void _rf;
      const res = await sb
        .from("payments")
        .upsert({
          ...(existing ? writable : insertable),
          created_at:
            (existing?.created_at as string) ?? payment.created_at ?? now,
          updated_at: now,
        })
        .select()
        .single();
      // A second live card/Coinbase tender for one order trips the partial
      // unique index payments_one_live_card_or_cb.
      if (
        res.error?.message.includes("payments_one_live_card_or_cb") ||
        res.error?.message.includes("payments_one_live_terminal")
      ) {
        throw new LiveTenderConflictError();
      }
      return mapPayment(unwrap(res) as Row);
    },

    async linkTenderSession(tenantId, paymentId, sessionId) {
      const out = unwrap(
        await sb.rpc("core_link_tender_session", {
          p_tenant_id: tenantId,
          p_payment_id: paymentId,
          p_session_id: sessionId,
        }),
      ) as { outcome: string; payment?: Row; status?: string };
      if (out.outcome === "ok") {
        return { ok: true, payment: mapPayment(out.payment as Row) } as const;
      }
      if (out.outcome === "not_open") {
        return { ok: false, reason: "not_open", status: out.status ?? "" } as const;
      }
      return { ok: false, reason: "not_found" } as const;
    },

    async recordExternalTender(input) {
      const out = unwrap(
        await sb.rpc("core_record_external_tender", {
          p_tenant_id: input.tenantId,
          p_order_id: input.orderId,
          p_id: input.paymentId,
          p_method: input.method,
          p_processor: input.processor,
          p_processor_ref: input.processorRef,
          p_amount: input.amountCents,
          p_tip: input.tipCents,
          p_status: input.status,
          p_requested_status: input.requestedStatus,
          p_collection: input.collection,
          p_staff_id: input.staffId,
          p_expect: input.expect,
          p_recorded_by: input.recordedBy,
        }),
      ) as {
        outcome: string;
        payment?: Row;
        superseded?: string[];
        status?: string;
      };
      switch (out.outcome) {
        case "ok":
          return {
            outcome: "ok",
            payment: mapPayment(out.payment as Row),
            superseded: out.superseded ?? [],
          } as const;
        case "exists":
        case "duplicate_ref":
          return {
            outcome: out.outcome,
            payment: mapPayment(out.payment as Row),
          } as const;
        case "invalid_state":
          return { outcome: "invalid_state", status: out.status ?? "" } as const;
        case "not_found":
        case "stale":
          return { outcome: out.outcome } as const;
        default:
          throw new Error(`core_record_external_tender: unexpected outcome ${out.outcome}`);
      }
    },

    async reservePaymentRefund(paymentId, amountCents, refundId, meta) {
      const out = unwrap(
        await sb.rpc("reserve_payment_refund", {
          p_payment_id: paymentId,
          p_amount: amountCents,
          p_refund_id: refundId,
          p_processor_ref: meta?.processorRef ?? null,
          p_reason: meta?.reason ?? null,
          // Only sent when set (an explicit tip split needs migration
          // 20261113001000; without it the legacy tip-first rule applies).
          ...(typeof meta?.tipCents === "number" ? { p_tip_amount: meta.tipCents } : {}),
          ...(meta?.pending ? { p_pending: true } : {}),
          ...(typeof meta?.covering === "boolean" ? { p_covering: meta.covering } : {}),
        }),
      ) as { outcome: string; payment?: Row; refund_entry_id?: string };
      const payment = out.payment ? mapPayment(out.payment) : null;
      if (out.outcome === "ok" && payment) {
        return { ok: true, payment, refundEntryId: out.refund_entry_id };
      }
      const reason =
        out.outcome === "duplicate" || out.outcome === "not_found"
          ? out.outcome
          : "exceeds";
      return { ok: false, reason, payment };
    },

    async confirmPaymentRefund(paymentId, refundId, processorRef) {
      const out = unwrap(
        await sb.rpc("confirm_payment_refund", {
          p_payment_id: paymentId,
          p_refund_id: refundId,
          p_processor_ref: processorRef,
        }),
      ) as Row | null;
      return out ? mapPayment(out) : null;
    },

    async listCardTendersWithOpenRefunds(tenantId, locationId, limit) {
      const cap = Math.min(Math.max(limit, 1), 200);
      const base = () => {
        let q = sb
          .from("payments")
          .select("*")
          .eq("tenant_id", tenantId)
          .in("rail", ["stripe_terminal", "stripe_online"])
          .eq("simulated", false);
        if (locationId) q = q.eq("location_id", locationId);
        return q;
      };
      const [pending, noRef] = await Promise.all([
        base().gt("refund_reserved_cents", 0).order("updated_at", { ascending: false }).limit(cap),
        base()
          .contains("refunds", '[{"processor_ref":null}]')
          .order("updated_at", { ascending: false })
          .limit(cap),
      ]);
      const byId = new Map<string, Payment>();
      for (const r of [...(unwrap(pending) as Row[]), ...(unwrap(noRef) as Row[])]) {
        const p = mapPayment(r);
        byId.set(p.id, p);
      }
      return [...byId.values()]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, cap);
    },

    async releasePendingPaymentRefund(paymentId, refundId, opts) {
      return (
        unwrap(
          await sb.rpc("release_pending_payment_refund", {
            p_payment_id: paymentId,
            p_refund_id: refundId,
            p_tombstone: opts?.tombstone ?? false,
          }),
        ) === true
      );
    },

    async takePaymentRefundLock(paymentId, owner, untilIso) {
      return (
        unwrap(
          await sb.rpc("take_payment_refund_lock", {
            p_payment_id: paymentId,
            p_owner: owner,
            p_until: untilIso,
          }),
        ) === true
      );
    },

    async releasePaymentRefundLock(paymentId, owner) {
      unwrap(
        await sb.rpc("release_payment_refund_lock", { p_payment_id: paymentId, p_owner: owner }),
      );
    },

    async setRefundProcessorRef(paymentId, requestId, processorRef) {
      return (
        unwrap(
          await sb.rpc("set_payment_refund_ref", {
            p_payment_id: paymentId,
            p_request_id: requestId,
            p_processor_ref: processorRef,
          }),
        ) === true
      );
    },

    async releasePaymentRefund(paymentId, amountCents, refundId, opts) {
      unwrap(
        await sb.rpc("release_payment_refund", {
          p_payment_id: paymentId,
          p_amount: amountCents,
          p_refund_id: refundId,
          p_tombstone: opts?.tombstone ?? false,
        }),
      );
    },

    async getPayment(id) {
      const r = unwrap(
        await sb.from("payments").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapPayment(r) : null;
    },

    async getPaymentByChargeId(chargeId) {
      const r = unwrap(
        await sb
          .from("payments")
          .select("*")
          .eq("charge_id", chargeId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapPayment(r) : null;
    },

    async listPaymentsForOrder(orderId) {
      return (
        unwrap(
          await sb
            .from("payments")
            .select("*")
            .eq("order_id", orderId)
            .order("created_at"),
        ) as Row[]
      ).map(mapPayment);
    },

    // -- /v1 payment sessions + stored quotes --------------------------------
    async insertPaymentSession(row) {
      const res = await sb.from("payment_sessions").insert(row).select().single();
      if (res.error) {
        const msg = res.error.message;
        if (msg.includes("payment_sessions_one_open_per_order")) {
          throw new PaymentSessionConflictError("open");
        }
        if (
          msg.includes("idempotency_key") ||
          msg.includes("stripe_session_id") ||
          res.error.code === "23505"
        ) {
          throw new PaymentSessionConflictError("key");
        }
      }
      return mapPaymentSession(unwrap(res) as Row);
    },

    async getPaymentSession(id) {
      const r = unwrap(
        await sb.from("payment_sessions").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapPaymentSession(r) : null;
    },

    async getPaymentSessionByKey(tenantId, idempotencyKey) {
      const r = unwrap(
        await sb
          .from("payment_sessions")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapPaymentSession(r) : null;
    },

    async getPaymentSessionByStripeId(stripeSessionId) {
      const r = unwrap(
        await sb
          .from("payment_sessions")
          .select("*")
          .eq("stripe_session_id", stripeSessionId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapPaymentSession(r) : null;
    },

    async getOpenPaymentSessionForOrder(orderId) {
      const r = unwrap(
        await sb
          .from("payment_sessions")
          .select("*")
          .eq("order_id", orderId)
          .eq("status", "open")
          .maybeSingle(),
      ) as Row | null;
      return r ? mapPaymentSession(r) : null;
    },

    async updatePaymentSession(id, patch) {
      // Status only ever leaves `open` (one UPDATE; the WHERE is the lock). Other
      // fields (url, stripe id, expiry) are only patched on an open session.
      const { status, ...rest } = patch;
      const changes: Row = { ...rest, updated_at: nowIso() };
      if (status !== undefined) changes.status = status;
      const updated = unwrap(
        await sb
          .from("payment_sessions")
          .update(changes)
          .eq("id", id)
          .eq("status", "open")
          .select()
          .maybeSingle(),
      ) as Row | null;
      if (updated) return mapPaymentSession(updated);
      // Not open any more (or missing): a `payment_id` may still be recorded on a
      // session that just completed.
      if (rest.payment_id !== undefined) {
        const r = unwrap(
          await sb
            .from("payment_sessions")
            .update({ payment_id: rest.payment_id, updated_at: nowIso() })
            .eq("id", id)
            .is("payment_id", null)
            .select()
            .maybeSingle(),
        ) as Row | null;
        if (r) return mapPaymentSession(r);
      }
      return this.getPaymentSession(id);
    },

    async publishAllergens(tenantId, input) {
      const out = unwrap(
        await sb.rpc("core_publish_allergens", {
          p_tenant_id: tenantId,
          p_version: input.version,
          p_payload_hash: input.payload_hash,
          p_location_ids: input.location_ids,
          p_published_by: input.published_by,
          p_rows: input.rows,
        }),
      ) as { outcome: string; publication?: Row; ids?: string[] };
      switch (out.outcome) {
        case "ok":
        case "replay":
          return {
            outcome: out.outcome,
            publication: mapAllergenPublication(out.publication as Row),
          } as const;
        case "conflict":
          return { outcome: "conflict" } as const;
        case "unknown_target":
        case "unknown_location":
        case "duplicate":
          return { outcome: out.outcome, ids: out.ids ?? [] } as const;
        default:
          throw new Error(`core_publish_allergens: unexpected outcome ${out.outcome}`);
      }
    },

    async getAllergenPublication(tenantId, id) {
      const r = unwrap(
        await sb
          .from("menu_allergen_publications")
          .select("*")
          .eq("id", id)
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapAllergenPublication(r) : null;
    },

    async saveQuote(quote) {
      unwrap(
        await sb.from("core_quotes").upsert({
          id: quote.id,
          tenant_id: quote.tenant_id,
          location_id: quote.location_id,
          request: quote.request,
          quote_hash: quote.quote_hash,
          expires_at: quote.expires_at,
          created_at: quote.created_at,
        }),
      );
    },

    async getQuote(tenantId, id) {
      const r = unwrap(
        await sb
          .from("core_quotes")
          .select("*")
          .eq("id", id)
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      return r
        ? {
            id: r.id as string,
            tenant_id: r.tenant_id as string,
            location_id: r.location_id as string,
            request: r.request as Record<string, unknown>,
            quote_hash: r.quote_hash as string,
            expires_at: new Date(r.expires_at as string).toISOString(),
            created_at: new Date(r.created_at as string).toISOString(),
          }
        : null;
    },

    async pruneExpiredQuotes(before) {
      const rows = unwrap(
        await sb.from("core_quotes").delete().lt("expires_at", before).select("id"),
      ) as Row[];
      return rows.length;
    },

    async listExpiredHolds(now, opts) {
      let q = sb
        .from("orders")
        .select("*")
        .eq("status", "draft")
        .in("hold->>reason", ["awaiting_payment", "scheduled"])
        .lt("hold->>expires_at", now);
      if (opts?.after) {
        q = q.or(
          `created_at.gt.${opts.after.created_at},and(created_at.eq.${opts.after.created_at},id.gt.${opts.after.id})`,
        );
      }
      if (opts?.checkoutMode) {
        q = q.or(
          `fulfillment->>checkout_mode.eq.${opts.checkoutMode},fulfillment->>checkout_mode.is.null`,
        );
      }
      if (opts?.foreignOf) {
        q = q
          .not("fulfillment->>checkout_mode", "is", null)
          .neq("fulfillment->>checkout_mode", opts.foreignOf)
          .is("fulfillment->>foreign_alerted_at", null);
      }
      const rows = unwrap(
        await q
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(opts?.limit ?? 1000),
      ) as Row[];
      return Promise.all(rows.map((r) => readOrderRow(r)));
    },

    // -- Stripe Connect ----------------------------------------------------
    async getConnectAccount(tenantId) {
      const r = unwrap(
        await sb
          .from("connect_accounts")
          .select("*")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapConnect(r) : null;
    },

    async getConnectAccountByAccountId(accountId) {
      const r = unwrap(
        await sb
          .from("connect_accounts")
          .select("*")
          .eq("account_id", accountId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapConnect(r) : null;
    },

    async upsertConnectAccount(account) {
      const existing = await this.getConnectAccount(account.tenant_id);
      assertNoSimulatedOverwrite(existing, account);
      return mapConnect(
        unwrap(
          await sb
            .from("connect_accounts")
            .upsert({
              ...account,
              created_at: existing?.created_at ?? account.created_at,
              updated_at: nowIso(),
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    // -- Stripe Terminal ---------------------------------------------------
    async getTerminalLocation(locationId) {
      const r = unwrap(
        await sb
          .from("terminal_locations")
          .select("*")
          .eq("location_id", locationId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapTerminalLocation(r) : null;
    },

    async upsertTerminalLocation(row) {
      const existing = await this.getTerminalLocation(row.location_id);
      return mapTerminalLocation(
        unwrap(
          await sb
            .from("terminal_locations")
            .upsert({
              ...row,
              created_at: existing?.created_at ?? row.created_at,
              updated_at: nowIso(),
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async listTerminalReaders(tenantId, locationId) {
      return (
        unwrap(
          await sb
            .from("terminal_readers")
            .select("*")
            .eq("tenant_id", tenantId)
            .eq("location_id", locationId)
            .order("created_at"),
        ) as Row[]
      ).map(mapTerminalReader);
    },

    async getTerminalReader(id) {
      const r = unwrap(
        await sb.from("terminal_readers").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapTerminalReader(r) : null;
    },

    async upsertTerminalReader(row) {
      const existing = await this.getTerminalReader(row.id);
      return mapTerminalReader(
        unwrap(
          await sb
            .from("terminal_readers")
            .upsert({
              ...row,
              created_at: existing?.created_at ?? row.created_at,
              updated_at: nowIso(),
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async deleteTerminalReader(id) {
      unwrap(await sb.from("terminal_readers").delete().eq("id", id));
    },

    // -- Network printing ----------------------------------------------------

    async listPrinters(tenantId, locationId) {
      return (
        unwrap(
          await sb
            .from("print_printers")
            .select("*")
            .eq("tenant_id", tenantId)
            .eq("location_id", locationId)
            .order("created_at"),
        ) as Row[]
      ).map(mapPrinter);
    },

    async getPrinter(id) {
      const r = unwrap(
        await sb.from("print_printers").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapPrinter(r) : null;
    },

    async createPrinter(row) {
      return mapPrinter(
        unwrap(
          await sb
            .from("print_printers")
            .insert({ ...row, id: genUuid(), created_at: nowIso() })
            .select()
            .single(),
        ) as Row,
      );
    },

    async deletePrinter(tenantId, id) {
      const rows = unwrap(
        await sb
          .from("print_printers")
          .delete()
          .eq("id", id)
          .eq("tenant_id", tenantId)
          .select("id"),
      ) as Row[];
      return rows.length > 0;
    },

    async setPrinterTokenHash(tenantId, id, tokenHash) {
      const rows = unwrap(
        await sb
          .from("print_printers")
          .update({ token_hash: tokenHash })
          .eq("id", id)
          .eq("tenant_id", tenantId)
          .select(),
      ) as Row[];
      return rows[0] ? mapPrinter(rows[0]) : null;
    },

    async touchPrinter(id, at) {
      unwrap(await sb.from("print_printers").update({ last_seen_at: at }).eq("id", id));
    },

    async getPrintSettings(locationId) {
      const r = unwrap(
        await sb
          .from("print_location_settings")
          .select("*")
          .eq("location_id", locationId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapPrintSettings(r) : null;
    },

    async setPrintAutoPrint(tenantId, locationId, autoPrint) {
      return mapPrintSettings(
        unwrap(
          await sb
            .from("print_location_settings")
            .upsert({
              location_id: locationId,
              tenant_id: tenantId,
              auto_print: autoPrint,
              updated_at: nowIso(),
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async enqueuePrintJob(job) {
      if (job.dedupe_key) {
        // Unique (printer_id, dedupe_key): a concurrent duplicate loses the
        // insert and falls through to the lookup, so a retried fire prints once.
        const ins = await sb
          .from("print_jobs")
          .insert({ ...job, id: genUuid(), status: "queued", created_at: nowIso() })
          .select()
          .single();
        if (!ins.error) return mapPrintJob(ins.data as Row);
        const dup = unwrap(
          await sb
            .from("print_jobs")
            .select("*")
            .eq("printer_id", job.printer_id)
            .eq("dedupe_key", job.dedupe_key)
            .maybeSingle(),
        ) as Row | null;
        if (!dup) throw new Error(`Supabase: ${ins.error.message}`);
        return mapPrintJob(dup);
      }
      return mapPrintJob(
        unwrap(
          await sb
            .from("print_jobs")
            .insert({ ...job, id: genUuid(), status: "queued", created_at: nowIso() })
            .select()
            .single(),
        ) as Row,
      );
    },

    async expirePrintJobs(printerId, now) {
      const rows = unwrap(
        await sb
          .from("print_jobs")
          .update({ status: "expired" })
          .eq("printer_id", printerId)
          .in("status", ["queued", "sent"])
          .lte("expires_at", now)
          .select("id"),
      ) as Row[];
      return rows.length;
    },

    async claimPrintJob(printerId, now, reclaimBefore) {
      // Select the oldest candidate, then claim it with a conditional update
      // (status still claimable). Losing the race returns no row; try the next.
      for (let i = 0; i < 3; i++) {
        const cand = unwrap(
          await sb
            .from("print_jobs")
            .select("*")
            .eq("printer_id", printerId)
            .gt("expires_at", now)
            .or(`and(status.eq.queued,or(retry_after.is.null,retry_after.lte.${now})),and(status.eq.sent,claimed_at.lte.${reclaimBefore})`)
            .order("created_at")
            .limit(1),
        ) as Row[];
        if (cand.length === 0) return null;
        const c = cand[0]!;
        const won = unwrap(
          await sb
            .from("print_jobs")
            .update({
              status: "sent",
              attempts: ((c.attempts as number) ?? 0) + 1,
              claimed_at: now,
            })
            .eq("id", c.id as string)
            .eq("printer_id", printerId)
            .eq("status", c.status as string)
            .eq("attempts", (c.attempts as number) ?? 0)
            .select(),
        ) as Row[];
        if (won.length > 0) return mapPrintJob(won[0]!);
      }
      return null;
    },

    async hasPrintJobForOrder(printerId, orderId) {
      const rows = unwrap(
        await sb
          .from("print_jobs")
          .select("id")
          .eq("printer_id", printerId)
          .eq("order_id", orderId)
          .limit(1),
      ) as Row[];
      return rows.length > 0;
    },

    async retryFailedPrintJobs(tenantId, locationId, now) {
      const rows = unwrap(
        await sb
          .from("print_jobs")
          .update({ status: "queued", attempts: 0, retry_after: null, done_at: null })
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .eq("status", "failed")
          .gt("expires_at", now)
          .select("id"),
      ) as Row[];
      return rows.length;
    },

    async pruneFinishedPrintJobs(beforeIso) {
      const rows = unwrap(
        await sb
          .from("print_jobs")
          .delete()
          .in("status", ["done", "failed", "expired"])
          .lt("created_at", beforeIso)
          .select("id"),
      ) as Row[];
      return rows.length;
    },

    async getPrintJobForPrinter(printerId, jobId) {
      const r = unwrap(
        await sb
          .from("print_jobs")
          .select("*")
          .eq("id", jobId)
          .eq("printer_id", printerId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapPrintJob(r) : null;
    },

    async completePrintJob(printerId, jobId, outcome, now) {
      const retry = !outcome.ok && outcome.retryAt;
      unwrap(
        await sb
          .from("print_jobs")
          .update(
            outcome.ok
              ? { status: "done", error: null, done_at: now }
              : retry
                ? { status: "queued", error: outcome.error, retry_after: outcome.retryAt }
                : { status: "failed", error: outcome.error, done_at: now },
          )
          .eq("id", jobId)
          .eq("printer_id", printerId)
          .in("status", ["queued", "sent"]),
      );
      return this.getPrintJobForPrinter(printerId, jobId);
    },

    async listPrintJobs(tenantId, locationId, limit) {
      return (
        unwrap(
          await sb
            .from("print_jobs")
            .select("*")
            .eq("tenant_id", tenantId)
            .eq("location_id", locationId)
            .order("created_at", { ascending: false })
            .limit(limit),
        ) as Row[]
      ).map(mapPrintJob);
    },

    async listStaleTerminalTenders(olderThan, limit) {
      return (
        unwrap(
          await sb
            .from("payments")
            .select("*")
            .eq("rail", "stripe_terminal")
            .in("status", ["requires_action", "pending"])
            .is("raw->>needs_manual_review", null)
            .lt("updated_at", olderThan)
            .order("updated_at")
            .limit(limit),
        ) as Row[]
      ).map(mapPayment);
    },

    // -- Customers ---------------------------------------------------------
    async getCustomerByEmail(tenantId, email) {
      const r = unwrap(
        await sb
          .from("customers")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("email", email.trim().toLowerCase())
          .maybeSingle(),
      ) as Row | null;
      return r ? mapCustomer(r) : null;
    },

    async getCustomer(id) {
      const r = unwrap(
        await sb.from("customers").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapCustomer(r) : null;
    },

    async listCustomers(tenantId, opts) {
      let q = sb.from("customers").select("*").eq("tenant_id", tenantId);
      if (opts?.after) {
        const { created_at: c, id } = safeKeyset(opts.after);
        q = q.or(`created_at.gt.${c},and(created_at.eq.${c},id.gt.${id})`);
      }
      return (
        unwrap(
          await q
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .limit(Math.min(opts?.limit ?? 1000, 1000)),
        ) as Row[]
      ).map(mapCustomer);
    },

    async getTenantSettings(tenantId) {
      const r = unwrap(
        await sb
          .from("tenant_settings")
          .select("*")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      if (r) return mapTenantSettings(r);
      return {
        tenant_id: tenantId,
        inventory_owner: "pos_basic",
        updated_at: new Date(0).toISOString(),
      };
    },

    async setTenantSettings(tenantId, patch) {
      const current = await this.getTenantSettings(tenantId);
      return mapTenantSettings(
        unwrap(
          await sb
            .from("tenant_settings")
            .upsert({
              tenant_id: tenantId,
              inventory_owner: patch.inventory_owner ?? current.inventory_owner,
              updated_at: nowIso(),
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async upsertCustomer(customer) {
      // The shop/checkout path (email is the key). Phone-only identities go
      // through upsertCustomerIdentity.
      if (!customer.email) {
        throw new Error("upsertCustomer requires an email; use upsertCustomerIdentity.");
      }
      const email = customer.email.trim().toLowerCase();
      const byId = unwrap(
        await sb
          .from("customers")
          .select("*")
          .eq("id", customer.id)
          .maybeSingle(),
      ) as Row | null;
      const byEmail = byId
        ? null
        : (unwrap(
            await sb
              .from("customers")
              .select("*")
              .eq("tenant_id", customer.tenant_id)
              .eq("email", email)
              .maybeSingle(),
          ) as Row | null);
      // Matched only by EMAIL (an anonymous checkout with a new id): anyone can
      // type someone else's email, so an existing row is NEVER written from
      // here (no name, no phone): the details typed for the order live on the
      // order itself (fulfillment.contact). Only a caller that already holds
      // the row's id (a signed-in shop customer) updates it.
      if (!byId && byEmail) return mapCustomer(byEmail);
      const base = byId ? mapCustomer(byId) : null;
      const now = nowIso();
      // A row with a PROVEN contact is frozen for contacts: a checkout must not
      // plant a phone/email on it (that is how a victim's row becomes reachable
      // by someone else's one-time code).
      const frozen = Boolean(base?.email_verified_at || base?.phone_verified_at);
      const merged: Customer = {
        ...customer,
        id: base?.id ?? customer.id,
        email: frozen ? (base?.email ?? email) : email,
        verified: customer.verified || base?.verified || false,
        name: customer.name ?? base?.name ?? null,
        phone: frozen ? (base?.phone ?? null) : (customer.phone ?? base?.phone ?? null),
        created_at: base?.created_at ?? now,
        updated_at: now,
      };
      // Consent / tags / external ids belong to upsertCustomerIdentity: a stale
      // snapshot passed here must never overwrite them.
      const {
        marketing: _m,
        tags: _t,
        external_ids: _e,
        email_verified_at: _ev,
        phone_verified_at: _pv,
        ...writable
      } = merged;
      void _m;
      void _t;
      void _e;
      void _ev;
      void _pv;
      return mapCustomer(
        unwrap(
          await sb.from("customers").upsert(writable).select().single(),
        ) as Row,
      );
    },

    async upsertCustomerIdentity(tenantId, input) {
      const out = unwrap(
        await sb.rpc("core_upsert_customer", {
          p_tenant_id: tenantId,
          p_new_id: input.newId,
          p_email: input.email,
          p_phone: input.phone,
          p_name: input.name,
          p_marketing: input.marketing,
          p_tags: input.tags,
          p_external_ids: input.externalIds,
          p_verified_contact: input.verifiedContact ?? null,
          ...(input.country !== undefined ? { p_country: input.country } : {}),
        }),
      ) as { customer: Row; created: boolean; changed: boolean };
      return {
        customer: mapCustomer(out.customer),
        created: out.created === true,
        changed: out.changed === true,
      };
    },

    async createMagicLinkToken(token) {
      unwrap(await sb.from("magic_link_tokens").insert(token).select());
      return token;
    },

    async consumeMagicLinkToken(token) {
      const rec = unwrap(
        await sb
          .from("magic_link_tokens")
          .select("*")
          .eq("token", token)
          .maybeSingle(),
      ) as Row | null;
      if (!rec || rec.consumed) return null;
      if (new Date(rec.expires_at as string).getTime() < Date.now())
        return null;
      unwrap(
        await sb
          .from("magic_link_tokens")
          .update({ consumed: true })
          .eq("token", token),
      );
      const customer = unwrap(
        await sb
          .from("customers")
          .select("*")
          .eq("id", rec.customer_id as string)
          .maybeSingle(),
      ) as Row | null;
      if (!customer) return null;
      return mapCustomer(
        unwrap(
          await sb
            .from("customers")
            .update({ verified: true, updated_at: nowIso() })
            .eq("id", rec.customer_id as string)
            .select()
            .single(),
        ) as Row,
      );
    },

    // -- Deliveries --------------------------------------------------------
    async upsertDelivery(delivery) {
      const existing = unwrap(
        await sb
          .from("deliveries")
          .select("created_at")
          .eq("id", delivery.id)
          .maybeSingle(),
      ) as Row | null;
      const now = nowIso();
      return mapDelivery(
        unwrap(
          await sb
            .from("deliveries")
            .upsert({
              ...delivery,
              created_at:
                (existing?.created_at as string) ?? delivery.created_at ?? now,
              updated_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async transitionDelivery(id, tenantId, patch) {
      const changes: Row = { status: patch.status, updated_at: nowIso() };
      if (patch.driver_name !== undefined) changes.driver_name = patch.driver_name;
      if (patch.driver_phone !== undefined) changes.driver_phone = patch.driver_phone;
      if (patch.eta_minutes !== undefined) changes.eta_minutes = patch.eta_minutes;
      if (patch.tracking_ref !== undefined) changes.tracking_ref = patch.tracking_ref;
      if (patch.provider_delivery_id !== undefined) {
        changes.provider_delivery_id = patch.provider_delivery_id;
      }
      // ONE conditional UPDATE: only a delivery of this tenant that has not
      // finished. The WHERE is the lock; a late update cannot reopen a finished
      // delivery.
      const updated = unwrap(
        await sb
          .from("deliveries")
          .update(changes)
          .eq("id", id)
          .eq("tenant_id", tenantId)
          .not("status", "in", "(delivered,canceled,failed)")
          .select()
          .maybeSingle(),
      ) as Row | null;
      if (updated) return { ok: true, delivery: mapDelivery(updated) } as const;
      const cur = unwrap(
        await sb
          .from("deliveries")
          .select("*")
          .eq("id", id)
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      if (!cur) return { ok: false, reason: "not_found" } as const;
      return { ok: false, reason: "terminal", delivery: mapDelivery(cur) } as const;
    },

    async updateDriverDispatch(id, tenantId, u) {
      const { expect_status, ...rest } = u;
      const changes: Row = { updated_at: nowIso() };
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) changes[k] = v;
      }
      // ONE conditional UPDATE: still this provider's and still `expect_status`.
      const updated = unwrap(
        await sb
          .from("deliveries")
          .update(changes)
          .eq("id", id)
          .eq("tenant_id", tenantId)
          .eq("provider", "openpizza_driver")
          .eq("status", expect_status)
          .select()
          .maybeSingle(),
      ) as Row | null;
      if (updated) return { ok: true, delivery: mapDelivery(updated) } as const;
      const cur = unwrap(
        await sb
          .from("deliveries")
          .select("*")
          .eq("id", id)
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ) as Row | null;
      return { ok: false, delivery: cur ? mapDelivery(cur) : null } as const;
    },

    async switchDeliveryToManual(id, tenantId, expect) {
      let q = sb
        .from("deliveries")
        .update({
          provider: "in_house_manual",
          status: "pending_assignment",
          provider_delivery_id: null,
          tracking_ref: null,
          driver_name: null,
          driver_phone: null,
          dispatch_error: null,
          dispatch_next_at: null,
          updated_at: nowIso(),
        })
        .eq("id", id)
        .eq("tenant_id", tenantId)
        .eq("provider", "openpizza_driver")
        .eq("status", expect.status);
      q =
        expect.provider_delivery_id === null
          ? q.is("provider_delivery_id", null)
          : q.eq("provider_delivery_id", expect.provider_delivery_id);
      const r = unwrap(await q.select().maybeSingle()) as Row | null;
      return r ? mapDelivery(r) : null;
    },

    async listDriverDispatchRetries(now, limit) {
      return (
        unwrap(
          await sb
            .from("deliveries")
            .select("*")
            .eq("provider", "openpizza_driver")
            .eq("status", "quoted")
            .or(`dispatch_next_at.is.null,dispatch_next_at.lte.${now}`)
            .order("created_at", { ascending: true })
            .limit(limit),
        ) as Row[]
      ).map(mapDelivery);
    },

    async getDeliveryForOrder(orderId) {
      const r = unwrap(
        await sb
          .from("deliveries")
          .select("*")
          .eq("order_id", orderId)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapDelivery(r) : null;
    },

    async getDelivery(id) {
      const r = unwrap(
        await sb.from("deliveries").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapDelivery(r) : null;
    },

    async listDeliveries(tenantId, locationId) {
      return (
        unwrap(
          await sb
            .from("deliveries")
            .select("*")
            .eq("tenant_id", tenantId)
            .eq("location_id", locationId)
            .order("created_at", { ascending: false }),
        ) as Row[]
      ).map(mapDelivery);
    },

    // -- Menu management ---------------------------------------------------
    async getMenuEntityTenant(entity, id) {
      const one = async (table: string, cols: string) =>
        unwrap(
          await sb.from(table).select(cols).eq("id", id).maybeSingle(),
        ) as Row | null;
      switch (entity) {
        case "category":
          return ((await one("menu_categories", "tenant_id"))?.tenant_id ??
            null) as string | null;
        case "item":
          return ((await one("menu_items", "tenant_id"))?.tenant_id ??
            null) as string | null;
        case "modifierGroup":
          return ((await one("modifier_groups", "tenant_id"))?.tenant_id ??
            null) as string | null;
        case "size": {
          const size = await one("item_sizes", "item_id");
          if (!size) return null;
          const item = unwrap(
            await sb
              .from("menu_items")
              .select("tenant_id")
              .eq("id", size.item_id as string)
              .maybeSingle(),
          ) as Row | null;
          return (item?.tenant_id ?? null) as string | null;
        }
        case "modifier": {
          const mod = await one("modifiers", "group_id");
          if (!mod) return null;
          const group = unwrap(
            await sb
              .from("modifier_groups")
              .select("tenant_id")
              .eq("id", mod.group_id as string)
              .maybeSingle(),
          ) as Row | null;
          return (group?.tenant_id ?? null) as string | null;
        }
        default:
          return null;
      }
    },

    async getMenuSnapshot(tenantId) {
      // Every read is paged (PostgREST caps responses at max_rows ~ 1000) and
      // every `in` list is chunked.
      const tenantRows = (
        table: string,
        cols: string,
        order: string,
      ) =>
        fetchAllPages<Row>(async (from, to) => {
          let q = sb.from(table).select(cols).eq("tenant_id", tenantId);
          // Stable total order: every column of the (composite) key.
          for (const o of order.split(",")) q = q.order(o.trim());
          return unwrap(await q.range(from, to)) as unknown as Row[];
        });
      const [cats, items, groups, recipes, allergens] = await Promise.all([
        tenantRows("menu_categories", "id,name,sort_order", "id"),
        tenantRows(
          "menu_items",
          "id,category_id,name,description,is_half_and_half_capable,station",
          "id",
        ),
        tenantRows(
          "modifier_groups",
          "id,name,min_select,max_select,supports_half",
          "id",
        ),
        tenantRows("item_inventory_links", "id,source_id", "id"),
        tenantRows("menu_allergen_rows", "publication_id,target_id,target_type", "publication_id,target_type,target_id"),
      ]);
      const itemIds = items.map((r) => r.id as string);
      const groupIds = groups.map((r) => r.id as string);
      const [sizes, mods, links] = await Promise.all([
        selectIn("item_sizes", "item_id", itemIds),
        selectIn("modifiers", "group_id", groupIds),
        selectIn("item_modifier_groups", "item_id", itemIds, "group_id"),
      ]);
      return {
        categories: cats.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          sort_order: r.sort_order as number,
        })),
        items: items.map((r) => ({
          id: r.id as string,
          category_id: r.category_id as string,
          name: r.name as string,
          description: (r.description as string | null) ?? null,
          is_half_and_half_capable: r.is_half_and_half_capable as boolean,
          station: r.station as MenuItem["station"],
        })),
        sizes: sizes.map((r) => ({
          id: r.id as string,
          item_id: r.item_id as string,
          name: r.name as string,
          price_cents: r.price_cents as number,
          sort_order: r.sort_order as number,
        })),
        modifierGroups: groups.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          min_select: r.min_select as number,
          max_select: r.max_select as number,
          supports_half: r.supports_half as boolean,
        })),
        modifiers: mods.map((r) => ({
          id: r.id as string,
          group_id: r.group_id as string,
          name: r.name as string,
          price_cents: r.price_cents as number,
          sort_order: r.sort_order as number,
        })),
        links: links.map((r) => ({
          item_id: r.item_id as string,
          group_id: r.group_id as string,
          sort_order: r.sort_order as number,
        })),
        inventoryLinkSourceIds: recipes.map((r) => r.source_id as string),
        allergenTargetIds: allergens.map((r) => r.target_id as string),
      };
    },

    // ONE transaction inside public.import_menu() (migration
    // 20261113000100): a PostgREST client can't span statements, so the whole
    // replace/insert runs server-side and rolls back as a unit.
    async applyMenuImport(tenantId, changes) {
      unwrap(
        await sb.rpc("import_menu", {
          p_tenant_id: tenantId,
          p_changes: changes,
        }),
      );
    },

    async listCategories(tenantId) {
      return (
        unwrap(
          await sb
            .from("menu_categories")
            .select("*")
            .eq("tenant_id", tenantId)
            .order("sort_order"),
        ) as Row[]
      ).map((r) => ({
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        name: r.name as string,
        sort_order: r.sort_order as number,
      }));
    },

    async upsertCategory(input: CategoryInput) {
      if (input.id) {
        const cur = unwrap(
          await sb
            .from("menu_categories")
            .select("*")
            .eq("id", input.id)
            .maybeSingle(),
        ) as Row | null;
        if (cur) {
          const r = unwrap(
            await sb
              .from("menu_categories")
              .update({
                name: input.name,
                sort_order: input.sort_order ?? (cur.sort_order as number),
              })
              .eq("id", input.id)
              .select()
              .single(),
          ) as Row;
          return {
            id: r.id as string,
            tenant_id: r.tenant_id as string,
            name: r.name as string,
            sort_order: r.sort_order as number,
          };
        }
      }
      const count = (
        unwrap(
          await sb
            .from("menu_categories")
            .select("id")
            .eq("tenant_id", input.tenant_id),
        ) as Row[]
      ).length;
      const r = unwrap(
        await sb
          .from("menu_categories")
          .insert({
            id: input.id ?? genUuid(),
            tenant_id: input.tenant_id,
            name: input.name,
            sort_order: input.sort_order ?? count + 1,
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        name: r.name as string,
        sort_order: r.sort_order as number,
      };
    },

    async deleteCategory(id) {
      // FK cascade drops items -> sizes / links; overrides cascade via location.
      unwrap(await sb.from("menu_categories").delete().eq("id", id).select());
    },

    async upsertItem(input: ItemInput) {
      if (input.id) {
        const cur = unwrap(
          await sb
            .from("menu_items")
            .select("*")
            .eq("id", input.id)
            .maybeSingle(),
        ) as Row | null;
        if (cur) {
          const r = unwrap(
            await sb
              .from("menu_items")
              .update({
                category_id: input.category_id,
                name: input.name,
                description:
                  input.description ?? (cur.description as string | null),
                is_half_and_half_capable:
                  input.is_half_and_half_capable ??
                  (cur.is_half_and_half_capable as boolean),
                station: input.station ?? (cur.station as MenuItem["station"]),
              })
              .eq("id", input.id)
              .select()
              .single(),
          ) as Row;
          return {
            id: r.id as string,
            tenant_id: r.tenant_id as string,
            category_id: r.category_id as string,
            name: r.name as string,
            description: (r.description as string | null) ?? null,
            is_half_and_half_capable: r.is_half_and_half_capable as boolean,
            station: r.station as MenuItem["station"],
          };
        }
      }
      const r = unwrap(
        await sb
          .from("menu_items")
          .insert({
            id: input.id ?? genUuid(),
            tenant_id: input.tenant_id,
            category_id: input.category_id,
            name: input.name,
            description: input.description ?? null,
            is_half_and_half_capable: input.is_half_and_half_capable ?? false,
            station: input.station ?? "oven",
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        category_id: r.category_id as string,
        name: r.name as string,
        description: (r.description as string | null) ?? null,
        is_half_and_half_capable: r.is_half_and_half_capable as boolean,
        station: r.station as MenuItem["station"],
      };
    },

    async deleteItem(id) {
      unwrap(await sb.from("menu_items").delete().eq("id", id).select());
    },

    async upsertSize(input: SizeInput) {
      if (input.id) {
        const cur = unwrap(
          await sb
            .from("item_sizes")
            .select("*")
            .eq("id", input.id)
            .maybeSingle(),
        ) as Row | null;
        if (cur) {
          const r = unwrap(
            await sb
              .from("item_sizes")
              .update({
                name: input.name,
                price_cents: input.price_cents,
                sort_order: input.sort_order ?? (cur.sort_order as number),
              })
              .eq("id", input.id)
              .select()
              .single(),
          ) as Row;
          return {
            id: r.id as string,
            item_id: r.item_id as string,
            name: r.name as string,
            price_cents: r.price_cents as number,
            sort_order: r.sort_order as number,
          };
        }
      }
      const count = (
        unwrap(
          await sb.from("item_sizes").select("id").eq("item_id", input.item_id),
        ) as Row[]
      ).length;
      const r = unwrap(
        await sb
          .from("item_sizes")
          .insert({
            id: input.id ?? genUuid(),
            item_id: input.item_id,
            name: input.name,
            price_cents: input.price_cents,
            sort_order: input.sort_order ?? count + 1,
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        item_id: r.item_id as string,
        name: r.name as string,
        price_cents: r.price_cents as number,
        sort_order: r.sort_order as number,
      };
    },

    async deleteSize(id) {
      unwrap(await sb.from("item_sizes").delete().eq("id", id).select());
    },

    async listModifierGroups(tenantId) {
      return (
        unwrap(
          await sb
            .from("modifier_groups")
            .select("*")
            .eq("tenant_id", tenantId),
        ) as Row[]
      ).map((r) => ({
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        name: r.name as string,
        min_select: r.min_select as number,
        max_select: r.max_select as number,
        supports_half: r.supports_half as boolean,
      }));
    },

    async upsertModifierGroup(input: ModifierGroupInput) {
      if (input.id) {
        const cur = unwrap(
          await sb
            .from("modifier_groups")
            .select("*")
            .eq("id", input.id)
            .maybeSingle(),
        ) as Row | null;
        if (cur) {
          const r = unwrap(
            await sb
              .from("modifier_groups")
              .update({
                name: input.name,
                min_select: input.min_select ?? (cur.min_select as number),
                max_select: input.max_select ?? (cur.max_select as number),
                supports_half:
                  input.supports_half ?? (cur.supports_half as boolean),
              })
              .eq("id", input.id)
              .select()
              .single(),
          ) as Row;
          return {
            id: r.id as string,
            tenant_id: r.tenant_id as string,
            name: r.name as string,
            min_select: r.min_select as number,
            max_select: r.max_select as number,
            supports_half: r.supports_half as boolean,
          };
        }
      }
      const r = unwrap(
        await sb
          .from("modifier_groups")
          .insert({
            id: input.id ?? genUuid(),
            tenant_id: input.tenant_id,
            name: input.name,
            min_select: input.min_select ?? 0,
            max_select: input.max_select ?? 1,
            supports_half: input.supports_half ?? false,
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        name: r.name as string,
        min_select: r.min_select as number,
        max_select: r.max_select as number,
        supports_half: r.supports_half as boolean,
      };
    },

    async deleteModifierGroup(id) {
      unwrap(await sb.from("modifier_groups").delete().eq("id", id).select());
    },

    async upsertModifier(input: ModifierInput) {
      if (input.id) {
        const cur = unwrap(
          await sb
            .from("modifiers")
            .select("*")
            .eq("id", input.id)
            .maybeSingle(),
        ) as Row | null;
        if (cur) {
          const r = unwrap(
            await sb
              .from("modifiers")
              .update({
                name: input.name,
                price_cents: input.price_cents,
                sort_order: input.sort_order ?? (cur.sort_order as number),
              })
              .eq("id", input.id)
              .select()
              .single(),
          ) as Row;
          return {
            id: r.id as string,
            group_id: r.group_id as string,
            name: r.name as string,
            price_cents: r.price_cents as number,
            sort_order: r.sort_order as number,
          };
        }
      }
      const count = (
        unwrap(
          await sb
            .from("modifiers")
            .select("id")
            .eq("group_id", input.group_id),
        ) as Row[]
      ).length;
      const r = unwrap(
        await sb
          .from("modifiers")
          .insert({
            id: input.id ?? genUuid(),
            group_id: input.group_id,
            name: input.name,
            price_cents: input.price_cents,
            sort_order: input.sort_order ?? count + 1,
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        group_id: r.group_id as string,
        name: r.name as string,
        price_cents: r.price_cents as number,
        sort_order: r.sort_order as number,
      };
    },

    async deleteModifier(id) {
      unwrap(await sb.from("modifiers").delete().eq("id", id).select());
    },

    // -- Per-location overrides --------------------------------------------
    async listOverrides(tenantId, locationId) {
      return (
        unwrap(
          await sb
            .from("location_menu_overrides")
            .select("*")
            .eq("tenant_id", tenantId)
            .eq("location_id", locationId),
        ) as Row[]
      ).map(mapOverride);
    },

    async upsertOverride(input: OverrideInput) {
      const existing = unwrap(
        await sb
          .from("location_menu_overrides")
          .select("*")
          .eq("location_id", input.location_id)
          .eq("target_type", input.target_type)
          .eq("target_id", input.target_id)
          .maybeSingle(),
      ) as Row | null;
      const base = existing ? mapOverride(existing) : null;
      const merged: LocationMenuOverride = {
        id: base?.id ?? genUuid(),
        tenant_id: input.tenant_id,
        location_id: input.location_id,
        target_type: input.target_type,
        target_id: input.target_id,
        price_cents:
          input.price_cents !== undefined
            ? input.price_cents
            : (base?.price_cents ?? null),
        available:
          input.available !== undefined
            ? input.available
            : (base?.available ?? null),
        updated_at: nowIso(),
      };
      if (merged.price_cents == null && merged.available == null) {
        if (base) {
          unwrap(
            await sb
              .from("location_menu_overrides")
              .delete()
              .eq("id", base.id)
              .select(),
          );
        }
        return merged;
      }
      return mapOverride(
        unwrap(
          await sb
            .from("location_menu_overrides")
            .upsert(merged, {
              onConflict: "location_id,target_type,target_id",
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async clearOverride(tenantId, locationId, targetType, targetId) {
      unwrap(
        await sb
          .from("location_menu_overrides")
          .delete()
          .eq("location_id", locationId)
          .eq("target_type", targetType)
          .eq("target_id", targetId)
          .select(),
      );
    },

    // -- Inventory ---------------------------------------------------------
    async listInventory(tenantId, locationId) {
      return (
        unwrap(
          await sb
            .from("inventory_items")
            .select("*")
            .eq("tenant_id", tenantId)
            .eq("location_id", locationId)
            .order("name"),
        ) as Row[]
      )
        .map(mapInventoryItem)
        .map(
          (i): InventoryItemView => ({
            ...i,
            low: i.on_hand <= i.low_threshold,
          }),
        );
    },

    async getInventoryItem(id) {
      const r = unwrap(
        await sb.from("inventory_items").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapInventoryItem(r) : null;
    },

    async upsertInventoryItem(item) {
      const existing = item.id
        ? (unwrap(
            await sb
              .from("inventory_items")
              .select("created_at")
              .eq("id", item.id)
              .maybeSingle(),
          ) as Row | null)
        : null;
      const now = nowIso();
      return mapInventoryItem(
        unwrap(
          await sb
            .from("inventory_items")
            .upsert({
              ...item,
              id: item.id || genUuid(),
              created_at:
                (existing?.created_at as string) ?? item.created_at ?? now,
              updated_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async applyInventoryMovement(input) {
      const result = await applyMovementInternal(input);
      if (!result) {
        throw new Error(`Inventory item ${input.inventoryItemId} not found.`);
      }
      return result;
    },

    async listInventoryMovements(tenantId, locationId) {
      return (
        unwrap(
          await sb
            .from("inventory_movements")
            .select("*")
            .eq("tenant_id", tenantId)
            .eq("location_id", locationId)
            .order("created_at", { ascending: false }),
        ) as Row[]
      ).map(mapInventoryMovement);
    },

    // -- Reports + end-of-day ----------------------------------------------
    async getSalesReport(tenantId, locationId, range: DateRange) {
      let oq = sb.from("orders").select("*").eq("tenant_id", tenantId);
      if (locationId !== null) oq = oq.eq("location_id", locationId);
      const orderRows = unwrap(await oq) as Row[];
      const scoped = await Promise.all(orderRows.map((r) => readOrderRow(r)));
      const orderIds = scoped.map((o) => o.id);
      const scopedPayments =
        orderIds.length === 0
          ? []
          : (
              unwrap(
                await sb.from("payments").select("*").in("order_id", orderIds),
              ) as Row[]
            ).map(mapPayment);

      // Resolve category + location labels (tenant-scoped reads).
      const itemRows = unwrap(
        await sb
          .from("menu_items")
          .select("id,category_id")
          .eq("tenant_id", tenantId),
      ) as Row[];
      const catRows = unwrap(
        await sb
          .from("menu_categories")
          .select("id,name")
          .eq("tenant_id", tenantId),
      ) as Row[];
      const locRows = unwrap(
        await sb
          .from("locations")
          .select("*")
          .eq("tenant_id", tenantId),
      ) as Row[];
      const catNameById = new Map(
        catRows.map((c) => [c.id as string, c.name as string]),
      );
      const catOfItem = new Map(
        itemRows.map((i) => [i.id as string, i.category_id as string]),
      );
      const locNameById = new Map(
        locRows.map((l) => [l.id as string, l.name as string]),
      );

      return buildSalesReport({
        tenantId,
        locationId,
        range,
        orders: scoped,
        payments: scopedPayments,
        categoryOf: (itemId: string) => {
          const cid = catOfItem.get(itemId);
          if (!cid) return null;
          return { id: cid, name: catNameById.get(cid) ?? cid };
        },
        locationName: (id: string) => locNameById.get(id) ?? id,
        locationClock: (id: string) => {
          const l = locRows.find((r) => r.id === id);
          return l
            ? {
                timezone: (l.timezone as string | null) ?? null,
                business_day_cutoff_minutes:
                  (l.business_day_cutoff_minutes as number | null) ?? 0,
              }
            : null;
        },
      });
    },

    async getOwnerReportBundle(tenantId, locationId, from, to, topN) {
      // One SQL call: every aggregate is computed in Postgres, per location
      // timezone and business-day cutoff (see report_sales_bundle).
      const data = unwrap(
        await sb.rpc("report_sales_bundle", {
          p_tenant_id: tenantId,
          p_location_id: locationId,
          p_from: from,
          p_to: to,
          p_top_n: topN ?? 50,
        }),
      ) as Partial<OwnerReportBundle> | null;
      return { ...EMPTY_BUNDLE, ...(data ?? {}) };
    },

    async getBusinessDayClose(tenantId, locationId, businessDate) {
      const r = unwrap(
        await sb
          .from("business_day_closes")
          .select("*")
          .eq("location_id", locationId)
          .eq("business_date", businessDate)
          .maybeSingle(),
      ) as Row | null;
      if (!r) return null;
      return {
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        location_id: r.location_id as string,
        business_date: r.business_date as string,
        closed_at: r.closed_at as string,
        report: r.report as SalesReport,
        drawer: r.drawer as BusinessDayClose["drawer"],
      };
    },

    async closeBusinessDay(tenantId, locationId, businessDate, opts) {
      const existing = await this.getBusinessDayClose(
        tenantId,
        locationId,
        businessDate,
      );
      if (existing) return existing;

      const report = await this.getSalesReport(tenantId, locationId, {
        from: businessDate,
        to: businessDate,
      });

      const shiftRows = unwrap(
        await sb
          .from("shifts")
          .select("*")
          .eq("location_id", locationId)
          .eq("status", "closed")
          .not("closed_at", "is", null),
      ) as Row[];
      const locRow = unwrap(
        await sb
          .from("locations")
          .select("*")
          .eq("id", locationId)
          .maybeSingle(),
      ) as Row | null;
      const clock = locRow
        ? {
            timezone: (locRow.timezone as string | null) ?? null,
            business_day_cutoff_minutes:
              (locRow.business_day_cutoff_minutes as number | null) ?? 0,
          }
        : null;
      const dayShifts = shiftRows
        .map(mapShift)
        .filter(
          (s) =>
            s.closed_at != null &&
            locationBusinessDate(s.closed_at, clock) === businessDate,
        );

      let openingFloat = 0;
      let cashSales = 0;
      let expected = 0;
      let counted = 0;
      for (const s of dayShifts) {
        const events = (
          unwrap(
            await sb.from("shift_cash_events").select("*").eq("shift_id", s.id),
          ) as Row[]
        ).map(
          (e): ShiftCashEvent => ({
            id: e.id as string,
            shift_id: e.shift_id as string,
            tenant_id: e.tenant_id as string,
            location_id: e.location_id as string,
            type: e.type as ShiftCashEvent["type"],
            amount_cents: e.amount_cents as number,
            order_id: (e.order_id as string | null) ?? null,
            note: (e.note as string | null) ?? null,
            created_at: e.created_at as string,
          }),
        );
        const rec = reconcileFromEvents(s, events);
        openingFloat += rec.opening_float_cents;
        cashSales += rec.cash_sales_cents;
        expected += rec.expected_cents;
        counted += rec.counted_cents ?? rec.expected_cents;
      }

      const drawer = opts?.drawer ?? {
        opening_float_cents: openingFloat,
        cash_sales_cents: cashSales,
        expected_cents: expected,
        counted_cents: counted,
        over_short_cents: counted - expected,
        shift_count: dayShifts.length,
      };
      const r = unwrap(
        await sb
          .from("business_day_closes")
          .insert({
            id: genUuid(),
            tenant_id: tenantId,
            location_id: locationId,
            business_date: businessDate,
            closed_at: nowIso(),
            report,
            drawer,
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        tenant_id: r.tenant_id as string,
        location_id: r.location_id as string,
        business_date: r.business_date as string,
        closed_at: r.closed_at as string,
        report: r.report as SalesReport,
        drawer: r.drawer as BusinessDayClose["drawer"],
      };
    },

    // -- Staff & shifts ----------------------------------------------------
    async listStaff(tenantId) {
      // pin_hash omitted (default) so it never reaches the client.
      return (
        unwrap(
          await sb
            .from("staff")
            .select("*")
            .eq("tenant_id", tenantId)
            .order("name"),
        ) as Row[]
      ).map((r) => mapStaff(r));
    },

    async getStaffById(tenantId, staffId) {
      const r = unwrap(
        await sb
          .from("staff")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("id", staffId)
          .maybeSingle(),
      ) as Row | null;
      // includePin: this is the trusted server PIN-verification path only.
      return r ? mapStaff(r, { includePin: true }) : null;
    },

    async beginPinAttempt(tenantId, staffId) {
      const res = unwrap(
        await sb.rpc("begin_pin_attempt", {
          p_tenant_id: tenantId,
          p_staff_id: staffId,
        }),
      ) as {
        allowed?: boolean;
        just_locked?: boolean;
        attempts?: number;
        locked_until?: string | null;
      } | null;
      return {
        allowed: res?.allowed === true,
        justLocked: res?.just_locked === true,
        attempts: Number(res?.attempts ?? 0),
        lockedUntil: res?.locked_until ?? null,
      };
    },

    async clearPinAttempts(tenantId, staffId) {
      // Conditional single-statement update: never clears a lock set by a
      // concurrent attempt burst.
      unwrap(
        await sb
          .from("staff")
          .update({ pin_failed_attempts: 0 })
          .eq("id", staffId)
          .eq("tenant_id", tenantId)
          .is("pin_locked_until", null)
          .select("id"),
      );
    },

    async setStaffPinHash(tenantId, staffId, pinHash) {
      // One targeted update (never a whole-row write of a stale staff snapshot).
      // A reset PIN starts with a fresh lockout budget.
      const rows = unwrap(
        await sb
          .from("staff")
          .update({
            pin_hash: pinHash,
            pin_failed_attempts: 0,
            pin_locked_until: null,
            pin_previous_hash: null,
            pin_previous_until: null,
          })
          .eq("id", staffId)
          .eq("tenant_id", tenantId)
          .select("id"),
      ) as Row[];
      return rows.length > 0;
    },

    async rotateStaffPin(tenantId, staffId, pinHash, graceUntil) {
      const cur = unwrap(
        await sb
          .from("staff")
          .select("pin_hash, pin_previous_hash, pin_previous_until")
          .eq("tenant_id", tenantId)
          .eq("id", staffId)
          .maybeSingle(),
      ) as Row | null;
      if (!cur) return false;
      const prevUntil = cur.pin_previous_until as string | null;
      const keep =
        !!cur.pin_previous_hash &&
        !!prevUntil &&
        new Date(prevUntil).getTime() > Date.now();
      const rows = unwrap(
        await sb
          .from("staff")
          .update({
            pin_hash: pinHash,
            pin_failed_attempts: 0,
            pin_locked_until: null,
            pin_previous_hash: keep ? cur.pin_previous_hash : cur.pin_hash,
            pin_previous_until: keep ? prevUntil : graceUntil,
          })
          .eq("tenant_id", tenantId)
          .eq("id", staffId)
          .select("id"),
      ) as Row[];
      return rows.length > 0;
    },

    async clearPreviousPin(tenantId, staffId) {
      unwrap(
        await sb
          .from("staff")
          .update({ pin_previous_hash: null, pin_previous_until: null })
          .eq("tenant_id", tenantId)
          .eq("id", staffId)
          .not("pin_previous_hash", "is", null)
          .select("id"),
      );
    },

    async tenantHasStaffPins(tenantId) {
      const rows = unwrap(
        await sb
          .from("staff")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("active", true)
          .not("pin_hash", "is", null)
          .limit(1),
      ) as Row[];
      return rows.length > 0;
    },

    async listStaffPinRecords(tenantId) {
      const rows = unwrap(
        await sb
          .from("staff")
          .select(
            "id, active, location_ids, pin_hash, pin_previous_hash, pin_previous_until",
          )
          .eq("tenant_id", tenantId),
      ) as Row[];
      return rows.map((r) => ({
        id: r.id as string,
        active: r.active as boolean,
        location_ids: (r.location_ids as string[] | null) ?? [],
        pin_hash: (r.pin_hash as string | null) ?? null,
        pin_previous_hash: (r.pin_previous_hash as string | null) ?? null,
        pin_previous_until: (r.pin_previous_until as string | null) ?? null,
      }));
    },

    async updateStaffProfile(tenantId, staffId, patch) {
      // Targeted update of the fields present in the patch only, scoped by
      // tenant AND id (never a whole-row write of a stale snapshot).
      const row: Record<string, unknown> = {};
      for (const k of [
        "name",
        "role",
        "active",
        "contact_email",
        "contact_phone",
        "location_ids",
        "module_roles",
      ] as const) {
        if (patch[k] !== undefined) row[k] = patch[k];
      }
      if (Object.keys(row).length === 0) {
        const cur = unwrap(
          await sb
            .from("staff")
            .select("*")
            .eq("tenant_id", tenantId)
            .eq("id", staffId)
            .maybeSingle(),
        ) as Row | null;
        return cur ? mapStaff(cur) : null;
      }
      const r = unwrap(
        await sb
          .from("staff")
          .update(row)
          .eq("tenant_id", tenantId)
          .eq("id", staffId)
          .select()
          .maybeSingle(),
      ) as Row | null;
      return r ? mapStaff(r) : null;
    },

    async lastStaffSignIns(tenantId) {
      // Newest first; the first row seen per staff member wins.
      const rows = unwrap(
        await sb
          .from("terminal_staff_sessions")
          .select("staff_id, created_at")
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(2000),
      ) as Row[];
      const out = new Map<string, string>();
      for (const r of rows) {
        const id = r.staff_id as string;
        if (!out.has(id)) out.set(id, r.created_at as string);
      }
      return out;
    },

    async beginPinLimitAttempt(scope, key, limits) {
      const res = unwrap(
        await sb.rpc("begin_pin_limit_attempt", {
          p_scope: scope,
          p_key: key,
          p_max: limits.max,
          p_window_minutes: limits.windowMinutes,
          p_lock_minutes: limits.lockMinutes,
        }),
      ) as {
        allowed?: boolean;
        just_locked?: boolean;
        attempts?: number;
        locked_until?: string | null;
      } | null;
      return {
        allowed: res?.allowed === true,
        justLocked: res?.just_locked === true,
        attempts: Number(res?.attempts ?? 0),
        lockedUntil: res?.locked_until ?? null,
      };
    },

    async releasePinLimitAttempt(scope, key) {
      unwrap(
        await sb.rpc("release_pin_limit_attempt", { p_scope: scope, p_key: key }),
      );
    },

    async revokeStaffSessionsForStaff(tenantId, staffId) {
      unwrap(
        await sb
          .from("terminal_staff_sessions")
          .update({ revoked_at: nowIso() })
          .eq("tenant_id", tenantId)
          .eq("staff_id", staffId)
          .is("revoked_at", null)
          .select("id"),
      );
    },

    async createStaffSession(session) {
      return unwrap(
        await sb
          .from("terminal_staff_sessions")
          .insert(session)
          .select()
          .single(),
      ) as StaffSession;
    },

    async getStaffSession(id) {
      return (unwrap(
        await sb
          .from("terminal_staff_sessions")
          .select("*")
          .eq("id", id)
          .maybeSingle(),
      ) ?? null) as StaffSession | null;
    },

    async revokeStaffSession(id) {
      unwrap(
        await sb
          .from("terminal_staff_sessions")
          .update({ revoked_at: nowIso() })
          .eq("id", id)
          .is("revoked_at", null)
          .select("id"),
      );
    },

    async revokeStaffSessionsForUser(userId) {
      unwrap(
        await sb
          .from("terminal_staff_sessions")
          .update({ revoked_at: nowIso() })
          .eq("user_id", userId)
          .is("revoked_at", null)
          .select("id"),
      );
    },

    async upsertStaff(staff) {
      const existing = staff.id
        ? (unwrap(
            await sb
              .from("staff")
              .select("created_at")
              .eq("id", staff.id)
              .maybeSingle(),
          ) as Row | null)
        : null;
      // Only write pin_hash when the caller explicitly set it (not undefined),
      // so an unrelated update can't accidentally wipe a staff member's PIN.
      const { pin_hash, ...rest } = staff;
      const row: Record<string, unknown> = {
        ...rest,
        id: staff.id || genUuid(),
        created_at:
          (existing?.created_at as string) ?? staff.created_at ?? nowIso(),
      };
      if (pin_hash !== undefined) row.pin_hash = pin_hash;
      return mapStaff(
        unwrap(await sb.from("staff").upsert(row).select().single()) as Row,
      );
    },

    async setStaffModuleRoles(tenantId, staffId, roles) {
      // Targeted update: only module_roles, scoped by tenant AND id.
      const r = unwrap(
        await sb
          .from("staff")
          .update({ module_roles: roles })
          .eq("tenant_id", tenantId)
          .eq("id", staffId)
          .select()
          .maybeSingle(),
      ) as Row | null;
      return r ? mapStaff(r) : null;
    },

    async getShift(id) {
      const r = unwrap(
        await sb.from("shifts").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapShift(r) : null;
    },

    async listShifts(tenantId, locationId) {
      return (
        unwrap(
          await sb
            .from("shifts")
            .select("*")
            .eq("tenant_id", tenantId)
            .eq("location_id", locationId)
            .order("opened_at", { ascending: false }),
        ) as Row[]
      ).map(mapShift);
    },

    async getOpenShift(tenantId, locationId, staffId) {
      const r = unwrap(
        await sb
          .from("shifts")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("location_id", locationId)
          .eq("staff_id", staffId)
          .eq("status", "open")
          .maybeSingle(),
      ) as Row | null;
      return r ? mapShift(r) : null;
    },

    async openShift(input) {
      const open = await this.getOpenShift(
        input.tenantId,
        input.locationId,
        input.staffId,
      );
      if (open) return open;
      const now = nowIso();
      return mapShift(
        unwrap(
          await sb
            .from("shifts")
            .insert({
              id: genUuid(),
              tenant_id: input.tenantId,
              location_id: input.locationId,
              staff_id: input.staffId,
              status: "open",
              opened_at: now,
              closed_at: null,
              opening_float_cents: input.openingFloatCents,
              counted_cents: null,
              close_note: null,
              created_at: now,
            })
            .select()
            .single(),
        ) as Row,
      );
    },

    async addShiftCashEvent(event) {
      // An explicit id is an idempotency key (refund cash-outs): never twice.
      if (event.id) {
        const prior = unwrap(
          await sb.from("shift_cash_events").select("*").eq("id", event.id).maybeSingle(),
        ) as Row | null;
        if (prior) {
          return {
            id: prior.id as string,
            shift_id: prior.shift_id as string,
            tenant_id: prior.tenant_id as string,
            location_id: prior.location_id as string,
            type: prior.type as ShiftCashEvent["type"],
            amount_cents: prior.amount_cents as number,
            order_id: (prior.order_id as string | null) ?? null,
            note: (prior.note as string | null) ?? null,
            created_at: prior.created_at as string,
          };
        }
      }
      const r = unwrap(
        await sb
          .from("shift_cash_events")
          .insert({
            ...event,
            id: event.id || genUuid(),
            created_at: event.created_at || nowIso(),
          })
          .select()
          .single(),
      ) as Row;
      return {
        id: r.id as string,
        shift_id: r.shift_id as string,
        tenant_id: r.tenant_id as string,
        location_id: r.location_id as string,
        type: r.type as ShiftCashEvent["type"],
        amount_cents: r.amount_cents as number,
        order_id: (r.order_id as string | null) ?? null,
        note: (r.note as string | null) ?? null,
        created_at: r.created_at as string,
      };
    },

    async listShiftCashEvents(shiftId) {
      return (
        unwrap(
          await sb
            .from("shift_cash_events")
            .select("*")
            .eq("shift_id", shiftId)
            .order("created_at"),
        ) as Row[]
      ).map((e) => ({
        id: e.id as string,
        shift_id: e.shift_id as string,
        tenant_id: e.tenant_id as string,
        location_id: e.location_id as string,
        type: e.type as ShiftCashEvent["type"],
        amount_cents: e.amount_cents as number,
        order_id: (e.order_id as string | null) ?? null,
        note: (e.note as string | null) ?? null,
        created_at: e.created_at as string,
      }));
    },

    async getDrawerReconciliation(shiftId) {
      const shiftRow = unwrap(
        await sb.from("shifts").select("*").eq("id", shiftId).maybeSingle(),
      ) as Row | null;
      if (!shiftRow) throw new Error(`Shift ${shiftId} not found.`);
      const events = await this.listShiftCashEvents(shiftId);
      return reconcileFromEvents(mapShift(shiftRow), events);
    },

    async closeShift(input) {
      const r = unwrap(
        await sb
          .from("shifts")
          .update({
            status: "closed",
            closed_at: nowIso(),
            counted_cents: input.countedCents,
            close_note: input.note ?? null,
          })
          .eq("id", input.shiftId)
          .select()
          .maybeSingle(),
      ) as Row | null;
      return r ? mapShift(r) : null;
    },
  };

  return driver;
}
