/**
 * The auth path's request-scoped memo: one resolution per request (cookie
 * store), nothing shared across requests, failures not cached, and a plain
 * pass-through in simulated mode or outside a request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ current: {} as object | null }));
vi.mock("next/headers", () => ({
  cookies: async () => {
    if (!store.current) throw new Error("outside a request scope");
    return store.current;
  },
}));

import { requestMemo } from "./request-memo";

const URL_KEY = "NEXT_PUBLIC_SUPABASE_URL";
const ANON_KEY = "NEXT_PUBLIC_SUPABASE_ANON_KEY";
function realAuth() {
  process.env[URL_KEY] = "https://example.supabase.co";
  process.env[ANON_KEY] = "anon";
}
afterEach(() => {
  delete process.env[URL_KEY];
  delete process.env[ANON_KEY];
  store.current = {};
});

describe("requestMemo", () => {
  it("resolves once per request and key", async () => {
    realAuth();
    const fn = vi.fn(async () => ({ id: "u" }));
    const a = await requestMemo("user", fn);
    const b = await requestMemo("user", fn);
    expect(a).toBe(b);
    expect(fn).toHaveBeenCalledTimes(1);
    await requestMemo("other", fn);
    expect(fn).toHaveBeenCalledTimes(2);

    store.current = {}; // the next request
    await requestMemo("user", fn);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not cache a failure", async () => {
    realAuth();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("GoTrue down"))
      .mockResolvedValue("ok");
    await expect(requestMemo("user", fn)).rejects.toThrow(/GoTrue/);
    await expect(requestMemo("user", fn)).resolves.toBe("ok");
  });

  it("passes through in simulated mode and outside a request", async () => {
    const fn = vi.fn(async () => 1);
    await requestMemo("user", fn);
    await requestMemo("user", fn);
    expect(fn).toHaveBeenCalledTimes(2);
    realAuth();
    store.current = null;
    await requestMemo("user", fn);
    await requestMemo("user", fn);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
