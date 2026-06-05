/**
 * Cart panel — order lines (with modifier/half-and-half summary), per-line edit/
 * void/remove/qty, order-level discount, the totals breakdown, and Place Order.
 */
"use client";

import { Pencil, Trash2, Ban } from "lucide-react";
import type { OrderItem, OrderItemModifier, StoreSettings } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { computeOrderTotals, formatMoney } from "@/lib/pricing";
import { useCartStore } from "@/lib/store/cart";

function placementLabel(placement: OrderItemModifier["placement"]): string {
  if (placement === "left") return " (L)";
  if (placement === "right") return " (R)";
  return "";
}

function summarizeModifiers(item: OrderItem): string {
  if (item.modifiers.length === 0) return "";
  return item.modifiers
    .map((m) => `${m.modifier_name}${placementLabel(m.placement)}`)
    .join(", ");
}

export interface CartPanelProps {
  settings: StoreSettings;
  onEditLine: (line: OrderItem) => void;
  onPlaceOrder: () => void;
  placing: boolean;
}

export function CartPanel({
  settings,
  onEditLine,
  onPlaceOrder,
  placing,
}: CartPanelProps) {
  const items = useCartStore((s) => s.items);
  const discountCents = useCartStore((s) => s.discountCents);
  const setDiscount = useCartStore((s) => s.setDiscount);
  const setQuantity = useCartStore((s) => s.setQuantity);
  const voidLine = useCartStore((s) => s.voidLine);
  const removeLine = useCartStore((s) => s.removeLine);

  const currency = settings.currency;
  const activeItems = items.filter((i) => !i.voided);

  const totals = computeOrderTotals({
    items,
    discountCents,
    taxRateBps: settings.tax_rate_bps,
    tipCents: 0, // Phase 2 wires real tipping.
  });

  const hasOrder = activeItems.length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-4">
        <h2 className="text-lg font-bold">Current order</h2>
        <p className="text-sm text-muted-foreground">
          {activeItems.reduce((n, i) => n + i.quantity, 0)} item(s)
        </p>
      </div>

      {/* Lines */}
      <div className="flex-1 overflow-y-auto p-3">
        {items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No items yet. Tap a menu item to start.
          </p>
        )}
        <ul className="space-y-2">
          {items.map((item) => {
            const mods = summarizeModifiers(item);
            return (
              <li
                key={item.id}
                className={cn(
                  "rounded-lg border p-3",
                  item.voided && "opacity-50",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {item.item_name}
                      {item.size_name ? ` · ${item.size_name}` : ""}
                      {item.voided && (
                        <span className="ml-2 text-xs font-semibold uppercase text-destructive">
                          voided
                        </span>
                      )}
                    </div>
                    {mods && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {mods}
                      </div>
                    )}
                    {item.notes && (
                      <div className="mt-0.5 text-xs italic text-muted-foreground">
                        “{item.notes}”
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-right font-semibold">
                    {formatMoney(item.line_total_cents, currency)}
                  </div>
                </div>

                {!item.voided && (
                  <div className="mt-2 flex items-center gap-1">
                    <div className="flex items-center overflow-hidden rounded-md border">
                      <button
                        type="button"
                        className="px-3 py-1 text-sm hover:bg-accent"
                        aria-label="Decrease quantity"
                        onClick={() =>
                          setQuantity(item.id, item.quantity - 1)
                        }
                      >
                        −
                      </button>
                      <span className="min-w-[2ch] px-2 text-center text-sm">
                        {item.quantity}
                      </span>
                      <button
                        type="button"
                        className="px-3 py-1 text-sm hover:bg-accent"
                        aria-label="Increase quantity"
                        onClick={() =>
                          setQuantity(item.id, item.quantity + 1)
                        }
                      >
                        +
                      </button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEditLine(item)}
                    >
                      <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => voidLine(item.id)}
                    >
                      <Ban className="mr-1 h-3.5 w-3.5" /> Void
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove line"
                      onClick={() => removeLine(item.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Discount + totals */}
      <div className="space-y-3 border-t p-4">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="discount" className="text-sm text-muted-foreground">
            Order discount
          </label>
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground">$</span>
            <input
              id="discount"
              type="number"
              min={0}
              step="0.01"
              value={discountCents ? (discountCents / 100).toString() : ""}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setDiscount(Number.isFinite(v) ? Math.round(v * 100) : 0);
              }}
              placeholder="0.00"
              className="w-24 rounded-md border bg-background px-2 py-1 text-right text-sm"
            />
          </div>
        </div>

        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd>{formatMoney(totals.subtotal_cents, currency)}</dd>
          </div>
          {totals.discount_cents > 0 && (
            <div className="flex justify-between text-primary">
              <dt>Discount</dt>
              <dd>−{formatMoney(totals.discount_cents, currency)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-muted-foreground">
              Tax ({(settings.tax_rate_bps / 100).toFixed(2)}%)
            </dt>
            <dd>{formatMoney(totals.tax_cents, currency)}</dd>
          </div>
          <div className="flex justify-between border-t pt-1 text-base font-bold">
            <dt>Total</dt>
            <dd>{formatMoney(totals.total_cents, currency)}</dd>
          </div>
        </dl>

        <Button
          className="h-14 w-full text-base"
          disabled={!hasOrder || placing}
          onClick={onPlaceOrder}
        >
          {placing ? "Placing…" : "Place order"}
        </Button>
      </div>
    </div>
  );
}
