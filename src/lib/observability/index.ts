/**
 * Observability scaffolding (Phase 7). One import surface for the structured
 * logger, request/trace ids, and the error-tracking seam. All env-optional and
 * no-op-safe with zero configuration.
 */
export * from "./logger";
export * from "./trace";
export * from "./errors";
