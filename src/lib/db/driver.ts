/**
 * PosDriver — the DB-agnostic data-access contract the terminal depends on.
 *
 * Phase 1 ships a single in-memory implementation (`mock.ts`) seeded from the
 * sample pizzeria. A Supabase-backed implementation drops in later behind the
 * same interface WITHOUT touching any UI/call site. Selection happens in
 * `index.ts` via `getPosDriver()`.
 */
import type {
  CreateOrderInput,
  Menu,
  Order,
  StoreSettings,
} from "./menu-types";

export interface PosDriver {
  /** Stable id of the active driver implementation (for diagnostics/UX). */
  readonly name: "mock" | "supabase";

  /** Fully-assembled menu graph for a location (categories → items → sizes/modifiers). */
  getMenu(tenantId: string, locationId: string): Promise<Menu>;

  /** Per-location store settings (tax rate, currency, tip presets). */
  getStoreSettings(
    tenantId: string,
    locationId: string,
  ): Promise<StoreSettings>;

  /**
   * Idempotent upsert-by-UUID. Creating with an id that already exists returns
   * the existing order unchanged (so offline retries never duplicate). Assigns
   * an order number + timestamps on first write.
   */
  createOrder(input: CreateOrderInput): Promise<Order>;

  /** Fetch a single order by its client UUID, or null. */
  getOrder(id: string): Promise<Order | null>;

  /** List recent orders for a location (newest first). */
  listOrders(tenantId: string, locationId: string): Promise<Order[]>;
}
