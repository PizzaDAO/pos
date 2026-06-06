import type { MetadataRoute } from "next";

/**
 * robots.txt — only the public marketing/storefront surfaces are crawlable.
 * Operational app surfaces (terminal, kitchen, admin, platform) and all API +
 * auth routes are disallowed; individual app pages also emit `noindex` via their
 * route metadata as a second layer. Static (no env reads beyond the optional
 * site URL) so the zero-env build is unaffected.
 */
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://pizzeria-pos.vercel.app");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/shop/"],
      disallow: [
        "/terminal",
        "/kitchen",
        "/admin",
        "/platform",
        "/signup",
        "/login",
        "/api/",
        "/auth/",
        "/forbidden",
      ],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
