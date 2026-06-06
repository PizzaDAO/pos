import type { MetadataRoute } from "next";
import { locations } from "@/lib/db/seed-data";

/**
 * Sitemap of publicly-indexable surfaces: the marketing home page and each
 * public storefront (`/shop/{slug}`). Operational app surfaces are excluded
 * (also `noindex` + disallowed in robots). Slugs come from the seed location
 * list at build time — no DB call, so the zero-env build is unaffected.
 */
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://pizzeria-pos.vercel.app");

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const storefronts: MetadataRoute.Sitemap = locations.map((loc) => ({
    url: `${siteUrl}/shop/${loc.slug}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.8,
  }));

  return [
    {
      url: siteUrl,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    ...storefronts,
  ];
}
