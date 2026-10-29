/**
 * Server HMAC signing secret (server-only) for short-lived capability tokens:
 * the signup onboarding token and the terminal active-staff cookie (each uses
 * its own domain-separation prefix).
 *
 * ONBOARDING_TOKEN_SECRET, else SUPABASE_SERVICE_ROLE_KEY. In REAL mode (real
 * driver or real auth) with neither set this returns null and callers FAIL
 * CLOSED — a per-process random secret would silently break across serverless
 * instances. Only the zero-env demo (mock driver, no auth) falls back to a
 * per-process random secret, matching its per-process state.
 */
import { randomBytes } from "node:crypto";
import { getPosDriver } from "@/lib/db";
import { isSupabaseAuthConfigured } from "./supabase-server";

let processSecret: string | null = null;

/** Real driver or real auth active (i.e. not the zero-env demo). */
export function isRealMode(): boolean {
  return getPosDriver().name !== "mock" || isSupabaseAuthConfigured();
}

export function signingSecret(): string | null {
  const configured =
    process.env.ONBOARDING_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (configured) return configured;
  if (isRealMode()) return null;
  if (!processSecret) processSecret = randomBytes(32).toString("hex");
  return processSecret;
}
