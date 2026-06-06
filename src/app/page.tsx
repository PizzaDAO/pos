import Link from "next/link";
import { Button } from "@/components/ui/button";

const surfaces = [
  {
    href: "/terminal",
    title: "Terminal",
    desc: "Counter POS (offline-first PWA).",
  },
  { href: "/kitchen", title: "Kitchen", desc: "Kitchen display system (KDS)." },
  {
    href: "/admin",
    title: "Admin",
    desc: "Tenant back office: menu, reports, staff.",
  },
  {
    href: "/shop/tonys-downtown",
    title: "Shop",
    desc: "Customer online ordering storefront.",
  },
  {
    href: "/platform",
    title: "Platform",
    desc: "Super-admin: tenants, billing, support.",
  },
  {
    href: "/signup",
    title: "Sign up",
    desc: "Self-serve onboarding: create a new pizzeria.",
  },
];

export default function HomePage() {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 p-8"
    >
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Pizzeria POS</h1>
        <p className="text-muted-foreground">
          A multi-tenant SaaS point-of-sale platform for independent pizzerias:
          an offline-first counter terminal, kitchen display, customer online
          ordering, and a tenant back office — all in one place.
        </p>
      </header>

      <nav aria-label="Product surfaces" className="grid gap-3 sm:grid-cols-2">
        {surfaces.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-lg border p-4 transition-colors hover:bg-accent"
          >
            <div className="font-semibold">{s.title}</div>
            <div className="text-sm text-muted-foreground">{s.desc}</div>
          </Link>
        ))}
      </nav>

      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/signup">Start your pizzeria</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/platform">Open platform admin</Link>
        </Button>
      </div>
    </main>
  );
}
