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
    ]
  },
};

export default nextConfig;
