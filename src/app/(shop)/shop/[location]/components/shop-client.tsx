/**
 * Storefront client (Phase 4) — mobile-first customer ordering.
 *
 * Orchestrates: menu browse + the SHARED pizza builder (reused verbatim from the
 * terminal, incl. half-and-half) → a customer cart (separate store) → checkout
 * (fulfillment, scheduling, identity, payment) → confirmation + tracking link.
 *
 * Heavy reuse: `MenuBrowse` and `PizzaBuilder` are the exact Phase 1 components;
 * pricing comes from `@/lib/pricing`; payment from the existing `stripe_online`/
 * crypto rails via `/api/payments`. Nothing is duplicated.
 */
"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ShoppingBag } from "lucide-react";
import type { MenuItemDetail, OrderItem } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/pricing";
import { useShop } from "@/lib/store/use-shop";
import { useCustomerCart } from "@/lib/store/customer-cart";
import { MenuBrowse } from "@/app/(terminal)/terminal/components/menu-browse";
import { PizzaBuilder } from "@/app/(terminal)/terminal/components/pizza-builder";
import { CustomerCart } from "./customer-cart-panel";
import { CheckoutFlow } from "./checkout-flow";

export function ShopClient({
  slug,
  locationName,
}: {
  slug: string;
  locationName: string;
}) {
  const { data, isLoading, isError, refetch } = useShop(slug);

  const setLocation = useCustomerCart((s) => s.setLocation);
  const items = useCustomerCart((s) => s.items);
  const addLine = useCustomerCart((s) => s.addLine);
  const updateLine = useCustomerCart((s) => s.updateLine);
  const itemCount = useCustomerCart((s) => s.itemCount());
  const subtotalCents = useCustomerCart((s) => s.subtotalCents());

  const [builderItem, setBuilderItem] = useState<MenuItemDetail | null>(null);
  const [editingLine, setEditingLine] = useState<OrderItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  // Bind the cart to this location (clears if switching shops).
  useEffect(() => {
    setLocation(slug);
  }, [slug, setLocation]);

  if (isLoading) {
    return (
      <div
        className="mx-auto min-h-screen w-full max-w-5xl p-4"
        aria-busy="true"
        aria-label="Loading menu"
      >
        <Skeleton className="mb-4 h-10 w-48" />
        <div className="mb-4 flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-full" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center">
        <EmptyState
          icon={AlertTriangle}
          title="Could not load this store"
          description="The store may be temporarily unavailable. Please try again."
          action={
            <Button variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const { menu, settings } = data;
  const currency = settings.currency;

  function openBuilder(item: MenuItemDetail) {
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
  function handleConfirm(line: OrderItem) {
    if (editingLine) updateLine(editingLine.id, line);
    else addLine(line);
    setBuilderItem(null);
    setEditingLine(null);
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Customer-facing branding header */}
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-primary">
              Order online
            </p>
            <h1 className="truncate text-lg font-bold">{locationName}</h1>
          </div>
          <Button
            variant="outline"
            className="relative"
            aria-label={`Open cart, ${itemCount} item${itemCount === 1 ? "" : "s"}, ${formatMoney(subtotalCents, currency)}`}
            onClick={() => setCartOpen(true)}
          >
            <ShoppingBag className="mr-2 h-4 w-4" aria-hidden="true" />
            {formatMoney(subtotalCents, currency)}
            {itemCount > 0 && (
              <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">
                {itemCount}
              </span>
            )}
          </Button>
        </div>
      </header>

      {/* Menu */}
      <main id="main-content" className="mx-auto w-full max-w-5xl flex-1">
        <MenuBrowse menu={menu} currency={currency} onSelectItem={openBuilder} />
      </main>

      {/* Sticky checkout bar (mobile) */}
      {itemCount > 0 && (
        <div className="sticky bottom-0 z-20 border-t bg-background p-3">
          <div className="mx-auto max-w-5xl">
            <Button
              className="h-12 w-full text-base"
              onClick={() => setCartOpen(true)}
            >
              <span>
                View cart · {itemCount} item{itemCount === 1 ? "" : "s"}
              </span>
              <span className="ml-auto font-bold">
                {formatMoney(subtotalCents, currency)}
              </span>
            </Button>
          </div>
        </div>
      )}

      {builderItem && (
        <PizzaBuilder
          item={builderItem}
          currency={currency}
          editing={editingLine ?? undefined}
          onCancel={() => {
            setBuilderItem(null);
            setEditingLine(null);
          }}
          onConfirm={handleConfirm}
        />
      )}

      {cartOpen && (
        <CustomerCart
          currency={currency}
          onClose={() => setCartOpen(false)}
          onEditLine={(line) => {
            setCartOpen(false);
            openBuilderForLine(line);
          }}
          onCheckout={() => {
            setCartOpen(false);
            setCheckoutOpen(true);
          }}
          empty={items.length === 0}
        />
      )}

      {checkoutOpen && (
        <CheckoutFlow
          slug={slug}
          shop={data}
          onClose={() => setCheckoutOpen(false)}
        />
      )}
    </div>
  );
}
