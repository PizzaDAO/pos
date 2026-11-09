import type { MarketplaceAdapter, MarketplaceProviderKey } from "../types";
import { doorDashAdapter } from "./doordash";
import { grubhubAdapter } from "./grubhub";
import { simulatorAdapter } from "./simulator";
import { uberEatsAdapter } from "./ubereats";

const ADAPTERS: Record<MarketplaceProviderKey, MarketplaceAdapter> = {
  doordash: doorDashAdapter,
  ubereats: uberEatsAdapter,
  grubhub: grubhubAdapter,
  simulator: simulatorAdapter,
};

export function getAdapter(key: MarketplaceProviderKey): MarketplaceAdapter {
  return ADAPTERS[key];
}
