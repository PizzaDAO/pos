/**
 * Menu import (Square / Toast / Clover / generic CSV) shared types + limits.
 *
 * The pipeline is: bytes -> table (csv.ts / xlsx.ts) -> format mapping
 * (formats.ts) -> a normalized {@link MenuImportPlan} (plan.ts) -> DB rows
 * (apply.ts). Everything here is pure; only the driver touches storage.
 */
import type { Station } from "@/lib/db/menu-types";

export type ImportFormat = "square" | "toast" | "clover" | "generic";

/** Server-side bounds, enforced before any parsing work scales with input. */
export const IMPORT_LIMITS = {
  /** Uploaded file size. */
  maxFileBytes: 2 * 1024 * 1024,
  /** Data rows (excluding the header). */
  maxRows: 5000,
  /** Distinct items after grouping variations. */
  maxItems: 2000,
  maxNameLength: 120,
  maxDescriptionLength: 500,
  /** Largest price accepted, in cents ($100,000.00). */
  maxPriceCents: 10_000_000,
  /** Total uncompressed XLSX payload we are willing to inflate. */
  maxXlsxUncompressedBytes: 8 * 1024 * 1024,
  /** Widest sheet we read (a real menu export has ~40 columns). */
  maxColumns: 200,
  /** Non-empty cells + shared strings we will materialise from one workbook. */
  maxXlsxCells: 600_000,
  maxXlsxSharedStrings: 300_000,
} as const;

export interface PlanSize {
  name: string;
  price_cents: number;
}

export interface PlanItem {
  name: string;
  description: string | null;
  station: Station;
  half_and_half: boolean;
  sizes: PlanSize[];
  /** Names of modifier groups to attach; resolved against the file + existing menu on apply. */
  modifier_groups: string[];
}

export interface PlanCategory {
  name: string;
  items: PlanItem[];
}

export interface PlanModifier {
  name: string;
  price_cents: number;
}

export interface PlanModifierGroup {
  name: string;
  min_select: number;
  max_select: number;
  supports_half: boolean;
  modifiers: PlanModifier[];
}

export interface ImportWarning {
  code:
    | "missing_price"
    | "invalid_price"
    | "duplicate_size"
    | "unknown_columns"
    | "modifiers_without_options"
    | "skipped_archived"
    | "missing_name"
    | "truncated"
    | "duplicate_modifier"
    | "name_in_multiple_categories"
    | "uncategorized"
    | "ambiguous_price";
  message: string;
  /** 1-based spreadsheet row (header = row 1), when tied to one row. */
  row?: number;
}

export interface MenuImportStats {
  format: ImportFormat;
  rows: number;
  skippedRows: number;
  categories: number;
  items: number;
  sizes: number;
  modifierGroups: number;
  modifiers: number;
}

export interface MenuImportPlan {
  format: ImportFormat;
  categories: PlanCategory[];
  modifierGroups: PlanModifierGroup[];
  warnings: ImportWarning[];
  /** Header names that matched no known column (ignored). */
  unknownColumns: string[];
  stats: MenuImportStats;
}

/** A user-facing failure (bad file, over a limit). `status` maps to HTTP. */
export class MenuImportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 422 = 422,
  ) {
    super(message);
    this.name = "MenuImportError";
  }
}

/** The raw rows of a menu already in the database (matching + impact preview). */
export interface MenuSnapshot {
  categories: { id: string; name: string; sort_order: number }[];
  items: {
    id: string;
    category_id: string;
    name: string;
    description: string | null;
    is_half_and_half_capable: boolean;
    station: Station;
  }[];
  sizes: {
    id: string;
    item_id: string;
    name: string;
    price_cents: number;
    sort_order: number;
  }[];
  modifierGroups: {
    id: string;
    name: string;
    min_select: number;
    max_select: number;
    supports_half: boolean;
  }[];
  modifiers: {
    id: string;
    group_id: string;
    name: string;
    price_cents: number;
    sort_order: number;
  }[];
  links: { item_id: string; group_id: string; sort_order: number }[];
  /** source_id of every inventory recipe link (items + modifiers). */
  inventoryLinkSourceIds: string[];
  /** target_id of every row in the latest allergen matrix. */
  allergenTargetIds: string[];
}
