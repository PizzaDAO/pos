"use client";

import { RouteError } from "@/components/ui/route-error";

export default function PlatformError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      {...props}
      scope="platform"
      title="The platform console hit a snag"
      description="Please try again."
    />
  );
}
