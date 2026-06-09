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
