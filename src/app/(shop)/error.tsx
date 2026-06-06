"use client";

import { RouteError } from "@/components/ui/route-error";

export default function ShopError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      {...props}
      scope="shop"
      title="This store ran into a problem"
      description="We couldn't load the storefront. Please try again."
    />
  );
}
