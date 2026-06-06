import { describe, it, expect } from "vitest";
import {
  readJsonBody,
  isMoneyCents,
  isClientId,
  isEmail,
  isNonEmptyString,
  MAX_BODY_BYTES,
} from "./validate";

function jsonReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://pos.example/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("readJsonBody", () => {
  it("parses valid JSON", async () => {
    const r = await readJsonBody(jsonReq('{"a":1}'));
    expect(r).toEqual({ ok: true, body: { a: 1 } });
  });

  it("rejects invalid JSON with 400", async () => {
    const r = await readJsonBody(jsonReq("{not json"));
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects an empty body with 400", async () => {
    const r = await readJsonBody(jsonReq("   "));
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects via Content-Length when oversized (413, cheap path)", async () => {
    const r = await readJsonBody(
      jsonReq("{}", { "content-length": String(MAX_BODY_BYTES + 1) }),
    );
    expect(r).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects an actually-oversized decoded body (413)", async () => {
    const big = JSON.stringify({ x: "a".repeat(MAX_BODY_BYTES) });
    // Omit content-length so the decoded re-check is what trips.
    const req = new Request("https://pos.example/api/x", {
      method: "POST",
      body: big,
    });
    const r = await readJsonBody(req);
    expect(r).toMatchObject({ ok: false, status: 413 });
  });
});

describe("scalar guards", () => {
  it("isMoneyCents accepts non-negative integers only", () => {
    expect(isMoneyCents(0)).toBe(true);
    expect(isMoneyCents(1500)).toBe(true);
    expect(isMoneyCents(-1)).toBe(false);
    expect(isMoneyCents(1.5)).toBe(false);
    expect(isMoneyCents(NaN)).toBe(false);
    expect(isMoneyCents("100")).toBe(false);
    expect(isMoneyCents(1e12)).toBe(false); // beyond max
  });

  it("isClientId enforces a bounded allowlisted charset", () => {
    expect(isClientId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isClientId("abc_DEF-123")).toBe(true);
    expect(isClientId("short")).toBe(false); // < 8
    expect(isClientId("has space chars")).toBe(false);
    expect(isClientId("inject'); drop")).toBe(false);
    expect(isClientId(123 as unknown)).toBe(false);
  });

  it("isEmail accepts plausible emails, rejects junk + overlong", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("nope")).toBe(false);
    expect(isEmail("a@b")).toBe(false);
    expect(isEmail(`${"a".repeat(255)}@b.co`)).toBe(false);
  });

  it("isNonEmptyString respects bounds", () => {
    expect(isNonEmptyString("x")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString("y".repeat(2000), 1024)).toBe(false);
  });
});
