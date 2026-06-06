/**
 * Pizza builder — size, crust, sauce, toppings (with half-and-half), quantity,
 * and special instructions, with a live line-price preview. Used both for adding
 * a new line and editing an existing one.
 */
"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { HalfPlacement, MenuItemDetail, OrderItem } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatMoney, withLinePricing } from "@/lib/pricing";
import {
  buildLine,
  placementPriceCents,
  type BuilderModifierSelection,
} from "@/lib/build-line";

type SingleSel = Record<string, string | undefined>; // groupId -> modifierId
type ToppingSel = Record<string, HalfPlacement | undefined>; // modifierId -> placement

export interface PizzaBuilderProps {
  item: MenuItemDetail;
  currency: string;
  /** When provided, the builder opens pre-filled to edit this existing line. */
  editing?: OrderItem;
  onCancel: () => void;
  onConfirm: (line: OrderItem) => void;
}

const PLACEMENTS: { value: HalfPlacement; label: string }[] = [
  { value: "left", label: "L" },
  { value: "whole", label: "Whole" },
  { value: "right", label: "R" },
];

export function PizzaBuilder({
  item,
  currency,
  editing,
  onCancel,
  onConfirm,
}: PizzaBuilderProps) {
  const singleGroups = item.modifierGroups.filter((g) => !g.supports_half);
  const halfGroups = item.modifierGroups.filter((g) => g.supports_half);

  // ---- Initial state (from `editing` line or sensible defaults) -------------
  const initial = useMemo(() => {
    const single: SingleSel = {};
    const toppings: ToppingSel = {};

    if (editing) {
      for (const m of editing.modifiers) {
        const group = item.modifierGroups.find((g) => g.id === m.group_id);
        if (!group) continue;
        if (group.supports_half) toppings[m.modifier_id] = m.placement;
        else single[m.group_id] = m.modifier_id;
      }
    } else {
      // Default required single-select groups to their first option.
      for (const g of singleGroups) {
        if (g.min_select >= 1 && g.modifiers[0]) {
          single[g.id] = g.modifiers[0].id;
        }
      }
    }

    const sizeId = editing?.size_id ?? item.sizes[0]?.id ?? null;
    return {
      single,
      toppings,
      sizeId,
      qty: editing?.quantity ?? 1,
      notes: editing?.notes ?? "",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [sizeId, setSizeId] = useState<string | null>(initial.sizeId);
  const [single, setSingle] = useState<SingleSel>(initial.single);
  const [toppings, setToppings] = useState<ToppingSel>(initial.toppings);
  const [qty, setQty] = useState<number>(initial.qty);
  const [notes, setNotes] = useState<string>(initial.notes);

  const size = item.sizes.find((s) => s.id === sizeId) ?? null;

  // ---- Assemble selections -> a priced preview line -------------------------
  const selections: BuilderModifierSelection[] = useMemo(() => {
    const out: BuilderModifierSelection[] = [];
    for (const g of singleGroups) {
      const modId = single[g.id];
      const mod = g.modifiers.find((m) => m.id === modId);
      if (mod) out.push({ group: g, modifier: mod, placement: "whole" });
    }
    for (const g of halfGroups) {
      for (const mod of g.modifiers) {
        const placement = toppings[mod.id];
        if (placement) out.push({ group: g, modifier: mod, placement });
      }
    }
    return out;
  }, [single, toppings, singleGroups, halfGroups]);

  const previewLine = useMemo(
    () =>
      buildLine({
        item,
        size,
        selections,
        quantity: qty,
        notes,
        lineId: editing?.id,
      }),
    [item, size, selections, qty, notes, editing?.id],
  );

  const preview = withLinePricing(previewLine);

  // ---- Validation: required single-select groups must be chosen -------------
  const missingRequired = singleGroups
    .filter((g) => g.min_select >= 1 && !single[g.id])
    .map((g) => g.name);
  const needsSize = item.sizes.length > 0 && !sizeId;
  const valid = missingRequired.length === 0 && !needsSize;

  function setToppingPlacement(modId: string, placement: HalfPlacement) {
    setToppings((prev) => {
      const next = { ...prev };
      if (next[modId] === placement) delete next[modId];
      else next[modId] = placement;
      return next;
    });
  }

  return (
    <Dialog
      onClose={onCancel}
      ariaLabel={`Build ${item.name}`}
      placement="center"
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-background shadow-xl sm:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <h2 className="text-lg font-bold">{item.name}</h2>
            {item.description && (
              <p className="text-sm text-muted-foreground">
                {item.description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onCancel}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          {/* Sizes */}
          {item.sizes.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Size
              </h3>
              <div className="grid grid-cols-3 gap-2">
                {item.sizes.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSizeId(s.id)}
                    className={cn(
                      "flex flex-col items-center rounded-lg border p-3 text-sm transition-colors",
                      sizeId === s.id
                        ? "border-primary bg-primary/10 font-semibold"
                        : "hover:bg-accent",
                    )}
                  >
                    <span>{s.name}</span>
                    <span className="text-muted-foreground">
                      {formatMoney(s.price_cents, currency)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Single-select groups (crust, sauce) */}
          {singleGroups.map((g) => (
            <section key={g.id}>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {g.name}
                {g.min_select >= 1 && (
                  <span className="ml-1 text-destructive">*</span>
                )}
              </h3>
              <div className="grid grid-cols-3 gap-2">
                {g.modifiers.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() =>
                      setSingle((prev) => ({ ...prev, [g.id]: m.id }))
                    }
                    className={cn(
                      "flex flex-col items-center rounded-lg border p-3 text-sm transition-colors",
                      single[g.id] === m.id
                        ? "border-primary bg-primary/10 font-semibold"
                        : "hover:bg-accent",
                    )}
                  >
                    <span>{m.name}</span>
                    {m.price_cents > 0 && (
                      <span className="text-muted-foreground">
                        +{formatMoney(m.price_cents, currency)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}

          {/* Half-and-half topping groups */}
          {halfGroups.map((g) => (
            <section key={g.id}>
              <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {g.name}
              </h3>
              <p className="mb-2 text-xs text-muted-foreground">
                Place each topping on the Left half, Right half, or the Whole
                pizza. Half placements are charged at half price.
              </p>
              <div className="space-y-2">
                {g.modifiers.map((m) => {
                  const placement = toppings[m.id];
                  return (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded-lg border p-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {m.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          whole +{formatMoney(m.price_cents, currency)} · half +
                          {formatMoney(
                            placementPriceCents(m.price_cents, "left"),
                            currency,
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 overflow-hidden rounded-md border">
                        {PLACEMENTS.map((p) => (
                          <button
                            key={p.value}
                            type="button"
                            aria-pressed={placement === p.value}
                            onClick={() => setToppingPlacement(m.id, p.value)}
                            className={cn(
                              "min-w-[44px] px-2 py-2 text-xs font-medium transition-colors",
                              placement === p.value
                                ? "bg-primary text-primary-foreground"
                                : "bg-background hover:bg-accent",
                            )}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {/* Quantity */}
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Quantity
            </h3>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                aria-label="Decrease quantity"
              >
                −
              </Button>
              <span className="w-10 text-center text-lg font-semibold">
                {qty}
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setQty((q) => q + 1)}
                aria-label="Increase quantity"
              >
                +
              </Button>
            </div>
          </section>

          {/* Special instructions */}
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Special instructions
            </h3>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. well done, cut in squares"
              className="min-h-[60px] w-full rounded-lg border bg-background p-2 text-sm"
            />
          </section>
        </div>

        {/* Footer / live price + confirm */}
        <div className="border-t p-4">
          {missingRequired.length > 0 && (
            <p className="mb-2 text-xs text-destructive">
              Select: {missingRequired.join(", ")}
            </p>
          )}
          <Button
            className="h-12 w-full text-base"
            disabled={!valid}
            onClick={() => onConfirm(preview)}
          >
            <span>{editing ? "Update item" : "Add to order"}</span>
            <span className="ml-auto font-bold">
              {formatMoney(preview.line_total_cents, currency)}
            </span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
