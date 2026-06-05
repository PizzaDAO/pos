/**
 * Customer cart drawer (Phase 4). Lists the in-progress online order with
 * half-and-half topping placements rendered, qty steppers, edit/remove, and a
 * running subtotal — then a "Checkout" CTA. Reads the SEPARATE customer cart
 * store (not the terminal's staff cart).
 */
"use client";

import { Minus, Plus, Trash2, X } from "lucide-react";
import type { OrderItem } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import { useCustomerCart } from "@/lib/store/customer-cart";

function placementLabel(placement: string): string {
  if (placement === "left") return "Left ½";
  if (placement === "right") return "Right ½";
  return "";
}

function LineModifiers({ line }: { line: OrderItem }) {
  if (line.modifiers.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {line.modifiers.map((m, idx) => (
        <li key={`${m.modifier_id}-${m.placement}-${idx}`}>
          {m.modifier_name}
          {m.placement !== "whole" && (
            <span className="ml-1 rounded bg-secondary px-1 text-[10px] font-medium text-secondary-foreground">
              {placementLabel(m.placement)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function CustomerCart({
  currency,
  empty,
  onClose,
  onEditLine,
  onCheckout,
}: {
  currency: string;
  empty: boolean;
  onClose: () => void;
  onEditLine: (line: OrderItem) => void;
  onCheckout: () => void;
}) {
  const items = useCustomerCart((s) => s.items);
  const setQuantity = useCustomerCart((s) => s.setQuantity);
  const removeLine = useCustomerCart((s) => s.removeLine);
  const subtotalCents = useCustomerCart((s) => s.subtotalCents());

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40">
      <div className="flex h-full w-full max-w-md flex-col bg-background shadow-xl">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="text-lg font-bold">Your order</h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {empty ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Your cart is empty. Add something tasty!
            </p>
          ) : (
            <ul className="space-y-3">
              {items.map((line) => (
                <li key={line.id} className="rounded-xl border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onEditLine(line)}
                    >
                      <div className="font-medium">
                        {line.item_name}
                        {line.size_name && (
                          <span className="text-muted-foreground">
                            {" "}
                            · {line.size_name}
                          </span>
                        )}
                      </div>
                      <LineModifiers line={line} />
                      {line.notes && (
                        <p className="mt-1 text-xs italic text-muted-foreground">
                          “{line.notes}”
                        </p>
                      )}
                    </button>
                    <div className="text-right text-sm font-semibold">
                      {formatMoney(line.line_total_cents, currency)}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="Decrease quantity"
                        onClick={() =>
                          setQuantity(line.id, line.quantity - 1)
                        }
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <span className="w-6 text-center text-sm font-semibold">
                        {line.quantity}
                      </span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="Increase quantity"
                        onClick={() =>
                          setQuantity(line.id, line.quantity + 1)
                        }
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => removeLine(line.id)}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t p-4">
          <div className="mb-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="font-bold">
              {formatMoney(subtotalCents, currency)}
            </span>
          </div>
          <Button
            className="h-12 w-full text-base"
            disabled={empty}
            onClick={onCheckout}
          >
            Checkout
          </Button>
        </div>
      </div>
    </div>
  );
}
