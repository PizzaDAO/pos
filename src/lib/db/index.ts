/**
 * Public entry point for the DB-access layer. Import everything DB-related from
 * `@/lib/db` so the underlying implementation (Supabase, etc.) can change in one
 * place without touching call sites.
 */
export * from "./client";
export * from "./types";
