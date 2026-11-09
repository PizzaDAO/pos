/**
 * The documented generic CSV template (downloadable from the import UI).
 *
 * One row per item SIZE (an item with three sizes is three rows with the same
 * category + item). Modifier groups are defined in rows with NO item: a group
 * name + an option. Items then attach groups by name in `modifier_groups`.
 */
export const GENERIC_TEMPLATE_COLUMNS = [
  "category",
  "item",
  "description",
  "size",
  "price",
  "station",
  "half_and_half",
  "modifier_groups",
  "group",
  "group_min",
  "group_max",
  "option",
  "option_price",
] as const;

export const GENERIC_TEMPLATE_CSV = [
  GENERIC_TEMPLATE_COLUMNS.join(","),
  'Pizzas,Margherita,"Tomato, mozzarella, basil",Small,12.00,oven,yes,Toppings;Crust,,,,,',
  "Pizzas,Margherita,,Large,18.00,,,,,,,,",
  "Pizzas,Pepperoni,Classic pepperoni,Large,19.50,oven,yes,Toppings;Crust,,,,,",
  "Drinks,Cola,,Can,2.50,none,,,,,,,",
  "Sides,Garlic Knots,Six knots with marinara,Regular,6.00,fryer,,,,,,,",
  ",,,,,,,,Crust,1,1,Thin,0.00",
  ",,,,,,,,Crust,1,1,Thick,1.00",
  ",,,,,,,,Toppings,0,5,Mushrooms,1.50",
  ",,,,,,,,Toppings,0,5,Extra cheese,2.00",
].join("\r\n") + "\r\n";

export const GENERIC_TEMPLATE_NOTES: { column: string; note: string }[] = [
  { column: "category", note: "Menu section, e.g. Pizzas. Blank rows go to \"Uncategorized\"." },
  { column: "item", note: "Item name. Leave blank only on modifier-group rows (see below)." },
  { column: "description", note: "Optional text shown on the menu." },
  { column: "size", note: "Size or variation name. Blank = \"Regular\". Repeat the item on another row for more sizes." },
  { column: "price", note: "Price for this size in dollars, e.g. 12.50 or $12.50 (stored as integer cents). Required." },
  { column: "station", note: "Kitchen station: oven, cold, fryer, expo or none. Blank = guessed from the category." },
  { column: "half_and_half", note: "yes/no: can be built half-and-half. Blank = no." },
  { column: "modifier_groups", note: "Names of groups to attach to this item, separated by ; (defined in group rows)." },
  { column: "group", note: "Modifier-group rows only (item blank): the group name." },
  { column: "group_min / group_max", note: "Modifier-group rows only: fewest / most options a guest may pick. Defaults 0 and 1." },
  { column: "option / option_price", note: "Modifier-group rows only: one option and its up-charge in dollars (blank = 0)." },
];
