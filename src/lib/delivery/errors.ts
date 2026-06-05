/**
 * Delivery error types (Phase 4). Kept in their own module so providers, the
 * service layer, and the API routes can share them without circular imports.
 */

/** Thrown when an address can't be served (out of zone / below minimum). */
export class DeliveryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryUnavailableError";
  }
}
