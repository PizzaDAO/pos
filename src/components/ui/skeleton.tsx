import { cn } from "@/lib/utils";

/**
 * Loading skeleton block. Presentational only — a pulsing muted placeholder used
 * while async UI (menu, reports, KDS) loads, in place of bare "Loading…" text.
 * `aria-hidden` so screen readers ignore the decorative shimmer; callers should
 * expose loading state via an `aria-busy`/live region on the container.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
    />
  );
}
