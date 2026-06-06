"use client";

import { RouteError } from "@/components/ui/route-error";

export default function KitchenError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      {...props}
      scope="kitchen"
      title="The kitchen display hit a snag"
      description="Tickets will reload after retrying."
    />
  );
}
