import { afterEach, describe, expect, it, vi } from "vitest";

const real = vi.hoisted(() => ({ mode: false }));
vi.mock("@/lib/auth/signing-secret", () => ({ isRealMode: () => real.mode }));

import {
  CODE_ALPHABET,
  GiftCardsUnavailableError,
  codeLast4,
  codePepper,
  deriveCode,
  formatCode,
  generateCode,
  hashCode,
  normalizeCode,
  sameHash,
} from "./codes";
import { giftCardsEnabled } from "./limits";

const T1 = "10000000-0000-0000-0000-000000000001";
const T2 = "10000000-0000-0000-0000-000000000002";
const PEPPER = "p".repeat(40);

afterEach(() => {
  real.mode = false;
  vi.unstubAllEnvs();
});

describe("generated codes", () => {
  it("are 16 Crockford characters (80 bits) and do not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const c = generateCode();
      expect(c).toHaveLength(16);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
      seen.add(c);
    }
    expect(seen.size).toBe(2000);
    expect(CODE_ALPHABET).toHaveLength(32);
    expect(CODE_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it("use every symbol roughly evenly (no modulo bias)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i += 1) {
      for (const ch of generateCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const expected = (4000 * 16) / 32; // 2000
    for (const ch of CODE_ALPHABET) {
      expect(counts.get(ch)).toBeGreaterThan(expected * 0.85);
      expect(counts.get(ch)).toBeLessThan(expected * 1.15);
    }
  });

  it("format in groups of four and keep a 4-character suffix", () => {
    expect(formatCode("ABCDEFGHJKMNPQRS")).toBe("ABCD-EFGH-JKMN-PQRS");
    expect(codeLast4("ABCDEFGHJKMNPQRS")).toBe("PQRS");
  });
});

describe("normalizeCode", () => {
  it("ignores case, spaces and dashes and maps look-alikes", () => {
    expect(normalizeCode(" abcd-efgh jkmn-pqrs ")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeCode("O0IL-1111-2222-3333")).toBe("0011111122223333");
  });
  it("rejects anything that is not 12-32 letters/digits", () => {
    for (const bad of ["", "SHORT", "12345678901", "A".repeat(33), "ABCD$EFGH1234", null, 42, "x".repeat(100)]) {
      expect(normalizeCode(bad)).toBeNull();
    }
    expect(normalizeCode("6000 1234 5678")).toBe("600012345678");
  });
});

describe("hashing", () => {
  it("is peppered and tenant-scoped, and never contains the code", () => {
    const code = "ABCDEFGHJKMNPQRS";
    const h = hashCode(T1, code, PEPPER);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(code.toLowerCase());
    expect(hashCode(T1, code, PEPPER)).toBe(h);
    expect(hashCode(T2, code, PEPPER)).not.toBe(h);
    expect(hashCode(T1, code, "q".repeat(40))).not.toBe(h);
    expect(sameHash(h, hashCode(T1, code, PEPPER))).toBe(true);
    expect(sameHash(h, hashCode(T2, code, PEPPER))).toBe(false);
    expect(sameHash(h, "")).toBe(false);
  });

  it("derives a stable online code per account under the pepper", () => {
    const a = deriveCode("acct-1", PEPPER);
    expect(a).toHaveLength(16);
    expect(deriveCode("acct-1", PEPPER)).toBe(a);
    expect(deriveCode("acct-2", PEPPER)).not.toBe(a);
    expect(deriveCode("acct-1", "q".repeat(40))).not.toBe(a);
  });
});

describe("pepper + feature gate (fail closed)", () => {
  it("demo mode falls back to a per-process pepper and is enabled", () => {
    expect(codePepper()).toMatch(/^[0-9a-f]{64}$/);
    expect(giftCardsEnabled()).toBe(true);
  });

  it("real mode without a pepper refuses every code operation", () => {
    real.mode = true;
    vi.stubEnv("GIFT_CARD_CODE_PEPPER", "");
    vi.stubEnv("GIFT_CARDS_ENABLED", "1");
    expect(codePepper()).toBeNull();
    expect(giftCardsEnabled()).toBe(false);
    expect(() => hashCode(T1, "ABCDEFGHJKMN")).toThrow(GiftCardsUnavailableError);
    expect(() => deriveCode("acct")).toThrow(GiftCardsUnavailableError);
  });

  it("real mode needs both the pepper (>= 32 chars) and GIFT_CARDS_ENABLED=1", () => {
    real.mode = true;
    vi.stubEnv("GIFT_CARD_CODE_PEPPER", "short");
    vi.stubEnv("GIFT_CARDS_ENABLED", "1");
    expect(giftCardsEnabled()).toBe(false);
    vi.stubEnv("GIFT_CARD_CODE_PEPPER", PEPPER);
    vi.stubEnv("GIFT_CARDS_ENABLED", "");
    expect(giftCardsEnabled()).toBe(false);
    vi.stubEnv("GIFT_CARDS_ENABLED", "1");
    expect(giftCardsEnabled()).toBe(true);
    expect(codePepper()).toBe(PEPPER);
  });
});
