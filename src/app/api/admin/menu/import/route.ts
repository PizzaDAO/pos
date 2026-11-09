/**
 * Menu import — POST /api/admin/menu/import (multipart/form-data).
 *
 * Query: `tenantId` (authorized BEFORE the body is read). Fields: `file` (CSV or
 * XLSX), `action` = "preview" | "apply", `format` = auto|square|toast|clover|generic, and for apply `mode` = "add" |
 * "replace" (+ `confirmReplace=yes`, the server-side echo of the UI's
 * ConfirmDialog). The file is re-parsed on apply, so the server never trusts a
 * client-built plan.
 *
 * Auth: owner|manager of the tenant (session-derived, like /api/admin/menu).
 * Tenant scoping: rows are built for the AUTHORIZED tenant only and the DB
 * function re-checks it. Limits (file size, rows, items) live in
 * `IMPORT_LIMITS`. Apply is one transaction (driver.applyMenuImport) and writes
 * a `menu_import` audit entry. No env vars.
 */
import { NextResponse } from "next/server";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { getPosDriver } from "@/lib/db";
import {
  FORMAT_LABELS,
  IMPORT_LIMITS,
  MenuImportError,
  buildImportRows,
  parseMenuImport,
  type ImportFormat,
  type ImportMode,
} from "@/lib/menu-import";
import { recordAudit } from "@/lib/security/audit";

export const runtime = "nodejs";

const FORMATS = ["auto", "square", "toast", "clover", "generic"] as const;

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  // Authorize first: the tenant comes from the query string so nothing is
  // buffered or parsed for a caller who may not import.
  const auth = await requireTenantAccess(
    new URL(request.url).searchParams.get("tenantId"),
    "admin",
  );
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;

  // Reject oversized bodies before buffering them (multipart adds a little).
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > IMPORT_LIMITS.maxFileBytes + 64 * 1024) {
    return fail("The file is too large.", 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("Expected a multipart form upload.", 400);
  }

  const action = form.get("action");
  if (action !== "preview" && action !== "apply") {
    return fail('action must be "preview" or "apply".', 422);
  }
  const formatField = form.get("format") ?? "auto";
  if (
    typeof formatField !== "string" ||
    !(FORMATS as readonly string[]).includes(formatField)
  ) {
    return fail("Unknown format.", 422);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail("Choose a file to import.", 400);
  if (file.size > IMPORT_LIMITS.maxFileBytes) {
    return fail("The file is too large.", 413);
  }

  const driver = getPosDriver();
  try {
    const plan = parseMenuImport(
      new Uint8Array(await file.arrayBuffer()),
      formatField as ImportFormat | "auto",
    );

    if (action === "preview") {
      const snapshot = await driver.getMenuSnapshot(tenantId);
      const add = buildImportRows(tenantId, snapshot, plan, "add");
      const replace = buildImportRows(tenantId, snapshot, plan, "replace");
      return NextResponse.json({
        plan: {
          ...plan,
          warnings: [...plan.warnings, ...add.warnings],
          formatLabel: FORMAT_LABELS[plan.format],
        },
        summary: { add: add.summary, replace: replace.summary },
        existing: {
          categories: snapshot.categories.length,
          items: snapshot.items.length,
          modifierGroups: snapshot.modifierGroups.length,
        },
      });
    }

    const mode = form.get("mode");
    if (mode !== "add" && mode !== "replace") {
      return fail('mode must be "add" or "replace".', 422);
    }
    if (mode === "replace" && form.get("confirmReplace") !== "yes") {
      return fail("Replacing the menu needs confirmation.", 422);
    }
    const snapshot = await driver.getMenuSnapshot(tenantId);
    const { changes, summary } = buildImportRows(
      tenantId,
      snapshot,
      plan,
      mode as ImportMode,
    );
    await driver.applyMenuImport(tenantId, changes);
    await recordAudit({
      actor: { id: auth.user.id, label: auth.user.email },
      action: "menu_import",
      tenantId,
      detail:
        `Imported menu (${mode}) from ${FORMAT_LABELS[plan.format]}: ` +
        `${summary.items} items, ${summary.categories} categories, ` +
        `${summary.modifierGroups} modifier groups` +
        (summary.skippedItems ? `, ${summary.skippedItems} existing skipped` : "") +
        (mode === "replace"
          ? `; updated ${summary.updatedItems} in place, removed ${summary.removed.items} items / ${summary.removed.categories} categories.`
          : "."),
    });
    return NextResponse.json({ ok: true, mode, summary });
  } catch (err) {
    if (err instanceof MenuImportError) return fail(err.message, err.status);
    if (err instanceof Error && /menu changed/i.test(err.message)) {
      return fail("Your menu changed while importing. Nothing was changed; preview again.", 409);
    }
    return fail("Menu import failed. Nothing was changed.", 500);
  }
}
