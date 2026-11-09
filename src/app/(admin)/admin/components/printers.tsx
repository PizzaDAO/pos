/**
 * Kitchen printers panel (Admin > Printers).
 *
 * Registers network receipt printers for ONE location. Printers pull tickets over
 * HTTPS (Star CloudPRNT or Epson Server Direct Print), so the shop needs no port
 * forwarding: paste the setup URL into the printer's web page. The token inside
 * the URL is shown once, right after adding. Also: per-location auto-print on
 * order fire (off by default), last-seen time and a "Print test ticket" button.
 * Owner/manager only (the API enforces it).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Printer as PrinterIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

interface PrinterRow {
  id: string;
  label: string;
  protocol: "star_cloudprnt" | "epson_sdp";
  format: "markup" | "text";
  columns: 42 | 48;
  lastSeenAt: string | null;
  online: boolean;
}

interface JobRow {
  id: string;
  printerId: string;
  kind: "ticket" | "test";
  status: string;
  createdAt: string;
}

interface Setup {
  printers: PrinterRow[];
  autoPrint: boolean;
  jobs: JobRow[];
}

const PROTOCOL_LABELS = {
  star_cloudprnt: "Star CloudPRNT",
  epson_sdp: "Epson Server Direct Print",
} as const;

async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  return (await res.json().catch(() => ({}))) as T & { error?: string };
}

function seen(iso: string | null): string {
  if (!iso) return "Never connected";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `Seen ${s}s ago`;
  if (s < 3600) return `Seen ${Math.round(s / 60)} min ago`;
  return `Seen ${new Date(iso).toLocaleString()}`;
}

export function Printers({
  tenantId,
  locationId,
}: {
  tenantId: string;
  locationId: string;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [label, setLabel] = useState("");
  const [protocol, setProtocol] = useState<PrinterRow["protocol"]>("star_cloudprnt");
  const [columns, setColumns] = useState<42 | 48>(42);
  const [format, setFormat] = useState<PrinterRow["format"]>("markup");
  const [created, setCreated] = useState<{ label: string; setupUrl: string } | null>(null);
  const [removing, setRemoving] = useState<PrinterRow | null>(null);

  const query = `tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/printers?${query}`);
      const data = await readJson<Setup>(res);
      if (!res.ok) {
        setError(data.error ?? `Failed to load printers (HTTP ${res.status}).`);
        return;
      }
      setError(null);
      setSetup(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load printers.");
    }
  }, [query]);

  useEffect(() => {
    setSetup(null);
    void load();
    // Refresh "last seen" while the panel is open.
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  async function run(fn: () => Promise<Response>, onOk?: (data: Record<string, unknown>) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      const data = await readJson<Record<string, unknown>>(res);
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onOk?.(data);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const post = (url: string, method: string, payload: Record<string, unknown>) =>
    fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, locationId, ...payload }),
    });

  const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";

  return (
    <div className="mx-auto max-w-xl space-y-4 px-6 pb-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <PrinterIcon className="h-5 w-5" aria-hidden="true" /> Kitchen printers
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Print kitchen tickets on a receipt printer. Supports Star CloudPRNT and
          Epson Server Direct Print: the printer fetches tickets over the internet,
          so no router setup is needed. Without a printer, tickets print through
          the browser.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {notice && <div className="rounded-md border p-3 text-sm">{notice}</div>}
      {!setup && !error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {setup && (
        <div className="space-y-3 rounded-lg border p-4">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={setup.autoPrint}
              disabled={busy || setup.printers.length === 0}
              onChange={(e) =>
                void run(() => post("/api/admin/printers", "PATCH", { autoPrint: e.target.checked }))
              }
            />
            <span>
              <span className="font-medium">Auto-print when an order fires</span>
              <span className="block text-xs text-muted-foreground">
                Off by default. Prints each new order on every printer here the
                moment it reaches the kitchen.
              </span>
            </span>
          </label>
        </div>
      )}

      {setup && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Printers</div>
            <Button size="sm" disabled={busy} onClick={() => setShowAdd(true)}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Add printer
            </Button>
          </div>
          {setup.printers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No printers yet.</p>
          ) : (
            <ul className="divide-y">
              {setup.printers.map((p) => (
                <li
                  key={p.id}
                  data-testid="printer-row"
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium">{p.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {PROTOCOL_LABELS[p.protocol]} · {p.columns} columns · {seen(p.lastSeenAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-semibold uppercase",
                        p.online ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {p.online ? "online" : "offline"}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => post("/api/admin/printers/test", "POST", { printerId: p.id }),
                          () => setNotice(`Test ticket queued for ${p.label}. It prints on the printer's next check-in.`),
                        )
                      }
                    >
                      Print test ticket
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${p.label}`}
                      disabled={busy}
                      onClick={() => setRemoving(p)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {setup.jobs.length > 0 && (
            <div className="border-t pt-2 text-xs text-muted-foreground">
              Recent jobs:{" "}
              {setup.jobs
                .slice(0, 5)
                .map((j) => `${j.kind} ${j.status}`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <Dialog onClose={() => setShowAdd(false)} labelledBy="add-printer-title">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-background p-5 shadow-xl">
            <h3 id="add-printer-title" className="text-base font-bold">
              Add a kitchen printer
            </h3>
            <input
              aria-label="Printer name"
              placeholder="Name (e.g. Kitchen)"
              autoFocus
              className={field}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">Printer type</span>
              <select
                aria-label="Printer type"
                className={field}
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as PrinterRow["protocol"])}
              >
                {(Object.keys(PROTOCOL_LABELS) as PrinterRow["protocol"][]).map((k) => (
                  <option key={k} value={k}>
                    {PROTOCOL_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">Paper width</span>
              <select
                aria-label="Paper width"
                className={field}
                value={columns}
                onChange={(e) => setColumns(Number(e.target.value) as 42 | 48)}
              >
                <option value={42}>80 mm, 42 columns</option>
                <option value={48}>80 mm, 48 columns</option>
              </select>
            </label>
            {protocol === "star_cloudprnt" && (
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">Star format</span>
                <select
                  aria-label="Star format"
                  className={field}
                  value={format}
                  onChange={(e) => setFormat(e.target.value as PrinterRow["format"])}
                >
                  <option value="markup">Star markup (big order number)</option>
                  <option value="text">Plain text (older firmware)</option>
                </select>
              </label>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy || !label.trim()}
                onClick={() =>
                  void run(
                    () =>
                      post("/api/admin/printers", "POST", {
                        label: label.trim(),
                        protocol,
                        columns,
                        ...(protocol === "star_cloudprnt" ? { format } : {}),
                      }),
                    (data) => {
                      setShowAdd(false);
                      setCreated({ label: label.trim(), setupUrl: String(data.setupUrl) });
                      setLabel("");
                    },
                  )
                }
              >
                {busy ? "Adding…" : "Add printer"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {created && (
        <Dialog onClose={() => setCreated(null)} labelledBy="printer-url-title">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-background p-5 shadow-xl">
            <h3 id="printer-url-title" className="text-base font-bold">
              Set up {created.label}
            </h3>
            <p className="text-sm text-muted-foreground">
              Paste this URL into the printer&apos;s web settings (Star: CloudPRNT →
              Server URL, enabled; Epson: Server Direct Print → URL 1). It contains
              the printer&apos;s secret token and is shown <strong>only once</strong>.
              To rotate it, remove the printer and add it again.
            </p>
            <input
              readOnly
              aria-label="Setup URL"
              className={cn(field, "font-mono text-xs")}
              value={created.setupUrl}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => void navigator.clipboard?.writeText(created.setupUrl)}
              >
                Copy
              </Button>
              <Button onClick={() => setCreated(null)}>Done</Button>
            </div>
          </div>
        </Dialog>
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.label}?`}
          description="Its setup URL stops working and queued tickets are dropped."
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const p = removing;
            setRemoving(null);
            void run(() =>
              fetch(`/api/admin/printers?${query}&printerId=${encodeURIComponent(p.id)}`, {
                method: "DELETE",
              }),
            );
          }}
        />
      )}
    </div>
  );
}
