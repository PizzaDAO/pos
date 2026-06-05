/**
 * Starter menu template (Phase 6 onboarding).
 *
 * Produces a fresh, tenant-scoped menu graph (categories → items → sizes +
 * modifier groups → modifiers) for a brand-new tenant during onboarding. Modeled
 * on the demo seed (`seed-data.ts`) so a new pizzeria starts with a sensible
 * "classic pizzeria" menu they can then edit, rather than a blank slate.
 *
 * All ids are generated per tenant so the new tenant's menu is fully isolated
 * from the demo tenant's. Money is integer cents.
 */
import type {
  ItemModifierGroup,
  ItemSize,
  MenuCategory,
  MenuItem,
  Modifier,
  ModifierGroup,
} from "@/lib/db/menu-types";

export interface MenuTemplate {
  categories: MenuCategory[];
  items: MenuItem[];
  sizes: ItemSize[];
  modifierGroups: ModifierGroup[];
  modifiers: Modifier[];
  itemModifierGroups: ItemModifierGroup[];
}

let templateSeq = 0;
function tid(prefix: string): string {
  templateSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${templateSeq}`;
}

/**
 * Build the "classic pizzeria" starter menu for `tenantId`: Pizzas (Margherita,
 * Pepperoni, Veggie) with S/M/L sizing + crust/sauce/topping modifier groups
 * (toppings half-and-half capable), plus Drinks and Sides. Quick-add tenants can
 * skip this and create items by hand later in /admin.
 */
export function buildStarterMenu(tenantId: string): MenuTemplate {
  // --- Categories ---
  const catPizzas: MenuCategory = {
    id: tid("cat"),
    tenant_id: tenantId,
    name: "Pizzas",
    sort_order: 1,
  };
  const catDrinks: MenuCategory = {
    id: tid("cat"),
    tenant_id: tenantId,
    name: "Drinks",
    sort_order: 2,
  };
  const catSides: MenuCategory = {
    id: tid("cat"),
    tenant_id: tenantId,
    name: "Sides",
    sort_order: 3,
  };

  // --- Modifier groups ---
  const grpCrust: ModifierGroup = {
    id: tid("mg"),
    tenant_id: tenantId,
    name: "Crust",
    min_select: 1,
    max_select: 1,
    supports_half: false,
  };
  const grpSauce: ModifierGroup = {
    id: tid("mg"),
    tenant_id: tenantId,
    name: "Sauce",
    min_select: 1,
    max_select: 1,
    supports_half: false,
  };
  const grpToppings: ModifierGroup = {
    id: tid("mg"),
    tenant_id: tenantId,
    name: "Toppings",
    min_select: 0,
    max_select: 10,
    supports_half: true,
  };

  const modifiers: Modifier[] = [
    { id: tid("mod"), group_id: grpCrust.id, name: "Hand-tossed", price_cents: 0, sort_order: 1 },
    { id: tid("mod"), group_id: grpCrust.id, name: "Thin", price_cents: 0, sort_order: 2 },
    { id: tid("mod"), group_id: grpCrust.id, name: "Deep dish", price_cents: 200, sort_order: 3 },
    { id: tid("mod"), group_id: grpSauce.id, name: "Tomato", price_cents: 0, sort_order: 1 },
    { id: tid("mod"), group_id: grpSauce.id, name: "White", price_cents: 100, sort_order: 2 },
    { id: tid("mod"), group_id: grpToppings.id, name: "Mushrooms", price_cents: 150, sort_order: 1 },
    { id: tid("mod"), group_id: grpToppings.id, name: "Onions", price_cents: 150, sort_order: 2 },
    { id: tid("mod"), group_id: grpToppings.id, name: "Sausage", price_cents: 250, sort_order: 3 },
    { id: tid("mod"), group_id: grpToppings.id, name: "Extra cheese", price_cents: 200, sort_order: 4 },
  ];

  // --- Items ---
  const itemMargherita: MenuItem = {
    id: tid("item"),
    tenant_id: tenantId,
    category_id: catPizzas.id,
    name: "Margherita",
    description: "San Marzano tomato, fresh mozzarella, basil.",
    is_half_and_half_capable: true,
    station: "oven",
  };
  const itemPepperoni: MenuItem = {
    id: tid("item"),
    tenant_id: tenantId,
    category_id: catPizzas.id,
    name: "Pepperoni",
    description: "Tomato, mozzarella, pepperoni.",
    is_half_and_half_capable: true,
    station: "oven",
  };
  const itemVeggie: MenuItem = {
    id: tid("item"),
    tenant_id: tenantId,
    category_id: catPizzas.id,
    name: "Veggie",
    description: "Tomato, mozzarella, peppers, onions, mushrooms.",
    is_half_and_half_capable: true,
    station: "oven",
  };
  const itemSoda: MenuItem = {
    id: tid("item"),
    tenant_id: tenantId,
    category_id: catDrinks.id,
    name: "Fountain Soda",
    description: "Choice of fountain drink.",
    is_half_and_half_capable: false,
    station: "none",
  };
  const itemKnots: MenuItem = {
    id: tid("item"),
    tenant_id: tenantId,
    category_id: catSides.id,
    name: "Garlic Knots",
    description: "Fried dough knots, garlic butter, parmesan.",
    is_half_and_half_capable: false,
    station: "fryer",
  };

  const pizzaSizes = (itemId: string, base: number): ItemSize[] => [
    { id: tid("size"), item_id: itemId, name: 'Small (10")', price_cents: base, sort_order: 1 },
    { id: tid("size"), item_id: itemId, name: 'Medium (14")', price_cents: base + 400, sort_order: 2 },
    { id: tid("size"), item_id: itemId, name: 'Large (18")', price_cents: base + 800, sort_order: 3 },
  ];

  const sizes: ItemSize[] = [
    ...pizzaSizes(itemMargherita.id, 1099),
    ...pizzaSizes(itemPepperoni.id, 1299),
    ...pizzaSizes(itemVeggie.id, 1399),
    { id: tid("size"), item_id: itemSoda.id, name: "Regular", price_cents: 299, sort_order: 1 },
    { id: tid("size"), item_id: itemKnots.id, name: "6-piece", price_cents: 699, sort_order: 1 },
  ];

  // Link the three pizzas to crust/sauce/toppings.
  const itemModifierGroups: ItemModifierGroup[] = [];
  for (const pizza of [itemMargherita, itemPepperoni, itemVeggie]) {
    itemModifierGroups.push(
      { item_id: pizza.id, group_id: grpCrust.id, sort_order: 1 },
      { item_id: pizza.id, group_id: grpSauce.id, sort_order: 2 },
      { item_id: pizza.id, group_id: grpToppings.id, sort_order: 3 },
    );
  }

  return {
    categories: [catPizzas, catDrinks, catSides],
    items: [itemMargherita, itemPepperoni, itemVeggie, itemSoda, itemKnots],
    sizes,
    modifierGroups: [grpCrust, grpSauce, grpToppings],
    modifiers,
    itemModifierGroups,
  };
}
