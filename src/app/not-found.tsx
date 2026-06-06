import type { Metadata } from "next";
import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

/** Root 404. Consistent empty-state styling with a route home. */
export default function NotFound() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center p-6"
    >
      <EmptyState
        icon={FileQuestion}
        title="Page not found"
        description="The page you're looking for doesn't exist or has moved."
        action={
          <Button asChild>
            <Link href="/">Back to home</Link>
          </Button>
        }
      />
    </main>
  );
}
