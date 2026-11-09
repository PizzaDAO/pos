/** Table + column map -> normalized {@link MenuImportPlan} with warnings. */
import type { Station } from "@/lib/db/menu-types";
import { detectFormat, mapColumns, type Field } from "./formats";
import { looksAmbiguousPrice, parsePriceCents } from "./price";
import type { MenuTable } from "./table";
import {
  IMPORT_LIMITS,
  MenuImportError,
  type ImportFormat,
  type ImportWarning,
  type MenuImportPlan,
  type PlanCategory,
  type PlanItem,
  type PlanModifierGroup,
} from "./types";

const TRUE = new Set(["y", "yes", "true", "1", "x"]);
const isTrue = (s: string) => TRUE.has(s.trim().toLowerCase());
const key = (s: string) => s.trim().toLowerCase();

/** Station heuristic by category wording; the generic template can override. */
export function guessStation(category: string): Station {
  const c = category.toLowerCase();
  if (/\b(drinks?|beverages?|sodas?|water|juices?|beers?|wines?|coffee|tea)\b/.test(c)) return "none";
  if (/\b(salads?|desserts?|cold|sandwich(es)?)\b/.test(c)) return "cold";
  if (/\b(wings?|fries|fried|sides?|appetizers?|starters?)\b/.test(c)) return "fryer";
  return "oven";
}

function parseStation(s: string): Station | null {
  const v = s.trim().toLowerCase();
  return (["oven", "cold", "fryer", "expo", "none"] as const).find((x) => x === v) ?? null;
}

function splitList(s: string): string[] {
  return s
    .split(/[;|,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function buildPlan(
  table: MenuTable,
  formatHint?: ImportFormat | "auto",
): MenuImportPlan {
  const format: ImportFormat =
    formatHint && formatHint !== "auto" ? formatHint : detectFormat(table.headers);
  const cols = mapColumns(table.headers);
  const found = table.headers.filter(Boolean).join(", ");
  if (!cols.fields.item) {
    throw new MenuImportError(
      `Could not find an item-name column. Looked for "Item Name", "Item", "Name" or similar; found: ${found}.`,
    );
  }
  if (!cols.fields.price) {
    throw new MenuImportError(
      `Could not find a price column. Looked for "Price" or similar; found: ${found}.`,
    );
  }

  const warnings: ImportWarning[] = [];
  const warn = (w: ImportWarning) => {
    // Cap per-row noise so a bad file can't make a giant response.
    if (warnings.length < 200) warnings.push(w);
  };
  const cell = (cells: string[], field: Field): string => {
    for (const i of cols.fields[field] ?? []) {
      const v = (cells[i] ?? "").trim();
      if (v !== "") return v;
    }
    return "";
  };
  const clip = (s: string, max: number, row: number, what: string) => {
    if (s.length <= max) return s;
    warn({ code: "truncated", row, message: `${what} longer than ${max} characters was shortened.` });
    return s.slice(0, max);
  };

  const categories = new Map<string, PlanCategory>();
  const itemByKey = new Map<string, PlanItem>();
  const categoriesByItemName = new Map<string, { name: string; cats: Set<string> }>();
  const groups = new Map<string, PlanModifierGroup>();
  let skippedRows = 0;
  let archivedSkipped = 0;
  let uncategorized = 0;
  let dataRows = 0;

  const getGroup = (name: string): PlanModifierGroup => {
    let g = groups.get(key(name));
    if (!g) {
      g = { name, min_select: 0, max_select: 1, supports_half: false, modifiers: [] };
      groups.set(key(name), g);
    }
    return g;
  };

  for (const { row, cells } of table.rows) {
    if (cells.every((c) => c.trim() === "")) continue;
    dataRows++;

    const archived = cell(cells, "archived");
    if (archived !== "" && isTrue(archived)) {
      archivedSkipped++;
      skippedRows++;
      continue;
    }

    const itemName = cell(cells, "item");

    // Modifier-definition row (generic template): no item, a group + an option.
    if (itemName === "") {
      const groupName = cell(cells, "defGroup");
      const optionName = cell(cells, "defOption");
      if (groupName && optionName) {
        const g = getGroup(clip(groupName, IMPORT_LIMITS.maxNameLength, row, "Group name"));
        const min = Number.parseInt(cell(cells, "defMin"), 10);
        const max = Number.parseInt(cell(cells, "defMax"), 10);
        if (Number.isInteger(min) && min >= 0) g.min_select = min;
        if (Number.isInteger(max) && max >= 1) g.max_select = max;
        if (g.max_select < g.min_select) g.max_select = g.min_select;
        if (cell(cells, "defHalf")) g.supports_half = isTrue(cell(cells, "defHalf"));
        const priceRaw = cell(cells, "defOptionPrice");
        const price = priceRaw === "" ? 0 : parsePriceCents(priceRaw);
        const oname = clip(optionName, IMPORT_LIMITS.maxNameLength, row, "Option name");
        if (price === null || price < 0 || price > IMPORT_LIMITS.maxPriceCents) {
          warn({ code: "invalid_price", row, message: `Option "${oname}" has an invalid price "${priceRaw}"; skipped.` });
          skippedRows++;
        } else if (g.modifiers.some((m) => key(m.name) === key(oname))) {
          warn({ code: "duplicate_modifier", row, message: `Option "${oname}" repeats in group "${g.name}"; kept the first.` });
          skippedRows++;
        } else {
          g.modifiers.push({ name: oname, price_cents: price });
        }
        continue;
      }
      warn({ code: "missing_name", row, message: "Row has no item name; skipped." });
      skippedRows++;
      continue;
    }

    const name = clip(itemName, IMPORT_LIMITS.maxNameLength, row, "Item name");
    let categoryName = cell(cells, "category").split(/[,;|]/)[0]?.trim() ?? "";
    if (categoryName === "") {
      categoryName = "Uncategorized";
      uncategorized++;
    }
    categoryName = clip(categoryName, IMPORT_LIMITS.maxNameLength, row, "Category name");

    const priceRaw = cell(cells, "price");
    const price = parsePriceCents(priceRaw);
    if (price === null) {
      warn({
        code:
          priceRaw === ""
            ? "missing_price"
            : looksAmbiguousPrice(priceRaw)
              ? "ambiguous_price"
              : "invalid_price",
        row,
        message:
          priceRaw === ""
            ? `"${name}" has no price (variable-price items can't be imported); skipped.`
            : looksAmbiguousPrice(priceRaw)
              ? `"${name}" has an ambiguous price "${priceRaw}" (use 12.50 or 12,50); skipped.`
              : `"${name}" has an unreadable price "${priceRaw}"; skipped.`,
      });
      skippedRows++;
      continue;
    }
    if (price < 0 || price > IMPORT_LIMITS.maxPriceCents) {
      warn({ code: "invalid_price", row, message: `"${name}" has an out-of-range price "${priceRaw}"; skipped.` });
      skippedRows++;
      continue;
    }

    let category = categories.get(key(categoryName));
    if (!category) {
      category = { name: categoryName, items: [] };
      categories.set(key(categoryName), category);
    }
    const itemKey = `${key(categoryName)}\u0000${key(name)}`;
    let item = itemByKey.get(itemKey);
    if (!item) {
      item = {
        name,
        description: null,
        station: parseStation(cell(cells, "station")) ?? guessStation(categoryName),
        half_and_half: isTrue(cell(cells, "half")),
        sizes: [],
        modifier_groups: [],
      };
      itemByKey.set(itemKey, item);
      category.items.push(item);
      const entry = categoriesByItemName.get(key(name)) ?? { name, cats: new Set<string>() };
      entry.cats.add(categoryName);
      categoriesByItemName.set(key(name), entry);
    }
    const desc = cell(cells, "description");
    if (desc && !item.description) {
      item.description = clip(desc, IMPORT_LIMITS.maxDescriptionLength, row, "Description");
    }

    const sizeName = clip(cell(cells, "variation") || "Regular", IMPORT_LIMITS.maxNameLength, row, "Size name");
    if (item.sizes.some((s) => key(s.name) === key(sizeName))) {
      warn({ code: "duplicate_size", row, message: `"${name}" repeats size "${sizeName}"; kept the first.` });
      skippedRows++;
    } else {
      item.sizes.push({ name: sizeName, price_cents: price });
    }

    const wanted = [
      ...splitList(cell(cells, "groups")),
      ...cols.modifierSetColumns.filter((c) => isTrue(cells[c.index] ?? "")).map((c) => c.name),
    ];
    for (const g of wanted) {
      if (!item.modifier_groups.some((x) => key(x) === key(g))) item.modifier_groups.push(g);
    }
  }

  if (itemByKey.size > IMPORT_LIMITS.maxItems) {
    throw new MenuImportError(
      `The file has more than ${IMPORT_LIMITS.maxItems} items. Split it and import in parts.`,
      413,
    );
  }

  // Drop items whose every row was skipped (no valid size), then empty categories.
  for (const category of categories.values()) {
    category.items = category.items.filter((i) => i.sizes.length > 0);
  }
  const finalCategories = [...categories.values()].filter((c) => c.items.length > 0);
  const finalItems = finalCategories.reduce((n, c) => n + c.items.length, 0);
  if (finalItems === 0) {
    throw new MenuImportError(
      "No importable items were found. Check that the file has item names and prices.",
    );
  }

  for (const { name, cats } of categoriesByItemName.values()) {
    if (cats.size > 1) {
      warn({
        code: "name_in_multiple_categories",
        message: `"${name}" appears in more than one category (${[...cats].join(", ")}); imported as separate items.`,
      });
    }
  }
  if (archivedSkipped > 0) {
    warn({
      code: "skipped_archived",
      message: `${archivedSkipped} archived/hidden row${archivedSkipped === 1 ? "" : "s"} skipped.`,
    });
  }
  if (uncategorized > 0) {
    warn({
      code: "uncategorized",
      message: `${uncategorized} row${uncategorized === 1 ? " has" : "s have"} no category and went into "Uncategorized".`,
    });
  }
  if (cols.unknown.length > 0) {
    warn({
      code: "unknown_columns",
      message: `Ignored unrecognised column${cols.unknown.length === 1 ? "" : "s"}: ${cols.unknown.join(", ")}.`,
    });
  }

  const finalGroups = [...groups.values()].filter((g) => g.modifiers.length > 0);
  return {
    format,
    categories: finalCategories,
    modifierGroups: finalGroups,
    warnings,
    unknownColumns: cols.unknown,
    stats: {
      format,
      rows: dataRows,
      skippedRows,
      categories: finalCategories.length,
      items: finalItems,
      sizes: finalCategories.reduce(
        (n, c) => n + c.items.reduce((m, i) => m + i.sizes.length, 0),
        0,
      ),
      modifierGroups: finalGroups.length,
      modifiers: finalGroups.reduce((n, g) => n + g.modifiers.length, 0),
    },
  };
}
