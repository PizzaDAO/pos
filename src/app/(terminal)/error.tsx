"use client";

import { RouteError } from "@/components/ui/route-error";

export default function TerminalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      {...props}
      scope="terminal"
      title="The terminal hit a snag"
      description="Order taking will resume after retrying. Queued offline orders are safe."
    />
  );
}
