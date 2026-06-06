import type { MetadataRoute } from "next";

/**
 * Web app manifest — makes the terminal installable as a PWA. Served at
 * `/manifest.webmanifest`. Standalone display + tablet-first; the terminal is
 * the primary install target.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/terminal",
    name: "Pizzeria POS Terminal",
    short_name: "POS Terminal",
    description:
      "Tablet-first, offline-first point-of-sale terminal for pizzerias.",
    lang: "en",
    dir: "ltr",
    categories: ["business", "food", "productivity"],
    start_url: "/terminal",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#dc2626",
    screenshots: [
      {
        src: "/screenshots/terminal-wide.png",
        sizes: "1280x800",
        type: "image/png",
        form_factor: "wide",
        label: "Counter terminal — offline-first ordering",
      },
      {
        src: "/screenshots/shop-narrow.png",
        sizes: "720x1280",
        type: "image/png",
        form_factor: "narrow",
        label: "Customer online ordering storefront",
      },
    ],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
