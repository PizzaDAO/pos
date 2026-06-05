/**
 * In-memory seed mirroring `supabase/seed.sql` — Tony's Pizza, two locations,
 * margherita/pepperoni + a soda, sizes S/M/L, and crust/sauce/topping modifier
 * groups (toppings support half-and-half).
 *
 * UUIDs match the SQL seed so the mock and a future Supabase DB are consistent.
 */
import type {
  ItemModifierGroup,
  ItemSize,
  MenuCategory,
  MenuItem,
  Modifier,
  ModifierGroup,
  StoreSettings,
} from "./menu-types";
import type { PaymentSettings } from "./payment-types";
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
 * Per-location store settings (mock). Tax 8.25%, USD, a couple tip presets.
 * Phase 1 reads only currency + tax_rate_bps; tipping is Phase 2.
 */
export const storeSettings: StoreSettings[] = [
  {
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_DOWNTOWN_ID,
    currency: "USD",
    tax_rate_bps: 825,
    tip_presets_bps: [1500, 1800, 2000],
    kds_thresholds: { warn_seconds: 300, urgent_seconds: 600 },
  },
  {
    tenant_id: DEMO_TENANT_ID,
    location_id: DEMO_LOCATION_UPTOWN_ID,
    currency: "USD",
    tax_rate_bps: 825,
    tip_presets_bps: [1500, 1800, 2000],
    kds_thresholds: { warn_seconds: 300, urgent_seconds: 600 },
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
