/**
 * Realtime provider selection + Supabase provider fallback behavior.
 *
 * These run in the env-free Node suite, so they assert the ZERO-env invariant
 * directly: with no Supabase env the selection is the poller; with env set it
 * flips to the Supabase provider. The Supabase provider, having no browser
 * client in Node, transparently falls back to polling per-subscription — which
 * is exactly what lets the build/preview/tests stay green while production gets
 * websocket push. No real network/websocket is opened here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRealtimeProvider,
  resetRealtimeProvider,
  type RealtimeSnapshot,
} from "@/lib/realtime";
import { createSupabaseRealtimeProvider } from "@/lib/realtime/supabase";

const URL_KEY = "NEXT_PUBLIC_SUPABASE_URL";
const ANON_KEY = "NEXT_PUBLIC_SUPABASE_ANON_KEY";

afterEach(() => {
  resetRealtimeProvider();
  delete process.env[URL_KEY];
  delete process.env[ANON_KEY];
  vi.restoreAllMocks();
});

describe("getRealtimeProvider selection", () => {
  it("uses the polling provider when Supabase env is absent (zero-env default)", () => {
    expect(getRealtimeProvider().name).toBe("polling");
  });

  it("uses the Supabase provider when the public Supabase env is present", () => {
    process.env[URL_KEY] = "https://example.supabase.co";
    process.env[ANON_KEY] = "anon-test-key";
    resetRealtimeProvider();
    expect(getRealtimeProvider().name).toBe("supabase");
  });

  it("memoizes the chosen provider across calls", () => {
    const a = getRealtimeProvider();
    const b = getRealtimeProvider();
    expect(a).toBe(b);
  });
});

describe("Supabase provider per-subscription fallback (no browser client)", () => {
  it("does the initial fetch and pushes a realtime-shaped snapshot", async () => {
    // No browser client in Node → the provider falls back to the poller, which
    // still fires the listener once immediately with the fetched payload.
    const provider = createSupabaseRealtimeProvider();
    const fetcher = vi.fn(async () => ({ value: 42 }));
    const snapshots: RealtimeSnapshot<{ value: number }>[] = [];

    const unsubscribe = provider.subscribe(
      "kds:tenant-1:loc-1",
      fetcher,
      (snap) => snapshots.push(snap),
      { intervalMs: 10_000 },
    );

    // Let the immediate tick resolve.
    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0));
    expect(fetcher).toHaveBeenCalled();
    expect(snapshots[0]?.data).toEqual({ value: 42 });
    unsubscribe();
    // Idempotent teardown.
    expect(() => unsubscribe()).not.toThrow();
  });

  it("supports the track:<orderId> topic shape", async () => {
    const provider = createSupabaseRealtimeProvider();
    const fetcher = vi.fn(async () => ({ ok: true }));
    let got: unknown = null;

    const unsubscribe = provider.subscribe(
      "track:order-123",
      fetcher,
      (snap) => {
        got = snap.data;
      },
      { intervalMs: 10_000 },
    );

    await vi.waitFor(() => expect(got).not.toBeNull());
    expect(got).toEqual({ ok: true });
    unsubscribe();
  });
});
