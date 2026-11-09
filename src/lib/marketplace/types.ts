/**
 * Marketplace inbox contract (DoorDash Marketplace, Uber Eats, Grubhub).
 *
 * Mirrors the delivery/payment provider design: core code (ingest, routes, UI)
 * depends ONLY on {@link MarketplaceAdapter} and the registry, never on a
 * specific provider's payload. Each adapter does five jobs:
 *
 *   verifyWebhook  prove the request came from the provider (HMAC over the raw body)
 *   parseWebhook   classify the event: a full order, a reference to fetch, a cancel
 *   fetchOrder     (Uber Eats style) pull the full order a webhook only points at
 *   respond        accept / reject / ready status callbacks to the provider
 *   syncMenu       menu + item availability push (stub)
 *
 * Everything is INERT by default: no adapter makes a network call unless the
 * location has the marketplace enabled AND the provider's credentials are in env
 * (see env.ts). The simulator adapter needs neither and never leaves the process.
 *
 * Money is integer cents throughout.
 */
import type { MarketplaceProviderKey } from "@/lib/db";

export type { MarketplaceProviderKey };

export const MARKETPLACE_PROVIDERS: readonly MarketplaceProviderKey[] = [
  "doordash",
  "ubereats",
  "grubhub",
  "simulator",
];

export function isMarketplaceProvider(v: string): v is MarketplaceProviderKey {
  return (MARKETPLACE_PROVIDERS as readonly string[]).includes(v);
}

/** Human label for a provider (badges, reports). */
export function providerLabel(p: MarketplaceProviderKey | string): string {
  switch (p) {
    case "doordash":
      return "DoorDash";
    case "ubereats":
      return "Uber Eats";
    case "grubhub":
      return "Grubhub";
    case "simulator":
      return "Simulator";
    default:
      return p;
  }
}

/** Whether the provider's public developer docs back the adapter (see each adapter). */
export type DocsStatus = "public" | "partly_public" | "unverified";

export interface NormalizedModifier {
  name: string;
  /** Per-unit upcharge in cents (0 when included). */
  priceCents: number;
}

export interface NormalizedLine {
  /** The provider's id for the menu item (stable across orders). */
  externalItemId: string;
  name: string;
  quantity: number;
  /** Per-unit price in cents, modifiers NOT included. */
  unitPriceCents: number;
  modifiers: NormalizedModifier[];
  notes: string | null;
}

/** A provider order in one shape, before it becomes a POS order. */
export interface NormalizedOrder {
  provider: MarketplaceProviderKey;
  /** The provider's order id. Unique per provider + location. */
  externalId: string;
  /** Short customer-facing code printed on the provider's tablet. */
  displayId: string | null;
  /** The provider's store id this order was sent to. */
  storeId: string | null;
  currency: string;
  lines: NormalizedLine[];
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  /** Provider-reported grand total, when it gave one. */
  totalCents: number | null;
  fulfillment: "pickup" | "delivery";
  /** ISO time the customer wants it by; null = ASAP. */
  scheduledFor: string | null;
  placedAt: string | null;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
}

export type ParsedWebhook =
  | { kind: "order"; order: NormalizedOrder }
  /** The webhook only points at the order; call {@link MarketplaceAdapter.fetchOrder}. */
  | { kind: "order_ref"; externalId: string; href: string | null }
  | { kind: "cancel"; externalId: string; reason: string | null }
  | { kind: "ignore"; reason: string };

export interface WebhookRequest {
  rawBody: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Injectable clock (replay-window checks). */
  now?: Date;
}

export type MarketplaceAction = "accept" | "reject" | "ready";

export interface ProviderCallResult {
  outcome: "sent" | "skipped" | "failed";
  detail?: string;
}

/** Context for every outbound call. `fetch` is injectable so tests never hit the network. */
export interface MarketplaceCallContext {
  tenantId: string;
  locationId: string;
  /** The provider's store id for this location. */
  storeId: string | null;
  fetch: typeof fetch;
}

export interface MarketplaceAdapter {
  readonly key: MarketplaceProviderKey;
  readonly docs: DocsStatus;
  /** Env the real provider needs; empty for the simulator. */
  verifyWebhook(req: WebhookRequest, secret: string): boolean;
  parseWebhook(rawBody: string): ParsedWebhook;
  fetchOrder?(
    ref: { externalId: string; href: string | null },
    ctx: MarketplaceCallContext,
  ): Promise<NormalizedOrder>;
  respond(
    action: MarketplaceAction,
    order: { externalId: string; reason?: string | null },
    ctx: MarketplaceCallContext,
  ): Promise<ProviderCallResult>;
  syncMenu(
    items: { externalItemId: string; available: boolean }[],
    ctx: MarketplaceCallContext,
  ): Promise<ProviderCallResult>;
}

export class MarketplaceError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "not_configured"
      | "bad_signature"
      | "bad_payload"
      | "unknown_provider"
      | "not_found"
      | "invalid_state",
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}
