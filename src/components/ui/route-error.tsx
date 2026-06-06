"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/error-state";
import { captureError } from "@/lib/observability";

/**
 * Reusable body for a route-group `error.tsx`. Logs via the shared observability
 * seam and renders the consistent ErrorState with a retry. Route files are thin
 * wrappers that pass their scope label.
 */
export function RouteError({
  error,
  reset,
  scope,
  title,
  description,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  scope: string;
  title?: string;
  description?: string;
}) {
  useEffect(() => {
    captureError(error, { scope: "app", route: scope });
  }, [error, scope]);

  return (
    <main id="main-content" className="min-h-screen">
      <ErrorState onRetry={reset} title={title} description={description} />
    </main>
  );
}
