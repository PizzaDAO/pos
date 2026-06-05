/**
 * Customer cart store (Zustand) — Phase 4 online ordering.
 *
 * A SEPARATE store from the terminal's staff cart (`cart.ts`) so a customer's
 * in-progress online order never collides with a staff member's terminal order
 * in the same browser. Same line model + pricing helpers as the terminal cart
 * (reuse, not duplicate, the pricing math); persisted to localStorage so a
 * customer's cart survives a refresh.
 *
 * Totals are derived on demand from `items` + store settings via
 * `computeOrderTotals`, keeping a single source of truth.
 */
"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { OrderItem } from "@/lib/db";
import { computeSubtotalCents, withLinePricing } from "@/lib/pricing";

export interface CustomerCartState {
  /** Location slug this cart belongs to (cleared if the customer switches shops). */
  locationSlug: string | null;
  items: OrderItem[];

  /** Bind the cart to a location; clears items if switching to a different shop. */
  setLocation: (slug: string) => void;
  addLine: (line: OrderItem) => void;
  updateLine: (id: string, line: OrderItem) => void;
  setQuantity: (id: string, quantity: number) => void;
  removeLine: (id: string) => void;
  subtotalCents: () => number;
  itemCount: () => number;
  clear: () => void;
}

export const useCustomerCart = create<CustomerCartState>()(
  persist(
    (set, get) => ({
      locationSlug: null,
      items: [],

      setLocation: (slug) =>
        set((state) =>
          state.locationSlug === slug
            ? {}
            : { locationSlug: slug, items: [] },
        ),

      addLine: (line) =>
        set((state) => ({ items: [...state.items, withLinePricing(line)] })),

      updateLine: (id, line) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.id === id ? withLinePricing({ ...line, id }) : i,
          ),
        })),

      setQuantity: (id, quantity) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.id === id
              ? withLinePricing({ ...i, quantity: Math.max(1, quantity) })
              : i,
          ),
        })),

      removeLine: (id) =>
        set((state) => ({ items: state.items.filter((i) => i.id !== id) })),

      subtotalCents: () => computeSubtotalCents(get().items),

      itemCount: () =>
        get().items.reduce((n, i) => n + (i.voided ? 0 : i.quantity), 0),

      clear: () => set({ items: [] }),
    }),
    { name: "pos-customer-cart" },
  ),
);
