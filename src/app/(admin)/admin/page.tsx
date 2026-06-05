import { SurfacePlaceholder } from "@/components/surface-placeholder";
import { ConnectOnboarding } from "./connect-onboarding";

/**
 * Admin surface. Most of the tenant back office (menu mgmt, inventory, reports,
 * staff/shifts, end-of-day) is Phase 5. Phase 2 adds the Stripe Connect
 * onboarding scaffold so a tenant can connect their payout account.
 */
export default function AdminPage() {
  return (
    <div className="min-h-screen">
      <ConnectOnboarding />
      <div className="border-t">
        <SurfacePlaceholder
          surface="Admin"
          description="The rest of the tenant back office — menu management, inventory, reports, staff/shifts, end-of-day — is built in Phase 5."
        />
      </div>
    </div>
  );
}
