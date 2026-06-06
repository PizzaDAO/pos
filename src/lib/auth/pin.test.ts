import { describe, expect, it } from "vitest";
import { hashPin, isValidPinFormat, verifyPin } from "./pin";

describe("staff PIN hashing", () => {
  it("hashes to the scrypt$salt$hash format and round-trips", () => {
    const hash = hashPin("1234");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash.split("$")).toHaveLength(3);
    expect(verifyPin("1234", hash)).toBe(true);
  });

  it("rejects a wrong PIN", () => {
    const hash = hashPin("4321");
    expect(verifyPin("1234", hash)).toBe(false);
  });

  it("uses a random salt (two hashes of the same PIN differ)", () => {
    expect(hashPin("0000")).not.toEqual(hashPin("0000"));
  });

  it("returns false for null/empty/malformed stored hashes", () => {
    expect(verifyPin("1234", null)).toBe(false);
    expect(verifyPin("1234", undefined)).toBe(false);
    expect(verifyPin("1234", "")).toBe(false);
    expect(verifyPin("1234", "notscrypt$aa$bb")).toBe(false);
    expect(verifyPin("1234", "scrypt$zz$zz")).toBe(false);
  });

  it("verifies the deterministic seed PIN hashes", () => {
    // Mirrors src/lib/db/seed-data.ts (Christopher 3333).
    const christopher =
      "scrypt$f9711be6a1ca88216fb953d6de599969$c5bf37206b720347db1f626994a4388d55f5816c7bf92530d884db139f11cceb";
    expect(verifyPin("3333", christopher)).toBe(true);
    expect(verifyPin("0000", christopher)).toBe(false);
  });

  it("enforces a 4-8 digit PIN format", () => {
    expect(isValidPinFormat("1234")).toBe(true);
    expect(isValidPinFormat("12345678")).toBe(true);
    expect(isValidPinFormat("123")).toBe(false);
    expect(isValidPinFormat("123456789")).toBe(false);
    expect(isValidPinFormat("12ab")).toBe(false);
    expect(isValidPinFormat(1234 as unknown)).toBe(false);
  });
});
