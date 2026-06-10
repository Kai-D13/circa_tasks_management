import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
      // New production self-host domain
      {
        protocol: 'https',
        hostname: 'database-duocsi.circa.vn',
        pathname: '/storage/v1/object/public/**',
      },
      // Keep old domain during transition — existing DB rows may contain URLs
      // pointing at database.hao-nguyen.site. Remove once all rows are migrated.
      {
        protocol: 'https',
        hostname: 'database.hao-nguyen.site',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },
  // /documents → the static usage-guide HTML in /public. Array-form rewrites run
  // after the filesystem check, and /documents has no page, so this serves
  // public/documents.html directly — no React tree, no Supabase queries.
  // (proxy.ts exempts the path from the auth gate.)
  async rewrites() {
    return [
      { source: '/documents', destination: '/documents.html' },
    ]
  },
  // Never cache the service worker so a redeployed sw.js is picked up immediately.
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
      // The static usage guide: cache for an hour (it changes only on redeploy),
      // keeping repeat visits free for the server without pinning stale docs.
      {
        source: '/documents',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=3600' },
        ],
      },
      // Never let a shared cache (e.g. Cloudflare) store /login. The page embeds a
      // per-deploy Server Action ID; serving stale cached HTML after a redeploy
      // makes the login POST resolve to a missing action → 500. force-dynamic on
      // the page already does this, but pin the header so no CDN overrides it.
      {
        source: '/login',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ]
  },
};

export default nextConfig;
