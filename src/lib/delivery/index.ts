/**
 * Delivery barrel. Importing this registers every provider (via ./providers)
 * and re-exports the public delivery surface: the interface types, the registry,
 * the zone helpers, the errors, and the env guards.
 */
import "./providers";

export * from "./DeliveryProvider";
export * from "./registry";
export * from "./zones";
export * from "./errors";
export { isDoorDashConfigured } from "./env";
export { registerAllDeliveryProviders } from "./providers";
