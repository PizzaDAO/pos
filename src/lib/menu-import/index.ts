/** Menu import entry point: bytes -> {@link MenuImportPlan}. Pure; no I/O. */
import { buildPlan } from "./plan";
import { readTable } from "./table";
import type { ImportFormat, MenuImportPlan } from "./types";

export * from "./types";
export * from "./apply";
export { FORMAT_LABELS, detectFormat } from "./formats";
export { GENERIC_TEMPLATE_CSV, GENERIC_TEMPLATE_NOTES } from "./template";

export function parseMenuImport(
  bytes: Uint8Array,
  format: ImportFormat | "auto" = "auto",
): MenuImportPlan {
  return buildPlan(readTable(bytes), format);
}
