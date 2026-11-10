/**
 * Request-scoped memo for the auth path: within ONE request, the session user
 * (GoTrue getUser + memberships + platform-admin) and a tenant's location list
 * are resolved once, however many guards run. Nothing is shared across
 * requests, so no check sees older data than it did before.
 *
 * The scope is the request's cookie store (`cookies()` returns the same object
 * for the whole request). Only in real-auth mode, where `cookies()` is read
 * anyway: in simulated mode calling it would make static pages dynamic, and
 * the in-memory mock needs no memo. Outside a request (tests, scripts) it is a
 * pass-through.
 *
 * Server-only: imports `next/headers`.
 */
import { cookies } from "next/headers";
import { isSupabaseAuthConfigured } from "./supabase-server";

const scopes = new WeakMap<object, Map<string, Promise<unknown>>>();

async function requestScope(): Promise<object | null> {
  if (!isSupabaseAuthConfigured()) return null;
  try {
    return (await cookies()) as unknown as object;
  } catch {
    return null; // not inside a request
  }
}

/** `fn()` once per request per `key`; a rejection is not memoized. */
export async function requestMemo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const scope = await requestScope();
  if (!scope) return fn();
  let memo = scopes.get(scope);
  if (!memo) {
    memo = new Map();
    scopes.set(scope, memo);
  }
  const hit = memo.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = fn();
  memo.set(key, p);
  p.catch(() => memo.delete(key));
  return p;
}
