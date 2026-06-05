/**
 * Public entry point for the DB-access layer. Import everything DB-related from
 * `@/lib/db` so the underlying implementation (mock today, Supabase later) can
 * change in one place without touching call sites.
 */
export * from "./client";
export * from "./types";
export * from "./menu-types";
export * from "./payment-types";
export * from "./driver";
export {
  DEMO_CONTEXT,
  DEMO_TENANT_ID,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
} from "./seed-data";
