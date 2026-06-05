/**
 * Registers the Serwist-generated service worker (`/sw.js`) on the client.
 *
 * Only mounted on the terminal surface. No-op in dev (Serwist disables SW
 * generation there) and where service workers are unsupported. Failures are
 * swallowed — the terminal still works without the SW, just without offline
 * shell caching.
 */
"use client";

import { useEffect } from "react";

export function RegisterServiceWorker() {
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      process.env.NODE_ENV !== "production"
    ) {
      return;
    }
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Ignore registration errors; app remains functional online.
      });
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => window.removeEventListener("load", onLoad);
  }, []);

  return null;
}
