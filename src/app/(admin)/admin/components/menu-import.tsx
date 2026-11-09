/**
 * Menu import dialog (/admin → Menu → "Import menu").
 *
 * upload -> preview (counts, items table, warnings) -> choose "add to existing"
 * or "replace menu" (ConfirmDialog) -> apply. Parsing, validation and the
 * transactional apply all happen server-side in /api/admin/menu/import; this
 * component only uploads the file and renders what the server found.
 */
"use client";

import { useId, useRef, useState } from "react";
import { AlertTriangle, Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { formatMoney } from "@/lib/pricing";
import {
  GENERIC_TEMPLATE_CSV,
  GENERIC_TEMPLATE_NOTES,
  IMPORT_LIMITS,
  type ImportMode,
  type ImportSummary,
  type ImportWarning,
  type MenuImportPlan,
} from "@/lib/menu-import";

type Format = "auto" | "square" | "toast" | "clover" | "generic";

interface PreviewResponse {
  plan: MenuImportPlan & { formatLabel: string };
  summary: { add: ImportSummary; replace: ImportSummary };
  existing: { categories: number; items: number; modifierGroups: number };
}

const FORMAT_OPTIONS: { value: Format; label: string }[] = [
  { value: "auto", label: "Detect automatically" },
  { value: "square", label: "Square item library (CSV / XLSX)" },
  { value: "toast", label: "Toast menu export (CSV)" },
  { value: "clover", label: "Clover inventory (CSV)" },
  { value: "generic", label: "Generic CSV template" },
];

const TABLE_LIMIT = 100;

export function downloadTemplate() {
  const blob = new Blob([GENERIC_TEMPLATE_CSV], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "menu-import-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function MenuImportDialog({
  tenantId,
  onClose,
  onImported,
}: {
  tenantId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const id = useId();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<Format>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mode, setMode] = useState<ImportMode>("add");
  const [confirming, setConfirming] = useState(false);

  const send = async (action: "preview" | "apply") => {
    if (!file) return null;
    const form = new FormData();
    form.set("tenantId", tenantId);
    form.set("action", action);
    form.set("format", format);
    form.set("file", file);
    if (action === "apply") {
      form.set("mode", mode);
      if (mode === "replace") form.set("confirmReplace", "yes");
    }
    const res = await fetch("/api/admin/menu/import", {
      method: "POST",
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
    } & Record<string, unknown>;
    if (!res.ok) throw new Error(data.error ?? "Import failed.");
    return data;
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview((await send("preview")) as unknown as PreviewResponse);
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = (await send("apply")) as unknown as {
        summary: ImportSummary;
      };
      toast({
        title: "Menu imported",
        description: `${data.summary.items} items, ${data.summary.categories} new categories.`,
        variant: "success",
      });
      onImported();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  const chosen = preview?.summary[mode];
  const items = preview?.plan.categories.flatMap((c) =>
    c.items.map((i) => ({ category: c.name, item: i })),
  );

  return (
    <Dialog onClose={onClose} labelledBy={`${id}-title`} placement="center">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border bg-background p-5 shadow-xl">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          Import menu
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Bring in a menu exported from Square, Toast or Clover, or use the
          generic template. You will see a preview before anything changes.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block font-medium">File (.csv or .xlsx)</span>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,text/csv"
              className="block w-full text-sm"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setError(null);
              }}
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Up to {IMPORT_LIMITS.maxFileBytes / 1024 / 1024} MB and{" "}
              {IMPORT_LIMITS.maxRows} rows.
            </span>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Format</span>
            <select
              className="w-full rounded-md border bg-background px-2 py-2 text-sm"
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as Format);
                setPreview(null);
              }}
            >
              {FORMAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <details className="mt-3 rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Generic CSV template and column guide
          </summary>
          <div className="mt-2 space-y-2">
            <Button variant="outline" size="sm" onClick={downloadTemplate}>
              <Download className="h-4 w-4" /> Download template
            </Button>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {GENERIC_TEMPLATE_NOTES.map((n) => (
                <li key={n.column}>
                  <code className="font-mono text-foreground">{n.column}</code>{" "}
                  {n.note}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Square and Clover item exports list modifier-group names but not
              their options, so those groups are not created; add them in the
              menu manager afterwards.
            </p>
          </div>
        </details>

        <div className="mt-4 flex items-center gap-2">
          <Button disabled={!file || busy} onClick={() => void runPreview()}>
            <Upload className="h-4 w-4" /> {busy && !preview ? "Reading..." : "Preview import"}
          </Button>
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {preview && chosen && (
          <div className="mt-5 space-y-4">
            <p className="text-sm">
              Detected <strong>{preview.plan.formatLabel}</strong>:{" "}
              {preview.plan.stats.rows} rows read,{" "}
              {preview.plan.stats.skippedRows} skipped.
            </p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="Categories" value={chosen.categories} />
              <Stat label="Items" value={chosen.items} />
              <Stat label="Sizes" value={chosen.sizes} />
              <Stat label="Modifier groups" value={chosen.modifierGroups} />
              <Stat label="Modifiers" value={chosen.modifiers} />
            </div>
            {mode === "add" && chosen.skippedItems > 0 && (
              <p className="text-sm text-muted-foreground">
                {chosen.skippedItems} item{chosen.skippedItems === 1 ? "" : "s"} already
                on your menu will be left as they are.
              </p>
            )}

            {preview.plan.warnings.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="flex items-center gap-1 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  {preview.plan.warnings.length} warning
                  {preview.plan.warnings.length === 1 ? "" : "s"}
                </p>
                <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                  {preview.plan.warnings.map((w: ImportWarning, i: number) => (
                    <li key={i}>
                      {w.row ? `Row ${w.row}: ` : ""}
                      {w.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="max-h-64 overflow-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="px-2 py-1.5">Category</th>
                    <th className="px-2 py-1.5">Item</th>
                    <th className="px-2 py-1.5">Sizes</th>
                    <th className="px-2 py-1.5">Modifier groups</th>
                  </tr>
                </thead>
                <tbody>
                  {items?.slice(0, TABLE_LIMIT).map(({ category, item }, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1">{category}</td>
                      <td className="px-2 py-1">{item.name}</td>
                      <td className="px-2 py-1">
                        {item.sizes
                          .map((s) => `${s.name} ${formatMoney(s.price_cents)}`)
                          .join(", ")}
                      </td>
                      <td className="px-2 py-1">
                        {item.modifier_groups.join(", ") || "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {items && items.length > TABLE_LIMIT && (
                <p className="p-2 text-xs text-muted-foreground">
                  and {items.length - TABLE_LIMIT} more items
                </p>
              )}
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">How to import</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-mode`}
                  checked={mode === "add"}
                  onChange={() => setMode("add")}
                  className="mt-1"
                />
                <span>
                  <strong>Add to existing menu</strong>
                  <span className="block text-xs text-muted-foreground">
                    Keeps everything you have. Items with the same name in the
                    same category are skipped, so re-importing is safe.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-mode`}
                  checked={mode === "replace"}
                  onChange={() => setMode("replace")}
                  className="mt-1"
                />
                <span>
                  <strong>Replace menu</strong>
                  <span className="block text-xs text-muted-foreground">
                    Removes your current {preview.existing.items} items and{" "}
                    {preview.existing.categories} categories first. Past orders
                    keep their names and prices.
                  </span>
                </span>
              </label>
            </fieldset>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant={mode === "replace" ? "destructive" : "default"}
                disabled={busy}
                onClick={() => (mode === "replace" ? setConfirming(true) : void runApply())}
              >
                {busy ? "Importing..." : mode === "replace" ? "Replace menu" : "Import"}
              </Button>
            </div>
          </div>
        )}

        {confirming && (
          <ConfirmDialog
            title="Replace your whole menu?"
            description={`This removes all ${preview?.existing.items ?? 0} current items, categories, modifier groups and per-location price/availability overrides, then imports ${chosen?.items ?? 0} items. Past orders are not affected. This can't be undone.`}
            confirmLabel="Replace menu"
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              void runApply();
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-2 text-center">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
