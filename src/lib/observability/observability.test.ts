import { describe, it, expect, afterEach, vi } from "vitest";
import { buildRecord, shouldLog } from "@/lib/observability/logger";
import {
  newRequestId,
  parseTraceparent,
  resolveRequestId,
  REQUEST_ID_HEADER,
} from "@/lib/observability/trace";
import {
  captureError,
  isErrorTrackingConfigured,
  normalizeError,
} from "@/lib/observability/errors";

afterEach(() => {
  delete process.env.LOG_LEVEL;
  delete process.env.SENTRY_DSN;
  vi.restoreAllMocks();
});

describe("structured logger", () => {
  it("builds a JSON-serializable record with level, msg, time, and fields", () => {
    const rec = buildRecord("info", "hello", { orderId: "o1" });
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("hello");
    expect(typeof rec.time).toBe("string");
    expect(rec.orderId).toBe("o1");
    expect(() => JSON.stringify(rec)).not.toThrow();
  });

  it("respects LOG_LEVEL when deciding whether to emit", () => {
    process.env.LOG_LEVEL = "warn";
    expect(shouldLog("info")).toBe(false);
    expect(shouldLog("warn")).toBe(true);
    expect(shouldLog("error")).toBe(true);
  });

  it("defaults to info level with no env set", () => {
    expect(shouldLog("debug")).toBe(false);
    expect(shouldLog("info")).toBe(true);
  });
});

describe("trace ids", () => {
  function headers(map: Record<string, string>) {
    return { get: (n: string) => map[n.toLowerCase()] ?? null };
  }

  it("mints a fresh request id when none is provided", () => {
    const id = resolveRequestId(headers({}));
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("reuses an upstream x-request-id for trace continuity", () => {
    const id = resolveRequestId(headers({ [REQUEST_ID_HEADER]: "abc-123" }));
    expect(id).toBe("abc-123");
  });

  it("derives the trace id from a W3C traceparent header", () => {
    const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    expect(parseTraceparent(tp)).toBe("0af7651916cd43dd8448eb211c80319c");
    const id = resolveRequestId(headers({ traceparent: tp }));
    expect(id).toBe("0af7651916cd43dd8448eb211c80319c");
  });

  it("returns null for a malformed traceparent", () => {
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent(null)).toBeNull();
  });

  it("generates distinct request ids", () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

describe("error-tracking seam", () => {
  it("is a structured-log no-op when SENTRY_DSN is absent", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(isErrorTrackingConfigured()).toBe(false);
    const sink = captureError(new Error("boom"), { scope: "test" });
    expect(sink).toBe("log");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("reports the sentry sink when SENTRY_DSN is configured", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.SENTRY_DSN = "https://example@sentry.io/123";
    expect(isErrorTrackingConfigured()).toBe(true);
    expect(captureError(new Error("boom"))).toBe("sentry");
  });

  it("normalizes Errors and non-Errors", () => {
    expect(normalizeError(new Error("x")).message).toBe("x");
    expect(normalizeError("plain").message).toBe("plain");
    expect(normalizeError({ a: 1 }).message).toBe('{"a":1}');
  });
});
