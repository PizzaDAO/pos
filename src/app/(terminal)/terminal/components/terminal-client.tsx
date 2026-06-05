/**
 * Terminal client — orchestrates the whole Phase 1 order-taking experience:
 * menu browse → pizza builder → cart/totals → place order, plus the offline
 * queue/online status.
 *
 * Place-order flow (offline-first):
 *  1. Generate a client-side UUID (the idempotency key + order id).
 *  2. Assign a client-side order number so the cashier always sees a number.
 *  3. Enqueue the order durably in IndexedDB and attempt an immediate flush.
 *     The /api/orders endpoint upserts by UUID, so retries never duplicate.
 *  4. Clear the cart and show the confirmation.
 */
"use client";

import { useState } from "react";
import type {
  CreateOrderInput,
  MenuItemDetail,
  OrderItem,
} from "@/lib/db";
import { computeOrderTotals } from "@/lib/pricing";
import { useCartStore } from "@/lib/store/cart";
import { useMenu } from "@/lib/store/use-menu";
import { useOfflineSync } from "@/lib/offline/use-offline-sync";
import { MenuBrowse } from "./menu-browse";
import { CartPanel } from "./cart-panel";
import { PizzaBuilder } from "./pizza-builder";
import { StatusBar } from "./status-bar";
import {
  OrderConfirmation,
  type PlacedOrderSummary,
} from "./order-confirmation";

function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ord-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Short, human-friendly client order number (no server round-trip needed). */
function clientOrderNumber(): string {
  const t = new Date();
  const hhmm = `${String(t.getHours()).padStart(2, "0")}${String(
    t.getMinutes(),
  ).padStart(2, "0")}`;
  const rand = Math.floor(Math.random() * 900 + 100);
  return `${hhmm}-${rand}`;
}

export function TerminalClient() {
  const { data, isLoading, isError, refetch } = useMenu();
  const sync = useOfflineSync();

  const items = useCartStore((s) => s.items);
  const discountCents = useCartStore((s) => s.discountCents);
  const notes = useCartStore((s) => s.notes);
  const addLine = useCartStore((s) => s.addLine);
  const updateLine = useCartStore((s) => s.updateLine);
  const clear = useCartStore((s) => s.clear);

  const [builderItem, setBuilderItem] = useState<MenuItemDetail | null>(null);
  const [editingLine, setEditingLine] = useState<OrderItem | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<PlacedOrderSummary | null>(null);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading menu…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <p className="text-muted-foreground">Could not load the menu.</p>
        <button
          className="rounded-md border px-4 py-2 text-sm"
          onClick={() => refetch()}
        >
          Retry
        </button>
      </div>
    );
  }

  const { menu, settings } = data;
  const location = menu.locationId;

  function openBuilderForItem(item: MenuItemDetail) {
    setEditingLine(null);
    setBuilderItem(item);
  }

  function openBuilderForLine(line: OrderItem) {
    const item = menu.categories
      .flatMap((c) => c.items)
      .find((i) => i.id === line.item_id);
    if (!item) return;
    setEditingLine(line);
    setBuilderItem(item);
  }

  function handleBuilderConfirm(line: OrderItem) {
    if (editingLine) updateLine(editingLine.id, line);
    else addLine(line);
    setBuilderItem(null);
    setEditingLine(null);
  }

  async function handlePlaceOrder() {
    const active = items.filter((i) => !i.voided);
    if (active.length === 0) return;

    setPlacing(true);
    try {
      const totals = computeOrderTotals({
        items,
        discountCents,
        taxRateBps: settings.tax_rate_bps,
        tipCents: 0,
      });

      const orderNumber = clientOrderNumber();
      const payload: CreateOrderInput = {
        id: newUuid(),
        tenant_id: menu.tenantId,
        location_id: location,
        channel: "in_store",
        currency: settings.currency,
        items, // includes voided lines for audit; totals exclude them
        discount_cents: totals.discount_cents,
        totals,
        notes: notes.trim() ? notes.trim() : null,
        order_number: orderNumber,
        status: "placed",
      };

      // Snapshot online state before the async enqueue/flush.
      const wasOnline = sync.online;
      await sync.placeOrderOffline(payload);

      clear();
      setPlaced({
        orderNumber,
        totalCents: totals.total_cents,
        currency: settings.currency,
        synced: wasOnline,
      });
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <StatusBar
        locationName={"Tony's Downtown"}
        online={sync.online}
        pendingCount={sync.pendingCount}
        driverName={data.driver}
        onFlush={() => void sync.flushNow()}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_400px]">
        {/* Menu */}
        <div className="min-h-0 border-r">
          <MenuBrowse
            menu={menu}
            currency={settings.currency}
            onSelectItem={openBuilderForItem}
          />
        </div>

        {/* Cart */}
        <div className="min-h-0">
          <CartPanel
            settings={settings}
            onEditLine={openBuilderForLine}
            onPlaceOrder={handlePlaceOrder}
            placing={placing}
          />
        </div>
      </div>

      {builderItem && (
        <PizzaBuilder
          item={builderItem}
          currency={settings.currency}
          editing={editingLine ?? undefined}
          onCancel={() => {
            setBuilderItem(null);
            setEditingLine(null);
          }}
          onConfirm={handleBuilderConfirm}
        />
      )}

      {placed && (
        <OrderConfirmation
          order={placed}
          onNewOrder={() => setPlaced(null)}
        />
      )}
    </div>
  );
}
