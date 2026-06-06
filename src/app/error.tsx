"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/error-state";
import { captureError } from "@/lib/observability";

/**
 * Root error boundary. Catches render/runtime errors in the page tree and shows
 * a consistent recovery screen with a retry. Errors are forwarded to the
 * existing observability sink (no new logic — just reuse).
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureError(error, { scope: "app", route: "root" });
  }, [error]);

  return (
    <main id="main-content" className="min-h-screen">
      <ErrorState onRetry={reset} />
    </main>
  );
}
