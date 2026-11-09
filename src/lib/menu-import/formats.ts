/**
 * Header mapping for Square / Toast / Clover / generic menu exports.
 *
 * VERIFICATION STATUS (be honest in the UI + PR): no real export samples were
 * available when this was written. Column names below come from the vendors'
 * documented/remembered export layouts and are mapped TOLERANTLY by normalized
 * header synonyms, so renamed or extra columns still work. Fixtures in
 * __fixtures__/ follow those layouts but are hand-built, not vendor-generated.
 *   - Square item library (CSV/XLSX "Items" sheet): inferred.
 *   - Clover inventory export (CSV): inferred.
 *   - Toast menu export (CSV): inferred (least certain; synonyms only).
 *   - Generic template: ours, fully specified (template.ts).
 */
import type { ImportFormat } from "./types";

export type Field =
  | "category"
  | "item"
  | "variation"
  | "price"
  | "description"
  | "station"
  | "half"
  | "groups"
  | "archived"
  | "defGroup"
  | "defMin"
  | "defMax"
  | "defHalf"
  | "defOption"
  | "defOptionPrice";

/** Normalized-header synonyms per field, highest priority first. */
const SYNONYMS: Record<Field, string[]> = {
  category: [
    "categories",
    "category",
    "reportingcategory",
    "menugroup",
    "menucategory",
    "department",
    "section",
  ],
  item: [
    "itemname",
    "item",
    "name",
    "productname",
    "menuitemname",
    "menuitem",
    "itemtitle",
    "title",
  ],
  variation: ["variationname", "variation", "size", "sizename", "variant", "optionvalue1"],
  price: [
    "price",
    "baseprice",
    "itemprice",
    "unitprice",
    "regularprice",
    "defaultprice",
  ],
  description: ["description", "itemdescription", "desc"],
  station: ["station", "kitchenstation"],
  half: ["halfandhalf", "halfandhalfcapable", "ishalfandhalfcapable"],
  groups: [
    "modifiergroups",
    "modifiergroup",
    "modifiersets",
    "modifierlists",
    "modifiersetnames",
  ],
  archived: ["archived", "isarchived", "hidden", "deleted"],
  defGroup: ["group", "groupname"],
  defMin: ["groupmin", "groupminselect"],
  defMax: ["groupmax", "groupmaxselect"],
  defHalf: ["grouphalf", "groupsupportshalf"],
  defOption: ["option", "optionname"],
  defOptionPrice: ["optionprice"],
};

/** Columns we recognise but deliberately do not import (no "unknown" warning). */
const IGNORED_EXACT = new Set([
  "token",
  "sku",
  "gtin",
  "upc",
  "productcode",
  "cloverid",
  "alternatename",
  "pricetype",
  "priceunit",
  "taxrates",
  "cost",
  "quantity",
  "printerlabels",
  "nonrevenueitem",
  "itemid",
  "itemguid",
  "guid",
  "id",
  "masterid",
  "plu",
  "visibility",
  "seotitle",
  "seodescription",
  "permalink",
  "itemtype",
  "weightlb",
  "shippingenabled",
  "selfserveorderingenabled",
  "deliveryenabled",
  "pickupenabled",
  "onlinesaleprice",
  "sellable",
  "stockable",
  "skipdetailscreeninpos",
  "defaultunitcost",
  "squareonlineitemvisibility",
  "menu",
  "menuname",
  "taxrate",
  "taxable",
  "imageurl",
  "image",
  "calories",
  "sortorder",
]);
const IGNORED_PREFIX = [
  "optionname",
  "optionvalue",
  "defaultvendor",
  "currentquantity",
  "newquantity",
  "stockalert",
  "tax",
  "socialmedia",
];

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ColumnMap {
  /** Field -> column indexes in priority order (first non-empty cell wins). */
  fields: Partial<Record<Field, number[]>>;
  /** Square "Modifier Set - <name>" Y/N columns. */
  modifierSetColumns: { index: number; name: string }[];
  unknown: string[];
}

export function mapColumns(headers: string[]): ColumnMap {
  const norm = headers.map(normalizeHeader);
  const fields: Partial<Record<Field, number[]>> = {};
  const claimed = new Set<number>();
  for (const field of Object.keys(SYNONYMS) as Field[]) {
    const idxs: number[] = [];
    for (const syn of SYNONYMS[field]) {
      norm.forEach((n, i) => {
        if (n === syn && !claimed.has(i)) idxs.push(i);
      });
    }
    if (idxs.length) {
      fields[field] = idxs;
      for (const i of idxs) claimed.add(i);
    }
  }
  const modifierSetColumns: { index: number; name: string }[] = [];
  headers.forEach((h, i) => {
    const m = /^modifier\s*(?:set|list|group)s?\s*[-:]\s*(.+)$/i.exec(h);
    if (m?.[1]) {
      modifierSetColumns.push({ index: i, name: m[1].trim() });
      claimed.add(i);
    }
  });
  const unknown: string[] = [];
  headers.forEach((h, i) => {
    if (claimed.has(i) || h === "") return;
    const n = norm[i] as string;
    if (IGNORED_EXACT.has(n) || IGNORED_PREFIX.some((p) => n.startsWith(p))) return;
    unknown.push(h);
  });
  return { fields, modifierSetColumns, unknown };
}

/** Best-guess format from the header row (user can override in the UI). */
export function detectFormat(headers: string[]): ImportFormat {
  const n = new Set(headers.map(normalizeHeader));
  if (n.has("cloverid") || (n.has("pricetype") && n.has("modifiergroups"))) {
    return "clover";
  }
  if (
    n.has("token") ||
    (n.has("variationname") && n.has("itemname")) ||
    n.has("reportingcategory")
  ) {
    return "square";
  }
  if (
    n.has("menugroup") ||
    n.has("itemguid") ||
    n.has("masterid") ||
    n.has("menuitem") ||
    n.has("menuitemname")
  ) {
    return "toast";
  }
  return "generic";
}

export const FORMAT_LABELS: Record<ImportFormat, string> = {
  square: "Square item library",
  toast: "Toast menu export",
  clover: "Clover inventory",
  generic: "Generic CSV template",
};
