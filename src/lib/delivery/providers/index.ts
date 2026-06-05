/**
 * Provider registration (Phase 4). Importing this module registers every
 * delivery provider implementation into the registry — mirroring the payment
 * rails' `./rails` barrel. Import `@/lib/delivery` (or this file) anywhere a
 * provider must be resolvable.
 */
import { registerDeliveryProvider } from "../registry";
import { inHouseManualProvider } from "./in-house-manual";
import { doorDashDriveProvider } from "./doordash-drive";

let registered = false;

export function registerAllDeliveryProviders(): void {
  if (registered) return;
  registered = true;
  registerDeliveryProvider(inHouseManualProvider);
  registerDeliveryProvider(doorDashDriveProvider);
}

// Register on import so a bare `import "@/lib/delivery/providers"` is enough.
registerAllDeliveryProviders();

export { inHouseManualProvider, doorDashDriveProvider };
