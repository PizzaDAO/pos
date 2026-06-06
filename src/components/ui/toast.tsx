/**
 * Minimal accessible toast system (presentational).
 *
 * A context provider + `useToast()` hook that renders transient notifications in
 * an `aria-live="polite"` region so screen readers announce them. Dependency-free
 * (no new packages); purely a UI concern — it never touches data or business
 * logic. Surfaces call `toast({ title, variant })` after an action succeeds or
 * fails to give consistent feedback.
 */
"use client";

import * as React from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastVariant = "success" | "error" | "info";

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms. Default 4000; 0 disables. */
  durationMs?: number;
}

interface ToastRecord extends Required<Omit<ToastInput, "description">> {
  id: number;
  description?: string;
}

const ToastContext = React.createContext<((t: ToastInput) => void) | null>(
  null,
);

/** Show a toast. Safe to call from any client component under ToastProvider. */
export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    // Fail soft: a missing provider should never crash a feature flow.
    return () => {};
  }
  return ctx;
}

const ICONS: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const VARIANT_STYLES: Record<ToastVariant, string> = {
  success: "border-emerald-500/40 text-emerald-900 dark:text-emerald-100",
  error: "border-destructive/50 text-destructive",
  info: "border-border text-foreground",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);
  const idRef = React.useRef(0);

  const remove = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    (input: ToastInput) => {
      const id = ++idRef.current;
      const record: ToastRecord = {
        id,
        title: input.title,
        description: input.description,
        variant: input.variant ?? "info",
        durationMs: input.durationMs ?? 4000,
      };
      setToasts((prev) => [...prev, record]);
      if (record.durationMs > 0) {
        setTimeout(() => remove(id), record.durationMs);
      }
    },
    [remove],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((t) => {
          const Icon = ICONS[t.variant];
          return (
            <div
              key={t.id}
              role="status"
              className={cn(
                "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-background p-3 shadow-lg",
                VARIANT_STYLES[t.variant],
              )}
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  {t.title}
                </p>
                {t.description && (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {t.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => remove(t.id)}
                aria-label="Dismiss notification"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
