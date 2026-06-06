/**
 * Accessible modal dialog primitive (presentational).
 *
 * Wraps the app's hand-rolled overlay modals (pizza builder, cart drawer, staff
 * switch, payment, confirmation) with shared a11y behaviour so every modal in
 * the app behaves identically:
 *
 *  - `role="dialog"` + `aria-modal` + a labelled title (via `aria-labelledby` or
 *    an explicit `aria-label`).
 *  - **Focus trap**: Tab/Shift+Tab cycle within the dialog; focus moves into the
 *    dialog on open and is restored to the trigger on close.
 *  - **Esc to close** and **click-on-backdrop to close** (both optional).
 *  - **Scroll lock** on the body while open.
 *
 * Purely presentational — no business logic. The caller still owns open/close
 * state and renders its own content/footer. This does not change any data flow.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  /** Called when the user requests close (Esc, backdrop click, or close button). */
  onClose: () => void;
  /** Accessible name when there is no visible title element to reference. */
  ariaLabel?: string;
  /** id of the visible title element inside `children` (preferred over ariaLabel). */
  labelledBy?: string;
  /** Close when the backdrop is clicked. Default: true. */
  closeOnBackdrop?: boolean;
  /** Close when Esc is pressed. Default: true. */
  closeOnEsc?: boolean;
  /** Positioning of the panel within the viewport. */
  placement?: "center" | "bottom" | "right";
  /** Extra classes for the backdrop container. */
  className?: string;
  children: React.ReactNode;
}

const PLACEMENT: Record<NonNullable<DialogProps["placement"]>, string> = {
  center: "items-end justify-center sm:items-center",
  bottom: "items-end justify-center",
  right: "items-stretch justify-end",
};

export function Dialog({
  onClose,
  ariaLabel,
  labelledBy,
  closeOnBackdrop = true,
  closeOnEsc = true,
  placement = "center",
  className,
  children,
}: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  // Move focus into the dialog on open; restore it to the previously-focused
  // element (typically the trigger) on close.
  React.useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    return () => previouslyFocused?.focus?.();
  }, []);

  // Lock body scroll while the dialog is mounted.
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && closeOnEsc) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex bg-black/40 p-0 sm:p-4",
        PLACEMENT[placement],
        className,
      )}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-full flex-col outline-none"
        // Stop the backdrop's mousedown handler firing for clicks inside.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
