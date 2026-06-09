import type { Metadata, Viewport } from "next"
import { Roboto } from "next/font/google"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"

const roboto = Roboto({
  variable: "--font-sans",
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "700"],
})

export const metadata: Metadata = {
  title: "Circa Tasks",
  description: "Internal task operation platform",
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#F26520',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" suppressHydrationWarning className={`${roboto.variable} h-full antialiased`}>
      <head>
        {/*
          Kill any lingering service worker from the old PWA build. The app no
          longer registers a SW, but devices that installed the old one can stay
          controlled by it — intercepting navigations (cache-only misses surface
          as "Resource was not cached") and serving stale assets, which can strand
          users on /login after a successful sign-in. /sw.js self-unregisters, but
          only after the browser's SW update cycle; this page-level cleanup runs on
          every load and is a no-op once no SW/caches remain.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister()})}).catch(function(){});}if(window.caches&&caches.keys){caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k)})}).catch(function(){});}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-full">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  )
}
