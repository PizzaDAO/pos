/**
 * Pizza builder — size, crust, sauce, toppings (with half-and-half), quantity,
 * and special instructions, with a live line-price preview. Used both for adding
 * a new line and editing an existing one. Sizes and options 86'd at this
 * location show "Sold out" and can't be picked.
 */
"use client";

import { MAX_LINE_QUANTITY } from "@/lib/shop/reprice";
import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { HalfPlacement, MenuItemDetail, OrderItem } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { soldOutSets, type SoldOut } from "@/lib/menu-availability";
import { formatMoney, withLinePricing } from "@/lib/pricing";
import { defaultSizeFor } from "@/lib/till/default-size";
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
  /** What is 86'd at this location. */
  soldOut?: SoldOut;
  /** Size name to preselect for a new line (the till's default size). */
  defaultSizeName?: string | null;
}

const NONE_SOLD_OUT = soldOutSets(null);

export function PizzaBuilder({
  item,
  currency,
  editing,
  onCancel,
  onConfirm,
  soldOut = NONE_SOLD_OUT,
  defaultSizeName = null,
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
      // Default required single-select groups to their first in-stock option.
      for (const g of singleGroups) {
        const first = g.modifiers.find((m) => !soldOut.modifiers.has(m.id));
        if (g.min_select >= 1 && first) {
          single[g.id] = first.id;
        }
      }
    }

    const sizeId =
      editing?.size_id ??
      defaultSizeFor(item, soldOut.sizes, defaultSizeName)?.id ??
      null;
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
  // Server rules (see lib/shop/reprice.ts) the builder must never violate:
  // half placements only on half-and-half-capable items, max_select per group.
  const halfAllowed = item.is_half_and_half_capable;
  const pickedIn = (g: (typeof halfGroups)[number]) =>
    g.modifiers.filter((m) => toppings[m.id]).length;
  const overMax = halfGroups.filter((g) => pickedIn(g) > g.max_select);
  // min_select applies to multi-select (topping) groups too, as on the server.
  const missingRequired = [
    ...singleGroups
      .filter((g) => g.min_select >= 1 && !single[g.id])
      .map((g) => g.name),
    ...halfGroups
      .filter((g) => pickedIn(g) < g.min_select)
      .map((g) => `${g.name} (at least ${g.min_select})`),
  ];
  const needsSize = item.sizes.length > 0 && !sizeId;
  // A sold-out size/option (e.g. on a line being edited) must be swapped out:
  // the server would refuse the order at Place order.
  const soldOutPicked = [
    ...(size && soldOut.sizes.has(size.id) ? [size.name] : []),
    ...selections
      .filter((sel) => soldOut.modifiers.has(sel.modifier.id))
      .map((sel) => sel.modifier.name),
  ];
  const itemSoldOut = soldOut.items.has(item.id);
  const valid =
    missingRequired.length === 0 &&
    !needsSize &&
    overMax.length === 0 &&
    soldOutPicked.length === 0 &&
    !itemSoldOut;

  function setToppingPlacement(
    modId: string,
    placement: HalfPlacement,
    maxSelect: number,
    groupModIds: string[],
  ) {
    setToppings((prev) => {
      const next = { ...prev };
      if (next[modId] === placement) {
        delete next[modId];
      } else {
        // Adding a NEW topping beyond the group's max_select is refused.
        const picked = groupModIds.filter((id) => next[id]).length;
        if (!next[modId] && picked >= maxSelect) return prev;
        next[modId] = placement;
      }
      return next;
    });
  }

  return (
    <Dialog
      onClose={onCancel}
      ariaLabel={`Build ${item.name}`}
      placement="center"
    >
      <div className="flex max-h-[96dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl bg-background shadow-xl sm:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-2">
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
            className="h-11 w-11"
            onClick={onCancel}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {/* Sizes */}
          {item.sizes.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Size
              </h3>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {item.sizes.map((s) => {
                  const out = soldOut.sizes.has(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={out}
                      onClick={() => setSizeId(s.id)}
                      className={cn(
                        "flex min-h-14 flex-col items-center justify-center rounded-lg border px-2 py-1.5 text-sm transition-colors touch-manipulation disabled:cursor-not-allowed disabled:border-dashed disabled:bg-muted",
                        sizeId === s.id
                          ? "border-primary bg-primary/10 font-semibold"
                          : "hover:bg-accent",
                      )}
                    >
                      <span className={cn(out && "line-through")}>{s.name}</span>
                      <span className="text-muted-foreground">
                        {out ? "Sold out" : formatMoney(s.price_cents, currency)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Single-select groups (crust, sauce) sit side by side to save height */}
          <div className="grid gap-4 md:grid-cols-2">
          {singleGroups.map((g) => (
            <section key={g.id}>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {g.name}
                {g.min_select >= 1 && (
                  <span className="ml-1 text-destructive">*</span>
                )}
              </h3>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                {g.modifiers.map((m) => {
                  const out = soldOut.modifiers.has(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={out}
                      onClick={() =>
                        setSingle((prev) => ({ ...prev, [g.id]: m.id }))
                      }
                      className={cn(
                        "flex min-h-14 flex-col items-center justify-center rounded-lg border px-2 py-1.5 text-sm transition-colors touch-manipulation disabled:cursor-not-allowed disabled:border-dashed disabled:bg-muted",
                        single[g.id] === m.id
                          ? "border-primary bg-primary/10 font-semibold"
                          : "hover:bg-accent",
                      )}
                    >
                      <span className={cn(out && "line-through")}>{m.name}</span>
                      {out ? (
                        <span className="text-muted-foreground">Sold out</span>
                      ) : (
                        m.price_cents > 0 && (
                          <span className="text-muted-foreground">
                            +{formatMoney(m.price_cents, currency)}
                          </span>
                        )
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          </div>

          {/* Half-and-half topping groups */}
          {halfGroups.map((g) => (
            <section key={g.id}>
              <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {g.name}
              </h3>
              <p className="mb-1.5 text-xs text-muted-foreground">
                {halfAllowed
                  ? "Tap a topping for the whole pizza, or L / R for one half (half price)."
                  : "Choose the toppings for the whole pizza."}{" "}
                {`Up to ${g.max_select}.`}
              </p>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                {g.modifiers.map((m) => {
                  const placement = toppings[m.id];
                  const out = soldOut.modifiers.has(m.id);
                  const atMax = !placement && pickedIn(g) >= g.max_select;
                  const pick = (p: HalfPlacement) =>
                    setToppingPlacement(
                      m.id,
                      p,
                      g.max_select,
                      g.modifiers.map((x) => x.id),
                    );
                  return (
                    <div
                      key={m.id}
                      data-topping={m.name}
                      className={cn(
                        "flex items-stretch gap-1 rounded-lg border p-1",
                        placement && "border-primary bg-primary/5",
                      )}
                    >
                      {/* Whole is the main tap; L / R are secondary toggles. */}
                      <button
                        type="button"
                        aria-pressed={placement === "whole"}
                        disabled={atMax || (out && placement !== "whole")}
                        onClick={() => pick("whole")}
                        className={cn(
                          "flex min-h-12 min-w-0 flex-1 flex-col items-start justify-center rounded-md px-2 text-left transition-colors touch-manipulation disabled:cursor-not-allowed disabled:opacity-40",
                          placement === "whole"
                            ? "bg-primary text-primary-foreground"
                            : placement
                              ? "bg-primary/10"
                              : "hover:bg-accent",
                        )}
                      >
                        <span
                          className={cn(
                            "w-full truncate text-sm font-medium",
                            out && "line-through",
                          )}
                        >
                          {m.name}
                        </span>
                        <span
                          className={cn(
                            "text-xs",
                            placement === "whole"
                              ? "text-primary-foreground/80"
                              : "text-muted-foreground",
                          )}
                        >
                          {out
                            ? "Sold out"
                            : placement === "left"
                              ? `Left +${formatMoney(placementPriceCents(m.price_cents, "left"), currency)}`
                              : placement === "right"
                                ? `Right +${formatMoney(placementPriceCents(m.price_cents, "right"), currency)}`
                                : `+${formatMoney(m.price_cents, currency)}`}
                        </span>
                      </button>
                      {halfAllowed &&
                        (["left", "right"] as const).map((side) => (
                          <button
                            key={side}
                            type="button"
                            aria-pressed={placement === side}
                            aria-label={side === "left" ? "L" : "R"}
                            title={`${side === "left" ? "Left" : "Right"} half only`}
                            disabled={atMax || (out && placement !== side)}
                            onClick={() => pick(side)}
                            className={cn(
                              "h-12 w-12 shrink-0 rounded-md border text-sm font-semibold transition-colors touch-manipulation disabled:cursor-not-allowed disabled:opacity-40",
                              placement === side
                                ? "border-primary bg-primary text-primary-foreground"
                                : "bg-background hover:bg-accent",
                            )}
                          >
                            {side === "left" ? "L" : "R"}
                          </button>
                        ))}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {/* Quantity + special instructions */}
          <section className="flex flex-wrap items-end gap-4">
            <div>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Quantity
              </h3>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-11 w-11"
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
                  className="h-11 w-11"
                  onClick={() => setQty((q) => Math.min(MAX_LINE_QUANTITY, q + 1))}
                  disabled={qty >= MAX_LINE_QUANTITY}
                  aria-label="Increase quantity"
                >
                  +
                </Button>
              </div>
            </div>
            <div className="min-w-[200px] flex-1">
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Special instructions
              </h3>
              <textarea
                aria-label="Special instructions"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. well done, cut in squares"
                rows={1}
                className="min-h-11 w-full rounded-lg border bg-background p-2 text-base sm:text-sm"
              />
            </div>
          </section>
        </div>

        {/* Footer / live price + confirm */}
        <div className="border-t p-3">
          {missingRequired.length > 0 && (
            <p className="mb-2 text-xs text-destructive">
              Select: {missingRequired.join(", ")}
            </p>
          )}
          {(itemSoldOut || soldOutPicked.length > 0) && (
            <p role="alert" className="mb-2 text-sm font-medium text-destructive">
              {itemSoldOut
                ? `${item.name} is sold out here.`
                : `Sold out: ${soldOutPicked.join(", ")}. Pick something else.`}
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
