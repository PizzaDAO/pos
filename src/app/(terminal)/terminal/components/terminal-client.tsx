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
import { AlertTriangle } from "lucide-react";
import type { CreateOrderInput, MenuItemDetail, OrderItem } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { computeOrderTotals } from "@/lib/pricing";
import { useCartStore } from "@/lib/store/cart";
import { useMenu } from "@/lib/store/use-menu";
import { useActiveStaff } from "@/lib/store/use-active-staff";
import { useOfflineSync } from "@/lib/offline/use-offline-sync";
import { MenuBrowse } from "./menu-browse";
import { StaffSwitch } from "./staff-switch";
import { CartPanel } from "./cart-panel";
import { PizzaBuilder } from "./pizza-builder";
import { StatusBar } from "./status-bar";
import {
  OrderConfirmation,
  type PlacedOrderSummary,
} from "./order-confirmation";
import { PaymentScreen } from "./payment-screen";

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

/**
 * `initialTenantId`/`initialLocationId` are resolved + authorized by the server
 * guard (src/lib/auth/guard.ts#requireLocationSurface) from the device user's
 * session, replacing the old hardcoded demo context. They default to the demo
 * context for the simulated/zero-env path.
 */
export function TerminalClient({
  initialTenantId,
  initialLocationId,
}: {
  initialTenantId?: string;
  initialLocationId?: string;
} = {}) {
  const { data, isLoading, isError, refetch } = useMenu(
    initialTenantId,
    initialLocationId,
  );
  const sync = useOfflineSync();
  const { activeStaff, signOut: signOutStaff, verifyPin } = useActiveStaff();
  const [showStaffSwitch, setShowStaffSwitch] = useState(false);
  const toast = useToast();

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
  /** Order awaiting payment (opens the checkout screen). */
  const [payOrderId, setPayOrderId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div
        className="grid h-screen grid-cols-1 lg:grid-cols-[1fr_400px]"
        aria-busy="true"
        aria-label="Loading terminal"
      >
        <div className="space-y-3 border-r p-4">
          <div className="flex gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-24 rounded-full" />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        </div>
        <div className="hidden p-4 lg:block">
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center">
        <EmptyState
          icon={AlertTriangle}
          title="Could not load the menu"
          description="Check your connection and try again."
          action={
            <Button variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const { menu, settings, paymentSettings } = data;
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
      const orderId = newUuid();
      const payload: CreateOrderInput = {
        id: orderId,
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
        // Attribute to the PIN-switched active staff (if any) so orders/shifts
        // tie to the person at the till.
        staff_id: activeStaff?.id ?? null,
      };

      // Snapshot online state before the async enqueue/flush.
      const wasOnline = sync.online;
      await sync.placeOrderOffline(payload);

      clear();
      if (wasOnline) {
        // Order reached the server → go straight to taking payment.
        toast({ title: `Order ${orderNumber} placed`, variant: "success" });
        setPayOrderId(orderId);
      } else {
        // Offline: payment needs connectivity (beyond reader store-and-forward),
        // so confirm the queued order; the cashier pays once back online.
        toast({
          title: `Order ${orderNumber} saved offline`,
          description: "It will sync automatically when back online.",
          variant: "info",
        });
        setPlaced({
          orderNumber,
          totalCents: totals.total_cents,
          currency: settings.currency,
          synced: false,
        });
      }
    } catch {
      toast({
        title: "Couldn't place the order",
        description: "Please try again.",
        variant: "error",
      });
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div id="main-content" className="flex h-screen flex-col">
      <StatusBar
        locationName={"Tony's Downtown"}
        online={sync.online}
        pendingCount={sync.pendingCount}
        driverName={data.driver}
        onFlush={() => void sync.flushNow()}
        activeStaffName={activeStaff?.name ?? null}
        onSwitchStaff={() => setShowStaffSwitch(true)}
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
        <OrderConfirmation order={placed} onNewOrder={() => setPlaced(null)} />
      )}

      {payOrderId && (
        <PaymentScreen
          orderId={payOrderId}
          tenantId={menu.tenantId}
          locationId={location}
          paymentSettings={paymentSettings}
          onClose={() => setPayOrderId(null)}
          onPaid={() => setPayOrderId(null)}
        />
      )}

      {showStaffSwitch && (
        <StaffSwitch
          current={activeStaff}
          onVerify={verifyPin}
          onSignOut={signOutStaff}
          onClose={() => setShowStaffSwitch(false)}
        />
      )}
    </div>
  );
}
