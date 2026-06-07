import type { MetadataRoute } from 'next'

// Web App Manifest (file-based metadata). Next serves this at /manifest.webmanifest
// and injects <link rel="manifest"> automatically. Minimal PWA: installable home-
// screen shortcut, standalone display, NO offline/caching behavior.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             'Circa Tasks',
    short_name:       'Circa',
    description:      'Quản lý công việc nội bộ Circa',
    id:               '/',
    start_url:        '/',
    scope:            '/',
    display:          'standalone',
    orientation:      'portrait',
    background_color: '#ffffff',
    theme_color:      '#F26520', // Circa brand orange (globals.css --primary)
    icons: [
      { src: '/icons/icon-192.png',          sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png',          sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
