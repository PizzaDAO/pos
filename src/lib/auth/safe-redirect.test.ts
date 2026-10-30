import { describe, expect, it, vi } from "vitest";

/**
 * Open redirects: sign-in, the magic-link callback and sign-out all share
 * safeRedirectPath — same-origin internal paths only.
 */
vi.mock("@/lib/auth/supabase-server", () => ({
  getServerSupabase: vi.fn(async () => null),
  isSupabaseAuthConfigured: () => false,
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(async () => null),
}));

import { isSafeRedirectPath, safeRedirectPath } from "./safe-redirect";
import { GET as callbackGET } from "@/app/auth/callback/route";
import { POST as signoutPOST } from "@/app/auth/signout/route";

const UNSAFE = [
  "https://evil.example",
  "//evil.example",
  "//evil.example/admin",
  "/\\evil.example",
  "\\\\evil.example",
  "/\t/evil.example",
  "/\n/evil.example",
  "/\r\n/evil.example",
  "/admin\u0000",
  "javascript:alert(1)",
  "admin",
  "",
  " /admin",
];

describe("safeRedirectPath", () => {
  it("keeps same-origin internal paths (with query + hash)", () => {
    for (const ok of ["/admin", "/terminal?location=x", "/shop/a/b#menu", "/"]) {
      expect(isSafeRedirectPath(ok, "https://pos.example")).toBe(true);
      expect(safeRedirectPath(ok, "/fallback")).toBe(ok);
    }
  });

  it("rejects off-origin, protocol-relative, backslash and control-char values", () => {
    for (const bad of UNSAFE) {
      expect(isSafeRedirectPath(bad, "https://pos.example")).toBe(false);
      expect(safeRedirectPath(bad, "/fallback")).toBe("/fallback");
    }
    expect(safeRedirectPath(null, "/f")).toBe("/f");
    expect(safeRedirectPath(undefined, "/f")).toBe("/f");
  });
});

describe("auth routes use it", () => {
  it("/auth/callback never redirects off-origin", async () => {
    for (const bad of UNSAFE) {
      const res = await callbackGET(
        new Request(
          `https://pos.example/auth/callback?redirect=${encodeURIComponent(bad)}`,
        ),
      );
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin).toBe("https://pos.example");
      expect(loc.pathname).toBe("/admin");
    }
    const ok = await callbackGET(
      new Request("https://pos.example/auth/callback?redirect=%2Fterminal%3Fx%3D1"),
    );
    expect(ok.headers.get("location")).toBe("https://pos.example/terminal?x=1");
  });

  it("/auth/signout never redirects off-origin", async () => {
    for (const bad of UNSAFE) {
      const res = await signoutPOST(
        new Request(
          `https://pos.example/auth/signout?redirect=${encodeURIComponent(bad)}`,
          { method: "POST" },
        ),
      );
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin).toBe("https://pos.example");
      expect(loc.pathname).toBe("/login");
    }
  });
});
