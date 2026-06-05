import { AdminShell } from "./components/admin-shell";

/**
 * Tenant back office (Phase 5). A tabbed surface over the demo tenant's two
 * locations: menu management (CRUD + per-location overrides + 86), inventory
 * (with sale-driven depletion + low-stock alerts), reports (per-location +
 * tenant rollup, payment mix, tips, voids/refunds), staff & shifts (clock in/out
 * + drawer reconciliation), and the end-of-day Z-report. The Phase 2 Stripe
 * Connect onboarding and the Phase 4 delivery dispatch board are reachable from
 * the Payments and Delivery tabs. All data flows through getPosDriver() (mock
 * driver today); the surface builds + runs with zero env vars.
 */
export default function AdminPage() {
  return <AdminShell />;
}
