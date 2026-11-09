/**
 * The "recent sign-in" time read from a Supabase access token: only real
 * sign-in `amr` entries count; `token_refresh` (and unknown methods) never do.
 */
import { describe, expect, it } from "vitest";
import { authTimeFromAccessToken } from "./session";

const jwt = (payload: unknown) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

describe("authTimeFromAccessToken", () => {
  it("takes the newest sign-in amr timestamp", () => {
    expect(
      authTimeFromAccessToken(
        jwt({
          amr: [
            { method: "password", timestamp: 1_000 },
            { method: "otp", timestamp: 2_000 },
          ],
        }),
      ),
    ).toBe(2_000_000);
  });

  it("ignores token_refresh and unknown methods", () => {
    expect(
      authTimeFromAccessToken(
        jwt({
          amr: [
            { method: "password", timestamp: 1_000 },
            { method: "token_refresh", timestamp: 9_000 },
            { method: "something_else", timestamp: 9_500 },
          ],
        }),
      ),
    ).toBe(1_000_000);
    expect(
      authTimeFromAccessToken(
        jwt({ amr: [{ method: "token_refresh", timestamp: 9_000 }] }),
      ),
    ).toBeNull();
  });

  it("null for a missing, malformed or amr-less token", () => {
    expect(authTimeFromAccessToken(null)).toBeNull();
    expect(authTimeFromAccessToken("garbage")).toBeNull();
    expect(authTimeFromAccessToken("a.!!!.c")).toBeNull();
    expect(authTimeFromAccessToken(jwt({ sub: "x" }))).toBeNull();
    expect(
      authTimeFromAccessToken(jwt({ amr: [{ method: "password" }] })),
    ).toBeNull();
  });
});
