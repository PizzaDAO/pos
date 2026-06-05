/**
 * KDS demo seed (mock-only, Phase 3).
 *
 * Produces a handful of open kitchen orders with varied AGES, STATIONS, and
 * STATUSES so the `/kitchen` board always renders content in the Vercel preview
 * — even on a cold serverless instance where the in-memory order Map is empty
 * (see the note in `mock.ts`). One order is a half-and-half pizza so the
 * left/right modifier rendering is exercised on the board.
 *
 * Ages are computed RELATIVE TO NOW at read time, so the seeded tickets show
 * realistic green/yellow/red coloring regardless of when the lambda spun up.
 * This file is mock-only and goes away once Supabase persists real orders.
 */
import type { HalfPlacement, Order, OrderItem, Station } from "./menu-types";
import { computeOrderTotals, withLinePricing } from "@/lib/pricing";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID } from "./seed-data";

interface SeedModifier {
  group: string;
  name: string;
  price: number;
  placement?: HalfPlacement;
}

interface SeedLine {
  itemId: string;
  name: string;
  station: Station;
  size: string | null;
  basePrice: number;
  quantity?: number;
  modifiers?: SeedModifier[];
  notes?: string | null;
}

let seedLineSeq = 0;
function seedLine(line: SeedLine): OrderItem {
  seedLineSeq += 1;
  const raw: OrderItem = {
    id: `kds-seed-line-${seedLineSeq}`,
    item_id: line.itemId,
    item_name: line.name,
    station: line.station,
    size_id: null,
    size_name: line.size,
    base_price_cents: line.basePrice,
    quantity: line.quantity ?? 1,
    modifiers: (line.modifiers ?? []).map((m, i) => ({
      group_id: `seed-grp-${m.group}`,
      group_name: m.group,
      modifier_id: `seed-mod-${seedLineSeq}-${i}`,
      modifier_name: m.name,
      price_cents: m.price,
      placement: m.placement ?? "whole",
    })),
    notes: line.notes ?? null,
    voided: false,
    unit_price_cents: 0,
    line_total_cents: 0,
  };
  return withLinePricing(raw);
}

interface SeedOrder {
  suffix: string;
  number: string;
  status: Order["status"];
  channel: Order["channel"];
  ageSeconds: number;
  notes?: string | null;
  lines: SeedLine[];
}

/** Static descriptors; `created_at` is filled in at generation time. */
const SEED_ORDERS: SeedOrder[] = [
  {
    suffix: "a1",
    number: "K-101",
    status: "in_kitchen",
    channel: "in_store",
    ageSeconds: 90, // fresh (green)
    lines: [
      {
        itemId: "30000000-0000-0000-0000-000000000002",
        name: "Pepperoni",
        station: "oven",
        size: 'Large (18")',
        basePrice: 2099,
        modifiers: [
          { group: "Crust", name: "Thin", price: 0 },
          { group: "Toppings", name: "Extra cheese", price: 200 },
        ],
        notes: "Well done",
      },
      {
        itemId: "30000000-0000-0000-0000-000000000010",
        name: "Fountain Soda",
        station: "none",
        size: "Regular",
        basePrice: 299,
        quantity: 2,
      },
    ],
  },
  {
    suffix: "a2",
    number: "K-102",
    status: "placed",
    channel: "online_pickup",
    ageSeconds: 360, // warn (yellow)
    notes: "Pickup at 6:30, name Dana",
    lines: [
      {
        itemId: "30000000-0000-0000-0000-000000000001",
        name: "Margherita",
        station: "oven",
        size: 'Medium (14")',
        basePrice: 1499,
        modifiers: [
          // Half-and-half: mushrooms left, sausage right.
          { group: "Toppings", name: "Mushrooms", price: 75, placement: "left" },
          { group: "Toppings", name: "Sausage", price: 125, placement: "right" },
        ],
      },
      {
        itemId: "30000000-0000-0000-0000-000000000020",
        name: "Caesar Salad",
        station: "cold",
        size: "Regular",
        basePrice: 899,
        notes: "Dressing on side",
      },
    ],
  },
  {
    suffix: "a3",
    number: "K-103",
    status: "in_kitchen",
    channel: "in_store",
    ageSeconds: 720, // urgent (red)
    lines: [
      {
        itemId: "30000000-0000-0000-0000-000000000030",
        name: "Garlic Knots",
        station: "fryer",
        size: "6-piece",
        basePrice: 699,
        quantity: 2,
      },
      {
        itemId: "30000000-0000-0000-0000-000000000002",
        name: "Pepperoni",
        station: "oven",
        size: 'Small (10")',
        basePrice: 1299,
      },
    ],
  },
  {
    suffix: "a4",
    number: "K-104",
    status: "ready",
    channel: "online_delivery",
    ageSeconds: 200, // fresh, but already bumped to ready
    notes: "Leave at door",
    lines: [
      {
        itemId: "30000000-0000-0000-0000-000000000001",
        name: "Margherita",
        station: "oven",
        size: 'Large (18")',
        basePrice: 1899,
      },
    ],
  },
];

export function seedKitchenOrders(): Order[] {
  seedLineSeq = 0;
  const now = Date.now();
  return SEED_ORDERS.map((seed) => {
    const items = seed.lines.map(seedLine);
    const totals = computeOrderTotals({
      items,
      discountCents: 0,
      taxRateBps: 825,
      tipCents: 0,
    });
    const createdAt = new Date(now - seed.ageSeconds * 1000).toISOString();
    return {
      id: `kds-seed-${seed.suffix}`,
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      status: seed.status,
      channel: seed.channel,
      currency: "USD",
      items,
      discount_cents: 0,
      totals,
      notes: seed.notes ?? null,
      order_number: seed.number,
      created_at: createdAt,
      updated_at: createdAt,
    } satisfies Order;
  });
}
