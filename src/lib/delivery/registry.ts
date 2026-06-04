/**
 * Delivery provider registry.
 *
 * Maps each `DeliveryProviderKey` to its implementation. Phase 0 ships an EMPTY
 * registry — implementations register themselves in Phase 4. Keys are declared
 * up front so tenant/location config and the UI can reference them today.
 */

import type { DeliveryProvider, DeliveryProviderKey } from "./DeliveryProvider";

/** All provider keys the platform knows about, in display order. */
export const DELIVERY_PROVIDER_KEYS: readonly DeliveryProviderKey[] = [
  "in_house_manual",
  "doordash_drive",
] as const;

/** Human-readable labels for UI/config surfaces. */
export const DELIVERY_PROVIDER_LABELS: Record<DeliveryProviderKey, string> = {
  in_house_manual: "In-house (zones + manual dispatch)",
  doordash_drive: "DoorDash Drive",
};

/** Empty in Phase 0. Phase 4 populates this via `registerDeliveryProvider`. */
const registry = new Map<DeliveryProviderKey, DeliveryProvider>();

export function registerDeliveryProvider(provider: DeliveryProvider): void {
  registry.set(provider.key, provider);
}

export function getDeliveryProvider(
  key: DeliveryProviderKey,
): DeliveryProvider | undefined {
  return registry.get(key);
}

export function requireDeliveryProvider(
  key: DeliveryProviderKey,
): DeliveryProvider {
  const provider = registry.get(key);
  if (!provider) {
    throw new Error(`Delivery provider not implemented: ${key}`);
  }
  return provider;
}

export function isDeliveryProviderAvailable(key: DeliveryProviderKey): boolean {
  return registry.has(key);
}
