import Link from "next/link";

/**
 * Phase 0 placeholder for a route-group surface. Renders the surface name and a
 * short description so the page deploys and is visually verifiable. Replaced by
 * the real UI in later phases.
 */
export function SurfacePlaceholder({
  surface,
  description,
  children,
}: {
  surface: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 p-8">
      <div className="space-y-1">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {surface}
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          {surface} surface — Phase 0 placeholder
        </h1>
        <p className="text-muted-foreground">{description}</p>
      </div>
      {children}
      <Link className="text-sm underline" href="/">
        ← Back to home
      </Link>
    </main>
  );
}
