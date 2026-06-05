import { SurfacePlaceholder } from "@/components/surface-placeholder";
import { ConnectOnboarding } from "./connect-onboarding";
import { DeliveryDispatch } from "./delivery-dispatch";

/**
 * Admin surface. Most of the tenant back office (menu mgmt, inventory, reports,
 * staff/shifts, end-of-day) is Phase 5. Phase 2 adds the Stripe Connect
 * onboarding scaffold; Phase 4 adds the in-house delivery dispatch board (assign
 * drivers to online delivery orders).
 */
export default function AdminPage() {
  return (
    <div className="min-h-screen">
      <ConnectOnboarding />
      <DeliveryDispatch />
      <div className="border-t">
        <SurfacePlaceholder
          surface="Admin"
          description="The rest of the tenant back office — menu management, inventory, reports, staff/shifts, end-of-day — is built in Phase 5."
        />
      </div>
    </div>
  );
}
