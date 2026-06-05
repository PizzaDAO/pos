/**
 * Public entry point for the DB-access layer. Import everything DB-related from
 * `@/lib/db` so the underlying implementation (mock today, Supabase later) can
 * change in one place without touching call sites.
 */
export * from "./client";
export * from "./types";
export * from "./menu-types";
export * from "./payment-types";
export * from "./customer-types";
export * from "./backoffice-types";
export * from "./saas-types";
export * from "./driver";
export {
  DEMO_CONTEXT,
  DEMO_TENANT_ID,
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  PLATFORM_ADMIN_USER_ID,
  PLATFORM_ADMIN_EMAIL,
  DEMO_OWNER_USER_ID,
} from "./seed-data";
