/**
 * Payments barrel. Importing this registers every rail (via ./rails) and
 * re-exports the public payment surface: the interface types, the registry, the
 * fee math, the env guards, and the Connect helpers.
 */
import "./rails";

export * from "./PaymentRail";
export * from "./registry";
export * from "./fees";
export {
  isStripeConfigured,
  isCoinbaseConfigured,
  isOnchainConfigured,
  getDefaultPlatformFee,
} from "./env";
export { registerAllRails } from "./rails";
