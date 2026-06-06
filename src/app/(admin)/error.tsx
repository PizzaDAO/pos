"use client";

import { RouteError } from "@/components/ui/route-error";

export default function AdminError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      {...props}
      scope="admin"
      title="The back office hit a snag"
      description="Please try again."
    />
  );
}
