/**
 * Inventory (Phase 5, /admin → Inventory).
 *
 * Per-location stock list with a low-stock banner, the movement ledger, manual
 * count adjustments / restock / waste, and a "new item" form. Sale-driven
 * DEPLETION happens automatically when an order is placed (the driver decrements
 * linked recipe components in createOrder), so placing pepperoni orders in the
 * terminal/shop will lower stock here and can trip the low-stock alert. No env.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Boxes, Plus } from "lucide-react";
import type {
  InventoryItemView,
  InventoryMovement,
  InventoryUnit,
  MovementReason,
} from "@/lib/db";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  tenantId: string;
  locationId: string;
}

const UNITS: InventoryUnit[] = ["each", "g", "kg", "oz", "lb", "ml", "l"];

export function InventoryManager({ tenantId, locationId }: Props) {
  const [items, setItems] = useState<InventoryItemView[]>([]);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/inventory?tenantId=${tenantId}&locationId=${locationId}`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const d = (await res.json()) as {
      items: InventoryItemView[];
      movements: InventoryMovement[];
    };
    setItems(d.items);
    setMovements(d.movements);
  }, [tenantId, locationId]);

  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 5000);
    return () => clearInterval(h);
  }, [load]);

  async function movement(
    inventoryItemId: string,
    reason: MovementReason,
    delta: number,
    note?: string,
  ) {
    setBusy(true);
    try {
      await fetch("/api/admin/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "movement",
          tenantId,
          inventoryItemId,
          reason,
          delta,
          note,
        }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const low = items.filter((i) => i.low);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Boxes className="h-5 w-5" />
        <h2 className="text-base font-semibold">Inventory</h2>
      </div>

      {low.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <strong>Low stock:</strong>{" "}
            {low.map((i) => `${i.name} (${i.on_hand} ${i.unit})`).join(", ")} —
            at or below threshold.
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">On hand</th>
              <th className="px-3 py-2">Threshold</th>
              <th className="px-3 py-2">Adjust</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((item) => (
              <InventoryRow
                key={item.id}
                item={item}
                busy={busy}
                onMovement={movement}
              />
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-muted-foreground">
                  No inventory for this location yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <NewInventoryItem
        tenantId={tenantId}
        locationId={locationId}
        busy={busy}
        onAdded={load}
      />

      <div>
        <h3 className="mb-2 text-sm font-semibold">Movement ledger</h3>
        <div className="max-h-72 overflow-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">Δ</th>
                <th className="px-3 py-2">After</th>
                <th className="px-3 py-2">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {movements.map((m) => {
                const item = items.find((i) => i.id === m.inventory_item_id);
                return (
                  <tr key={m.id}>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {new Date(m.created_at).toLocaleTimeString()}
                    </td>
                    <td className="px-3 py-1.5">{item?.name ?? m.inventory_item_id}</td>
                    <td className="px-3 py-1.5 capitalize">{m.reason}</td>
                    <td
                      className={cn(
                        "px-3 py-1.5 font-medium",
                        m.delta < 0 ? "text-destructive" : "text-emerald-600",
                      )}
                    >
                      {m.delta > 0 ? "+" : ""}
                      {m.delta}
                    </td>
                    <td className="px-3 py-1.5">{m.resulting_on_hand}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{m.note}</td>
                  </tr>
                );
              })}
              {movements.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-muted-foreground">
                    No movements yet. Place a pizza order to see depletion.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function InventoryRow({
  item,
  busy,
  onMovement,
}: {
  item: InventoryItemView;
  busy: boolean;
  onMovement: (
    id: string,
    reason: MovementReason,
    delta: number,
    note?: string,
  ) => void;
}) {
  const [amount, setAmount] = useState("");
  const n = Number.parseInt(amount, 10);
  const valid = !Number.isNaN(n) && n !== 0;

  return (
    <tr className={cn(item.low && "bg-amber-500/5")}>
      <td className="px-3 py-2 font-medium">
        {item.name}
        {item.low && (
          <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700">
            low
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        {item.on_hand} {item.unit}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {item.low_threshold} {item.unit}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            className="w-20 rounded-md border bg-background px-2 py-1 text-sm"
            placeholder="± qty"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !valid}
            onClick={() => {
              onMovement(item.id, "restock", Math.abs(n), "Manual restock");
              setAmount("");
            }}
          >
            Restock
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !valid}
            onClick={() => {
              onMovement(item.id, "adjustment", n, "Count adjustment");
              setAmount("");
            }}
          >
            Adjust
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !valid}
            onClick={() => {
              onMovement(item.id, "waste", -Math.abs(n), "Waste");
              setAmount("");
            }}
          >
            Waste
          </Button>
        </div>
      </td>
    </tr>
  );
}

function NewInventoryItem({
  tenantId,
  locationId,
  busy,
  onAdded,
}: {
  tenantId: string;
  locationId: string;
  busy: boolean;
  onAdded: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<InventoryUnit>("each");
  const [onHand, setOnHand] = useState("");
  const [threshold, setThreshold] = useState("");
  const [saving, setSaving] = useState(false);

  async function add() {
    setSaving(true);
    try {
      await fetch("/api/admin/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsertItem",
          tenantId,
          item: {
            id: "",
            tenant_id: tenantId,
            location_id: locationId,
            name: name.trim(),
            unit,
            on_hand: Number.parseInt(onHand, 10) || 0,
            low_threshold: Number.parseInt(threshold, 10) || 0,
            created_at: "",
            updated_at: "",
          },
        }),
      });
      setName("");
      setOnHand("");
      setThreshold("");
      await onAdded();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border p-3">
      <div className="text-sm font-medium">New inventory item</div>
      <input
        className="w-40 rounded-md border bg-background px-2 py-1.5 text-sm"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        className="rounded-md border bg-background px-2 py-1.5 text-sm"
        value={unit}
        onChange={(e) => setUnit(e.target.value as InventoryUnit)}
      >
        {UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
      <input
        className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
        placeholder="On hand"
        value={onHand}
        onChange={(e) => setOnHand(e.target.value)}
      />
      <input
        className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm"
        placeholder="Low at"
        value={threshold}
        onChange={(e) => setThreshold(e.target.value)}
      />
      <Button size="sm" disabled={busy || saving || !name.trim()} onClick={add}>
        <Plus className="h-4 w-4" /> Add
      </Button>
    </div>
  );
}
