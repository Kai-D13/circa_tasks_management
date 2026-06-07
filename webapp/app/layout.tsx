import type { Metadata, Viewport } from "next"
import { Roboto } from "next/font/google"
import { Toaster } from "@/components/ui/sonner"
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister"
import "./globals.css"

const roboto = Roboto({
  variable: "--font-sans",
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "700"],
})

export const metadata: Metadata = {
  title: "Circa Tasks",
  description: "Internal task operation platform",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Circa" },
  icons: { apple: "/apple-touch-icon.png" },
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
      <body className="min-h-full">
        {children}
        <Toaster richColors position="top-center" />
        <ServiceWorkerRegister />
      </body>
    </html>
  )
}
