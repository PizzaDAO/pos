/**
 * Menu browse — category tabs + a touch-friendly item grid for the active
 * location. Selecting an item opens the pizza builder. Items 86'd at this
 * location show greyed with a "Sold out" badge and refuse the tap. Managers get
 * an "86 items" mode: while it is on, tapping a tile 86s / un-86s it here.
 */
"use client";

import { memo, useRef, useState } from "react";
import type { Menu, MenuItemDetail } from "@/lib/db";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/pricing";
import { canQuickAdd, leadWord, sizeNamesOf } from "@/lib/till/default-size";
import {
  isItem86d,
  isItemSoldOut,
  soldOutSets,
  type SoldOut,
} from "@/lib/menu-availability";

const NONE_SOLD_OUT = soldOutSets(null);

export interface MenuBrowseProps {
  menu: Menu;
  currency: string;
  /** Open the builder for an item (tap on items with choices; long-press otherwise). */
  onSelectItem: (item: MenuItemDetail) => void;
  /** Add an item with nothing to choose straight to the cart. */
  onQuickAdd?: (item: MenuItemDetail) => void;
  /** The till's default pizza size name, and a way to change it. */
  defaultSizeName?: string;
  onDefaultSizeChange?: (name: string) => void;
  /** What is 86'd at this location (sold-out tiles are disabled). */
  soldOut?: SoldOut;
  /** Show the manager "86 items" toggle (owner/manager at the till). */
  canEightySix?: boolean;
  /** 86 (true) or un-86 (false) an item at this location. */
  onSetItem86?: (item: MenuItemDetail, eightySix: boolean) => void;
  /** An 86 / un-86 request is in flight (tiles wait). */
  eightySixBusy?: boolean;
}

function MenuBrowseImpl({
  menu,
  currency,
  onSelectItem,
  onQuickAdd,
  defaultSizeName,
  onDefaultSizeChange,
  soldOut = NONE_SOLD_OUT,
  canEightySix = false,
  onSetItem86,
  eightySixBusy = false,
}: MenuBrowseProps) {
  const [eightySixMode, setEightySixMode] = useState(false);
  const managing = canEightySix && eightySixMode && !!onSetItem86;
  const [activeCategoryId, setActiveCategoryId] = useState<string>(
    menu.categories[0]?.id ?? "",
  );

  // Long-press on a one-tap item opens its builder instead of adding it.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  function startPress(item: MenuItemDetail) {
    longPressed.current = false;
    if (!onQuickAdd || !canQuickAdd(item)) return;
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      onSelectItem(item);
    }, 500);
  }
  function endPress() {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  }

  const allItems = menu.categories.flatMap((c) => c.items);
  const sizeNames = sizeNamesOf(allItems);
  // Pizzas' sizes: what the default applies to (shown when the saved/fallback one is absent).
  const pizzaSizeNames = sizeNamesOf(allItems.filter((i) => i.is_half_and_half_capable));
  const activeCategory =
    menu.categories.find((c) => c.id === activeCategoryId) ??
    menu.categories[0];

  function startingPrice(item: MenuItemDetail): number | null {
    if (item.sizes.length === 0) return null;
    return Math.min(...item.sizes.map((s) => s.price_cents));
  }

  return (
    <div className="flex h-full flex-col">
      {/* Category filter buttons */}
      <div
        role="group"
        aria-label="Menu categories"
        className="flex gap-2 overflow-x-auto border-b p-3"
      >
        {menu.categories.map((c) => {
          const selected = activeCategory?.id === c.id;
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={selected}
              onClick={() => setActiveCategoryId(c.id)}
              className={cn(
                "min-h-11 shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors",
                selected
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-accent",
              )}
            >
              {c.name}
            </button>
          );
        })}
        {onDefaultSizeChange && sizeNames.length > 1 && (
          <label className="ml-auto flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
            Default size
            <select
              aria-label="Default size"
              value={
                sizeNames.find((n) => leadWord(n) === leadWord(defaultSizeName ?? "")) ??
                pizzaSizeNames[0] ??
                ""
              }
              onChange={(e) => onDefaultSizeChange(e.target.value)}
              className="min-h-11 rounded-md border bg-background px-2 text-sm text-foreground"
            >
              {sizeNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {canEightySix && onSetItem86 && (
          <button
            type="button"
            aria-pressed={eightySixMode}
            onClick={() => setEightySixMode((v) => !v)}
            className={cn(
              "min-h-11 shrink-0 rounded-full border px-4 py-2 text-sm font-medium transition-colors",
              !onDefaultSizeChange && "ml-auto",
              eightySixMode
                ? "border-destructive bg-destructive text-destructive-foreground"
                : "hover:bg-accent",
            )}
          >
            {eightySixMode ? "Done 86ing" : "86 items"}
          </button>
        )}
      </div>

      {managing && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-2 border-b bg-destructive/10 px-3 py-2 text-sm font-medium"
        >
          Tap an item to 86 it here, or tap a sold-out item to bring it back.
          <a href="/admin" className="underline underline-offset-2">
            Sizes and toppings: Admin → Menu
          </a>
        </p>
      )}

      {/* Item grid */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-3 min-[700px]:grid-cols-3 lg:grid-cols-3">
          {activeCategory?.items.map((item) => {
            const from = startingPrice(item);
            const out = isItemSoldOut(item, soldOut);
            const item86d = isItem86d(item.id, soldOut);
            const quick = !managing && !!onQuickAdd && canQuickAdd(item);
            return (
              <div key={item.id} className="relative">
              <button
                type="button"
                // Sold out: the tap is refused (except to un-86 in 86 mode).
                disabled={managing ? eightySixBusy : out}
                onPointerDown={() => !managing && startPress(item)}
                onPointerUp={endPress}
                onPointerLeave={() => {
                  endPress();
                  longPressed.current = false;
                }}
                onPointerCancel={() => {
                  endPress();
                  longPressed.current = false;
                }}
                onKeyDown={() => {
                  longPressed.current = false;
                }}
                onContextMenu={(e) => onQuickAdd && canQuickAdd(item) && e.preventDefault()}
                onClick={() => {
                  if (managing) return onSetItem86?.(item, !item86d);
                  if (longPressed.current) {
                    longPressed.current = false;
                    return;
                  }
                  if (onQuickAdd && canQuickAdd(item)) onQuickAdd(item);
                  else onSelectItem(item);
                }}
                aria-label={
                  managing
                    ? `${item86d ? "Un-86" : "86"} ${item.name}`
                    : out
                      ? `${item.name}, sold out.`
                      : onQuickAdd && canQuickAdd(item)
                        ? `${item.name}, ${from !== null ? formatMoney(from, currency) : ""}. Add to order. Use Options to customize.`
                        : from !== null
                          ? `${item.name}, from ${formatMoney(from, currency)}. Customize and add.`
                          : `${item.name}. Customize and add.`
                }
                className={cn(
                  "flex min-h-[96px] w-full flex-col items-start rounded-xl border p-4 text-left transition-colors",
                  out
                    ? "border-dashed bg-muted text-muted-foreground"
                    : "hover:border-primary hover:bg-accent",
                  out && !managing && "cursor-not-allowed",
                  managing && "hover:border-destructive",
                )}
              >
                <span className="flex w-full items-start justify-between gap-2">
                  <span className={cn("font-semibold", out && "line-through")}>
                    {item.name}
                  </span>
                  {out && (
                    <span className="shrink-0 rounded-full bg-destructive px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-destructive-foreground">
                      Sold out
                    </span>
                  )}
                </span>
                {item.description && (
                  <span className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {item.description}
                  </span>
                )}
                <span
                  className={cn(
                    "mt-auto pt-2 text-sm font-medium",
                    out ? "text-muted-foreground" : "text-primary",
                  )}
                >
                  {managing
                    ? item86d
                      ? "Tap to un-86"
                      : "Tap to 86"
                    : onQuickAdd && canQuickAdd(item)
                      ? `${from !== null ? formatMoney(from, currency) + " · " : ""}tap to add`
                      : from !== null
                        ? `from ${formatMoney(from, currency)}`
                        : "Select"}
                </span>
                {item.is_half_and_half_capable && (
                  <span className="mt-1 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-secondary-foreground">
                    half &amp; half
                  </span>
                )}
              </button>
              {quick && !out && (
                <button
                  type="button"
                  aria-label={`Options for ${item.name}`}
                  onClick={() => onSelectItem(item)}
                  className="absolute bottom-2 right-2 min-h-11 rounded-lg border bg-background px-3 text-sm font-medium touch-manipulation hover:bg-accent"
                >
                  Options
                </button>
              )}
              </div>
            );
          })}
        </div>
        {activeCategory && activeCategory.items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No items in this category.
          </p>
        )}
      </div>
    </div>
  );
}

/** Memoized: the item grid is a hot list re-rendered on cart/builder changes. */
export const MenuBrowse = memo(MenuBrowseImpl);
