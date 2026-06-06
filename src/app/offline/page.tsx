import type { Metadata } from "next";
import { WifiOff } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = {
  title: "Offline",
  description: "You are currently offline.",
  robots: { index: false, follow: false },
};

/**
 * Offline fallback page (PWA). Serwist serves this when a navigation request
 * fails with no network and no cached page. The terminal itself keeps working
 * offline via its IndexedDB queue + cached menu; this page is the shell shown
 * for uncached navigations. Static, zero-env, no client JS required.
 */
export default function OfflinePage() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center p-6"
    >
      <EmptyState
        icon={WifiOff}
        title="You're offline"
        description="This page isn't available without a connection. The terminal keeps taking orders offline and will sync automatically once you're back online."
      />
    </main>
  );
}
