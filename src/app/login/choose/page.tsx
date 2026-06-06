import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { tenantsForSurface, type GatedSurface } from "@/lib/auth/roles";
import { getPosDriver } from "@/lib/db";

/**
 * Tenant/location chooser. Shown when a signed-in user belongs to MULTIPLE
 * tenants for the requested surface. Picking a tenant enters the surface scoped
 * with `?tenant=<id>`. Single-tenant users never land here (the guard auto-picks
 * and a one-tenant list redirects straight through).
 */
export const dynamic = "force-dynamic";

const SURFACE_LABEL: Record<string, string> = {
  admin: "Back office",
  terminal: "Terminal",
  kitchen: "Kitchen display",
};

export default async function ChooseTenantPage({
  searchParams,
}: {
  searchParams: Promise<{ surface?: string }>;
}) {
  const { surface: surfaceParam } = await searchParams;
  const surface = (
    surfaceParam === "terminal" || surfaceParam === "kitchen"
      ? surfaceParam
      : "admin"
  ) as Exclude<GatedSurface, "platform">;

  const user = await getCurrentUser();
  if (!user) redirect(`/login?redirect=/${surface}`);

  const allowed = tenantsForSurface(user.memberships, surface);
  if (allowed.length === 0) redirect("/forbidden");
  if (allowed.length === 1) redirect(`/${surface}?tenant=${allowed[0]}`);

  const driver = getPosDriver();
  const tenants = await Promise.all(
    allowed.map(async (id) => ({ id, tenant: await driver.getTenant(id) })),
  );

  return (
    <div className="mx-auto mt-24 w-full max-w-md rounded-lg border p-6">
      <h1 className="mb-1 text-xl font-semibold">Choose a pizzeria</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        You have access to multiple businesses. Pick one to open{" "}
        {SURFACE_LABEL[surface] ?? surface}.
      </p>
      <ul className="space-y-2">
        {tenants.map(({ id, tenant }) => (
          <li key={id}>
            <a
              href={`/${surface}?tenant=${id}`}
              className="block rounded-md border px-4 py-3 text-sm font-medium hover:bg-secondary"
            >
              {tenant?.name ?? id}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
