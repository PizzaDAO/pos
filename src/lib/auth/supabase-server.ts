/**
 * Server-side Supabase clients (real-auth) via `@supabase/ssr`.
 *
 * Two flavours, both ENV-GUARDED (return null when the public Supabase env vars
 * are absent — the zero-env / mock default — so the app builds/runs/tests with
 * no configuration):
 *
 *  - `getServerSupabase()` — anon-key client bound to the request's auth cookies
 *    (Next.js `cookies()`), so reads/writes run AS THE LOGGED-IN USER and RLS is
 *    enforced. This is the preferred client for tenant-scoped data access.
 *  - `getMiddlewareSupabase(req, res)` — the same, wired to a middleware
 *    request/response so the session cookie can be refreshed on every request.
 *
 * Server-only: imports `next/headers`. Nothing reads env at module load.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";

/** True when the public Supabase env is present (real-auth enabled). */
export function isSupabaseAuthConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * A request-scoped Supabase client backed by the auth cookies of the current
 * request (RSC / route handler). Runs AS THE USER — RLS enforced. Returns null
 * when unconfigured so callers fall back to the simulated/mock session.
 *
 * Cookie writes are best-effort: in a pure Server Component render Next.js
 * disallows setting cookies, so we swallow the error (the middleware refreshes
 * the session there instead).
 */
export async function getServerSupabase(): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render — ignore; middleware refreshes.
        }
      },
    },
  });
}

/**
 * A Supabase client wired to a middleware request/response pair so the auth
 * session can be refreshed and the rotated cookies written back onto `res`.
 * Returns null when unconfigured.
 */
export function getMiddlewareSupabase(
  req: NextRequest,
  res: NextResponse,
): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
        for (const { name, value, options } of cookiesToSet) {
          req.cookies.set(name, value);
          res.cookies.set(name, value, options);
        }
      },
    },
  });
}
