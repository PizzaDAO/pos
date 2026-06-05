/**
 * Cart store (Zustand) — Phase 1 terminal order building.
 *
 * Holds the in-progress order lines, an order-level discount, and order notes.
 * All money is integer cents. Line pricing is recomputed via `withLinePricing`
 * whenever a line is added or edited, so derived fields are always consistent.
 *
 * Totals (subtotal/tax/total) are NOT stored here — they are derived on demand
 * from `items` + store settings via `computeOrderTotals`, keeping a single
 * source of truth and avoiding stale totals.
 */
"use client";

import { create } from "zustand";
import type { OrderItem } from "@/lib/db";
import { computeSubtotalCents, withLinePricing } from "@/lib/pricing";

export interface CartState {
  items: OrderItem[];
  /** Order-level discount in cents. */
  discountCents: number;
  /** Order-level notes. */
  notes: string;

  /** Add a fully-built line; pricing fields are (re)computed on insert. */
  addLine: (line: OrderItem) => void;
  /** Replace an existing line by id (e.g. after editing modifiers). */
  updateLine: (id: string, line: OrderItem) => void;
  /** Change the quantity of a line (min 1). */
  setQuantity: (id: string, quantity: number) => void;
  /** Set per-line notes. */
  setLineNotes: (id: string, notes: string) => void;
  /** Mark a line voided (kept for audit, excluded from totals). */
  voidLine: (id: string) => void;
  /** Remove a line entirely. */
  removeLine: (id: string) => void;
  /** Set the order-level discount in cents (clamped >= 0). */
  setDiscount: (cents: number) => void;
  /** Set order-level notes. */
  setNotes: (notes: string) => void;
  /** Running subtotal (cents) of non-voided lines. */
  subtotalCents: () => number;
  /** Total non-voided line count (sum of quantities). */
  itemCount: () => number;
  /** Empty the cart (after placing an order). */
  clear: () => void;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  discountCents: 0,
  notes: "",

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

  setLineNotes: (id, notes) =>
    set((state) => ({
      items: state.items.map((i) =>
        i.id === id ? { ...i, notes: notes || null } : i,
      ),
    })),

  voidLine: (id) =>
    set((state) => ({
      items: state.items.map((i) =>
        i.id === id ? withLinePricing({ ...i, voided: true }) : i,
      ),
    })),

  removeLine: (id) =>
    set((state) => ({ items: state.items.filter((i) => i.id !== id) })),

  setDiscount: (cents) => set({ discountCents: Math.max(0, Math.round(cents)) }),

  setNotes: (notes) => set({ notes }),

  subtotalCents: () => computeSubtotalCents(get().items),

  itemCount: () =>
    get().items.reduce((n, i) => n + (i.voided ? 0 : i.quantity), 0),

  clear: () => set({ items: [], discountCents: 0, notes: "" }),
}));
