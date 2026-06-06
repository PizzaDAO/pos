/**
 * Menu browse — category tabs + a touch-friendly item grid for the active
 * location. Selecting an item opens the pizza builder.
 */
"use client";

import { memo, useState } from "react";
import type { Menu, MenuItemDetail } from "@/lib/db";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/pricing";

export interface MenuBrowseProps {
  menu: Menu;
  currency: string;
  onSelectItem: (item: MenuItemDetail) => void;
}

function MenuBrowseImpl({ menu, currency, onSelectItem }: MenuBrowseProps) {
  const [activeCategoryId, setActiveCategoryId] = useState<string>(
    menu.categories[0]?.id ?? "",
  );

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
                "shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors",
                selected
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-accent",
              )}
            >
              {c.name}
            </button>
          );
        })}
      </div>

      {/* Item grid */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {activeCategory?.items.map((item) => {
            const from = startingPrice(item);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectItem(item)}
                aria-label={
                  from !== null
                    ? `${item.name}, from ${formatMoney(from, currency)}. Customize and add.`
                    : `${item.name}. Customize and add.`
                }
                className="flex min-h-[96px] flex-col items-start rounded-xl border p-4 text-left transition-colors hover:border-primary hover:bg-accent"
              >
                <span className="font-semibold">{item.name}</span>
                {item.description && (
                  <span className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {item.description}
                  </span>
                )}
                <span className="mt-auto pt-2 text-sm font-medium text-primary">
                  {from !== null
                    ? `from ${formatMoney(from, currency)}`
                    : "Select"}
                </span>
                {item.is_half_and_half_capable && (
                  <span className="mt-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
                    half &amp; half
                  </span>
                )}
              </button>
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
