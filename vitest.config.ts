import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest config (Phase 7 hardening).
 *
 * Runs the pure-logic + mock-driver test suite in a Node environment with ZERO
 * env vars required — mirrors CI and the env-free build invariant. The `@`
 * alias matches tsconfig's `paths` so tests import domain modules the same way
 * the app does.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Keep mock driver module-level state from leaking across files.
    isolate: true,
    globals: false,
  },
});
