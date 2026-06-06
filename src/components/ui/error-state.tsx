"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shared error-boundary UI (presentational). Used by route-level `error.tsx`
 * boundaries to render a consistent, accessible recovery screen with a retry
 * action. No logging/business logic here — boundaries pass `reset` from React.
 */
export function ErrorState({
  title = "Something went wrong",
  description = "An unexpected error occurred. You can try again.",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <AlertTriangle
        className="h-10 w-10 text-destructive"
        aria-hidden="true"
      />
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      {onRetry && (
        <Button onClick={onRetry} className="mt-2">
          Try again
        </Button>
      )}
    </div>
  );
}
