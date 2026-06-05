/**
 * In-memory seed mirroring `supabase/seed.sql` — Tony's Pizza, two locations,
 * margherita/pepperoni + a soda, sizes S/M/L, and crust/sauce/topping modifier
 * groups (toppings support half-and-half).
 *
 * UUIDs match the SQL seed so the mock and a future Supabase DB are consistent.
 */
import type {
  DayHours,
  FulfillmentSettings,
  ItemModifierGroup,
  ItemSize,
  MenuCategory,
  MenuItem,
  Modifier,
  ModifierGroup,
  StoreSettings,
} from "./menu-types";
import type { PaymentSettings } from "./payment-types";
import type {
  InventoryItem,
  ItemInventoryLink,
  Staff,
} from "./backoffice-types";
import type { Location, Tenant } from "./types";

export const DEMO_TENANT_ID = "10000000-0000-0000-0000-000000000001";
export const DEMO_LOCATION_DOWNTOWN_ID =
  "10000000-0000-0000-0000-000000000101";
export const DEMO_LOCATION_UPTOWN_ID = "10000000-0000-0000-0000-000000000102";

/** The hardcoded demo tenant + location the Phase 1 terminal operates as. */
export const DEMO_CONTEXT = {
  tenantId: DEMO_TENANT_ID,
  locationId: DEMO_LOCATION_DOWNTOWN_ID,
} as const;

const NOW = "2025-01-01T00:00:00.000Z";

export const tenants: Tenant[] = [
  {
    id: DEMO_TENANT_ID,
    name: "Tony's Pizza",
    slug: "tonys-pizza",
    status: "active",
    created_at: NOW,
  },
];

export const locations: Location[] = [
  {
    id: DEMO_LOCATION_DOWNTOWN_ID,
    tenant_id: DEMO_TENANT_ID,
    name: "Tony's Downtown",
    slug: "tonys-downtown",
    timezone: "America/New_York",
    address: "123 Main St, Springfield",
    created_at: NOW,
  },
  {
    id: DEMO_LOCATION_UPTOWN_ID,
    tenant_id: DEMO_TENANT_ID,
    name: "Tony's Uptown",
    slug: "tonys-uptown",
    timezone: "America/New_York",
    address: "900 North Ave, Springfield",
    created_at: NOW,
  },
];

export const menuCategories: MenuCategory[] = [
  {
    id: "20000000-0000-0000-0000-000000000001",
    tenant_id: DEMO_TENANT_ID,
    name: "Pizzas",
    sort_order: 1,
  },
  {
    id: "20000000-0000-0000-0000-000000000002",
    tenant_id: DEMO_TENANT_ID,
    name: "Drinks",
    sort_order: 2,
  },
  {
    id: "20000000-0000-0000-0000-000000000003",
    tenant_id: DEMO_TENANT_ID,
    name: "Sides",
    sort_order: 3,
  },
];

export const menuItems: MenuItem[] = [
  {
    id: "30000000-0000-0000-0000-000000000001",
    tenant_id: DEMO_TENANT_ID,
    category_id: "20000000-0000-0000-0000-000000000001",
    name: "Margherita",
    description: "San Marzano tomato, fresh mozzarella, basil.",
    is_half_and_half_capable: true,
    station: "oven",
  },
  {
    id: "30000000-0000-0000-0000-000000000002",
    tenant_id: DEMO_TENANT_ID,
    category_id: "20000000-0000-0000-0000-000000000001",
    name: "Pepperoni",
    description: "Tomato, mozzarella, pepperoni.",
    is_half_and_half_capable: true,
    station: "oven",
  },
  {
    id: "30000000-0000-0000-0000-000000000010",
    tenant_id: DEMO_TENANT_ID,
    category_id: "20000000-0000-0000-0000-000000000002",
    name: "Fountain Soda",
    description: "Choice of fountain drink.",
    is_half_and_half_capable: false,
    station: "none",
  },
  {
    id: "30000000-0000-0000-0000-000000000020",
    tenant_id: DEMO_TENANT_ID,
    category_id: "20000000-0000-0000-0000-000000000003",
    name: "Caesar Salad",
    description: "Romaine, parmesan, croutons, Caesar dressing.",
    is_half_and_half_capable: false,
    station: "cold",
  },
  {
    id: "30000000-0000-0000-0000-000000000030",
    tenant_id: DEMO_TENANT_ID,
    category_id: "20000000-0000-0000-0000-000000000003",
    name: "Garlic Knots",
    description: "Fried dough knots, garlic butter, parmesan.",
    is_half_and_half_capable: false,
    station: "fryer",
  },
];

export const itemSizes: ItemSize[] = [
  // Margherita S/M/L
  {
    id: "40000000-0000-0000-0000-000000000001",
    item_id: "30000000-0000-0000-0000-000000000001",
    name: 'Small (10")',
    price_cents: 1099,
    sort_order: 1,
  },
  {
    id: "40000000-0000-0000-0000-000000000002",
    item_id: "30000000-0000-0000-0000-000000000001",
    name: 'Medium (14")',
    price_cents: 1499,
    sort_order: 2,
  },
  {
    id: "40000000-0000-0000-0000-000000000003",
    item_id: "30000000-0000-0000-0000-000000000001",
    name: 'Large (18")',
    price_cents: 1899,
    sort_order: 3,
  },
  // Pepperoni S/M/L
  {
    id: "40000000-0000-0000-0000-000000000011",
    item_id: "30000000-0000-0000-0000-000000000002",
    name: 'Small (10")',
    price_cents: 1299,
    sort_order: 1,
  },
  {
    id: "40000000-0000-0000-0000-000000000012",
    item_id: "30000000-0000-0000-0000-000000000002",
    name: 'Medium (14")',
    price_cents: 1699,
    sort_order: 2,
  },
  {
    id: "40000000-0000-0000-0000-000000000013",
    item_id: "30000000-0000-0000-0000-000000000002",
    name: 'Large (18")',
    price_cents: 2099,
    sort_order: 3,
  },
  // Fountain Soda (single size)
  {
    id: "40000000-0000-0000-0000-000000000021",
    item_id: "30000000-0000-0000-0000-000000000010",
    name: "Regular",
    price_cents: 299,
    sort_order: 1,
  },
  // Caesar Salad (single size)
  {
    id: "40000000-0000-0000-0000-000000000031",
    item_id: "30000000-0000-0000-0000-000000000020",
    name: "Regular",
    price_cents: 899,
    sort_order: 1,
  },
  // Garlic Knots (single size)
  {
    id: "40000000-0000-0000-0000-000000000041",
    item_id: "30000000-0000-0000-0000-000000000030",
    name: "6-piece",
    price_cents: 699,
    sort_order: 1,
  },
];

export const modifierGroups: ModifierGroup[] = [
  {
    id: "50000000-0000-0000-0000-000000000001",
    tenant_id: DEMO_TENANT_ID,
    name: "Crust",
    min_select: 1,
    max_select: 1,
    supports_half: false,
  },
  {
    id: "50000000-0000-0000-0000-000000000002",
    tenant_id: DEMO_TENANT_ID,
    name: "Sauce",
    min_select: 1,
    max_select: 1,
    supports_half: false,
  },
  {
    id: "50000000-0000-0000-0000-000000000003",
    tenant_id: DEMO_TENANT_ID,
    name: "Toppings",
    min_select: 0,
    max_select: 10,
    supports_half: true,
  },
];

export const modifiers: Modifier[] = [
  // Crust
  {
    id: "60000000-0000-0000-0000-000000000001",
    group_id: "50000000-0000-0000-0000-000000000001",
    name: "Hand-tossed",
    price_cents: 0,
    sort_order: 1,
  },
  {
    id: "60000000-0000-0000-0000-000000000002",
    group_id: "50000000-0000-0000-0000-000000000001",
    name: "Thin",
    price_cents: 0,
    sort_order: 2,
  },
  {
    id: "60000000-0000-0000-0000-000000000003",
    group_id: "50000000-0000-0000-0000-000000000001",
    name: "Deep dish",
    price_cents: 200,
    sort_order: 3,
  },
  // Sauce
  {
    id: "60000000-0000-0000-0000-000000000011",
    group_id: "50000000-0000-0000-0000-000000000002",
    name: "Tomato",
    price_cents: 0,
    sort_order: 1,
  },
  {
    id: "60000000-0000-0000-0000-000000000012",
    group_id: "50000000-0000-0000-0000-000000000002",
    name: "White",
    price_cents: 100,
    sort_order: 2,
  },
  // Toppings (half-and-half capable)
  {
    id: "60000000-0000-0000-0000-000000000021",
    group_id: "50000000-0000-0000-0000-000000000003",
    name: "Mushrooms",
    price_cents: 150,
    sort_order: 1,
  },
  {
    id: "60000000-0000-0000-0000-000000000022",
    group_id: "50000000-0000-0000-0000-000000000003",
    name: "Onions",
    price_cents: 150,
    sort_order: 2,
  },
  {
    id: "60000000-0000-0000-0000-000000000023",
    group_id: "50000000-0000-0000-0000-000000000003",
    name: "Sausage",
    price_cents: 250,
    sort_order: 3,
  },
  {
    id: "60000000-0000-0000-0000-000000000024",
    group_id: "50000000-0000-0000-0000-000000000003",
    name: "Extra cheese",
    price_cents: 200,
    sort_order: 4,
  },
];

export const itemModifierGroups: ItemModifierGroup[] = [
  // Margherita
  {
    item_id: "30000000-0000-0000-0000-000000000001",
    group_id: "50000000-0000-0000-0000-000000000001",
    sort_order: 1,
  },
  {
    item_id: "30000000-0000-0000-0000-000000000001",
    group_id: "50000000-0000-0000-0000-000000000002",
    sort_order: 2,
  },
  {
    item_id: "30000000-0000-0000-0000-000000000001",
    group_id: "50000000-0000-0000-0000-000000000003",
    sort_order: 3,
  },
  // Pepperoni
  {
    item_id: "30000000-0000-0000-0000-000000000002",
    group_id: "50000000-0000-0000-0000-000000000001",
    sort_order: 1,
  },
  {
    item_id: "30000000-0000-0000-0000-000000000002",
    group_id: "50000000-0000-0000-0000-000000000002",
    sort_order: 2,
  },
  {
    item_id: "30000000-0000-0000-0000-000000000002",
    group_id: "50000000-0000-0000-0000-000000000003",
    sort_order: 3,
  },
];

/**
 * Mock weekly hours (Phase 4 online-ordering gate). Open Mon–Thu + Sun
 * 11:00–22:00, Fri–Sat 11:00–23:00. Deterministic so the storefront's
 * ASAP/scheduled gating behaves the same in every preview instance.
 */
function weeklyHours(): DayHours[] {
  const out: DayHours[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const lateNight = weekday === 5 || weekday === 6; // Fri/Sat
    out.push({
      weekday,
      open: "11:00",
      close: lateNight ? "23:00" : "22:00",
      closed: false,
    });
  }
  return out;
}

/**
 * Per-location fulfillment config (Phase 4). Downtown offers pickup + delivery
 * with two zones; Uptown is pickup-only. The in-house provider is preferred and
 * DoorDash Drive is offered as a fallback (simulated when unkeyed).
 */
const downtownFulfillment: FulfillmentSettings = {
  pickup_enabled: true,
  delivery_enabled: true,
  prep_minutes: 20,
  scheduling_lead_minutes: 15,
  scheduling_horizon_days: 5,
  hours: weeklyHours(),
  delivery_providers: ["in_house_manual", "doordash_drive"],
  pickup_address: "123 Main St, Springfield",
  delivery_zones: [
    {
      id: "zone-near",
      name: "Downtown core",
      postal_codes: ["10001", "10002", "10003"],
      fee_cents: 399,
      eta_minutes: 30,
      min_subtotal_cents: 0,
    },
    {
      id: "zone-far",
      name: "Greater Springfield",
      postal_codes: ["10010", "10011", "10012"],
      fee_cents: 699,
      eta_minutes: 45,
      min_subtotal_cents: 2000,
    },
  ],
};

const uptownFulfillment: FulfillmentSettings = {
  pickup_enabled: true,
  delivery_enabled: false,
  prep_minutes: 25,
  scheduling_lead_minutes: 15,
  scheduling_horizon_days: 5,
  hours: weeklyHours(),
  delivery_providers: [],
  pickup_address: "900 North Ave, Springfield",
  delivery_zones: [],
};

/**
 * Per-location store settings (mock). Tax 8.25%, USD, a couple tip presets.
 * Phase 1 reads only currency + tax_rate_bps; tipping is Phase 2; Phase 4 adds
 * fulfillment (hours, prep, delivery zones/providers).
 */
export const storeSettings: StoreSettings[] = [
  {
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    currency: "USD",
    tax_rate_bps: 825,
    tip_presets_bps: [1500, 1800, 2000],
    kds_thresholds: { warn_seconds: 300, urgent_seconds: 600 },
    fulfillment: downtownFulfillment,
  },
  {
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_UPTOWN_ID,
    currency: "USD",
    tax_rate_bps: 825,
    tip_presets_bps: [1500, 1800, 2000],
    kds_thresholds: { warn_seconds: 300, urgent_seconds: 600 },
    fulfillment: uptownFulfillment,
  },
];

/**
 * Per-tenant/location payment settings (mock). Platform fee 2.5% + $0.10 per
 * card order (taken via Connect application_fee), tip presets 15/18/20%.
 * Phase 2 reads these to compute the application fee + tip suggestions.
 */
export const paymentSettings: PaymentSettings[] = [
  {
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    currency: "USD",
    platform_fee_bps: 250,
    platform_fee_flat_cents: 10,
    tip_presets_bps: [1500, 1800, 2000],
  },
  {
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_UPTOWN_ID,
    currency: "USD",
    platform_fee_bps: 250,
    platform_fee_flat_cents: 10,
    tip_presets_bps: [1500, 1800, 2000],
  },
];

// ----------------------------------------------------------------------------
// Phase 5 back-office seed: inventory (per location), inventory→menu links, and
// staff. Inventory is per-location so each location has its own stock row; the
// links are tenant-level (a menu element consumes the same recipe everywhere)
// and the depletion logic resolves the row for the order's location.
// ----------------------------------------------------------------------------

const INV_DOUGH_DT = "70000000-0000-0000-0000-000000000001";
const INV_CHEESE_DT = "70000000-0000-0000-0000-000000000002";
const INV_PEPPERONI_DT = "70000000-0000-0000-0000-000000000003";
const INV_DOUGH_UP = "70000000-0000-0000-0000-000000000101";
const INV_CHEESE_UP = "70000000-0000-0000-0000-000000000102";
const INV_PEPPERONI_UP = "70000000-0000-0000-0000-000000000103";

/**
 * Per-location stock. Downtown pepperoni is intentionally seeded near its low
 * threshold so a couple of pepperoni-pizza sales trip the low-stock alert in
 * the demo. Quantities are integers in the item's unit (grams / each).
 */
export const inventoryItems: InventoryItem[] = [
  {
    id: INV_DOUGH_DT,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    name: "Pizza dough ball",
    unit: "each",
    on_hand: 80,
    low_threshold: 20,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: INV_CHEESE_DT,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    name: "Mozzarella",
    unit: "g",
    on_hand: 20000,
    low_threshold: 5000,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: INV_PEPPERONI_DT,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    name: "Pepperoni",
    unit: "g",
    on_hand: 600,
    low_threshold: 500,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: INV_DOUGH_UP,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_UPTOWN_ID,
    name: "Pizza dough ball",
    unit: "each",
    on_hand: 60,
    low_threshold: 15,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: INV_CHEESE_UP,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_UPTOWN_ID,
    name: "Mozzarella",
    unit: "g",
    on_hand: 15000,
    low_threshold: 5000,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: INV_PEPPERONI_UP,
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_UPTOWN_ID,
    name: "Pepperoni",
    unit: "g",
    on_hand: 4000,
    low_threshold: 500,
    created_at: NOW,
    updated_at: NOW,
  },
];

const ITEM_MARGHERITA = "30000000-0000-0000-0000-000000000001";
const ITEM_PEPPERONI = "30000000-0000-0000-0000-000000000002";
const MOD_EXTRA_CHEESE = "60000000-0000-0000-0000-000000000024";

/**
 * Recipe links (tenant-level): selling a pizza consumes a dough ball + cheese;
 * the Pepperoni pizza also consumes pepperoni; the "Extra cheese" topping
 * modifier consumes more mozzarella. Depletion resolves the per-location stock
 * row (same name) for the order's location. Keeping these tenant-level keeps the
 * seed small; a real schema would scope a recipe per location.
 */
export const itemInventoryLinks: ItemInventoryLink[] = [
  {
    id: "71000000-0000-0000-0000-000000000001",
    tenant_id: DEMO_TENANT_ID,
    source_type: "item",
    source_id: ITEM_MARGHERITA,
    inventory_item_id: INV_DOUGH_DT, // resolved by name per location at depletion
    qty_per_unit: 1,
  },
  {
    id: "71000000-0000-0000-0000-000000000002",
    tenant_id: DEMO_TENANT_ID,
    source_type: "item",
    source_id: ITEM_MARGHERITA,
    inventory_item_id: INV_CHEESE_DT,
    qty_per_unit: 150,
  },
  {
    id: "71000000-0000-0000-0000-000000000003",
    tenant_id: DEMO_TENANT_ID,
    source_type: "item",
    source_id: ITEM_PEPPERONI,
    inventory_item_id: INV_DOUGH_DT,
    qty_per_unit: 1,
  },
  {
    id: "71000000-0000-0000-0000-000000000004",
    tenant_id: DEMO_TENANT_ID,
    source_type: "item",
    source_id: ITEM_PEPPERONI,
    inventory_item_id: INV_CHEESE_DT,
    qty_per_unit: 150,
  },
  {
    id: "71000000-0000-0000-0000-000000000005",
    tenant_id: DEMO_TENANT_ID,
    source_type: "item",
    source_id: ITEM_PEPPERONI,
    inventory_item_id: INV_PEPPERONI_DT,
    qty_per_unit: 80,
  },
  {
    id: "71000000-0000-0000-0000-000000000006",
    tenant_id: DEMO_TENANT_ID,
    source_type: "modifier",
    source_id: MOD_EXTRA_CHEESE,
    inventory_item_id: INV_CHEESE_DT,
    qty_per_unit: 75,
  },
];

/** Demo staff covering each role for the staff-view / shift demos. */
export const staff: Staff[] = [
  {
    id: "80000000-0000-0000-0000-000000000001",
    tenant_id: DEMO_TENANT_ID,
    name: "Tony Soprano",
    role: "owner",
    active: true,
    created_at: NOW,
  },
  {
    id: "80000000-0000-0000-0000-000000000002",
    tenant_id: DEMO_TENANT_ID,
    name: "Carmela M.",
    role: "manager",
    active: true,
    created_at: NOW,
  },
  {
    id: "80000000-0000-0000-0000-000000000003",
    tenant_id: DEMO_TENANT_ID,
    name: "Christopher M.",
    role: "cashier",
    active: true,
    created_at: NOW,
  },
  {
    id: "80000000-0000-0000-0000-000000000004",
    tenant_id: DEMO_TENANT_ID,
    name: "Furio G.",
    role: "kitchen",
    active: true,
    created_at: NOW,
  },
];
