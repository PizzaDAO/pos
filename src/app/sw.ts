/**
 * Service worker (Serwist) for the terminal PWA.
 *
 * - Precaches the Next.js app shell (build manifest injected at `self.__SW_MANIFEST`).
 * - Runtime-caches the menu API (`/api/menu`) with StaleWhileRevalidate so the
 *   terminal can load the menu offline after the first online load.
 * - Payment / card-reader APIs (`/api/terminal/*`, `/api/payments*`,
 *   `/api/admin/terminal*`) and Stripe origins are NetworkOnly: payment state is
 *   never served from a cache, and card needs internet (see sw-routes.ts).
 * - Order writes (`/api/orders`) are deliberately NOT cached here — durability is
 *   handled by the Dexie offline queue + idempotent upsert, not by the SW.
 *
 * Built only for production; `@serwist/next` disables it in dev.
 */
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist, StaleWhileRevalidate } from "serwist";
import { isNetworkOnlyPath, isStripeOrigin } from "@/lib/offline/sw-routes";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // Keep the menu available offline; revalidate in the background.
      matcher: ({ url }) => url.pathname === "/api/menu",
      handler: new StaleWhileRevalidate({ cacheName: "pos-menu" }),
    },
    // Payment + card-reader state must never come from a cache (defaultCache
    // would put same-origin GET /api/* behind NetworkFirst and answer a failed
    // poll with a stale status). These rules MUST stay before `defaultCache`.
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && isNetworkOnlyPath(url.pathname),
      handler: new NetworkOnly(),
    },
    // Stripe's scripts/API must load live (and never be cached cross-origin).
    {
      matcher: ({ url, sameOrigin }) => !sameOrigin && isStripeOrigin(url.hostname),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
  // When a navigation can't be served from network or precache (true offline,
  // uncached route), fall back to the precached /offline shell instead of the
  // browser's default error page. The terminal's own offline-first flow is
  // unaffected — it serves from precache/IndexedDB before this ever triggers.
  fallbacks: {
    entries: [
      {
        url: "/offline",
        matcher: ({ request }) => request.mode === "navigate",
      },
    ],
  },
});

serwist.addEventListeners();
