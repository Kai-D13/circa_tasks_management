'use client'

import { useState } from 'react'
import { ImageOff } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { careSafeImageUrl } from '@/lib/care/browse'

// Sản phẩm của task (từ file import hiện hành — SPEC B3 §2). Ảnh CDN chỉ tải khi
// cuộn tới (loading="lazy"), khung cố định; chạm để xem lớn. Không phải lịch sử mua.
// URL ngoài CDN đã chốt ⇒ coi như không có ảnh (chốt thứ hai sau CHECK 114); no-referrer.
export interface CareProductView { id: string; product_id: string; product_name: string; image_url: string | null; reason_type: string; reason_text: string }

export function CareProductGallery({ products }: { products: CareProductView[] }) {
  const [zoom, setZoom] = useState<CareProductView | null>(null)
  return (
    <>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {products.map((p) => { const src = careSafeImageUrl(p.image_url); return (
          <li key={p.id} className="flex gap-3 rounded-lg border bg-card p-3">
            {src ? (
              <button type="button" onClick={() => setZoom(p)} aria-label={`Xem ảnh lớn ${p.product_name}`}
                className="size-16 shrink-0 overflow-hidden rounded border bg-muted min-h-[44px]">
                {/* eslint-disable-next-line @next/next/no-img-element -- ảnh CDN ngoài next/image remotePatterns */}
                <img src={src} alt={p.product_name} loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" />
              </button>
            ) : (
              <div className="flex size-16 shrink-0 items-center justify-center rounded border bg-muted text-muted-foreground" aria-label="Không có ảnh">
                <ImageOff className="size-5" />
              </div>
            )}
            <div className="min-w-0 space-y-1 text-sm">
              <p className="line-clamp-2 font-medium" title={p.product_name}>{p.product_name}</p>
              <p className="text-xs text-muted-foreground">{p.product_id} · {p.reason_type}</p>
              <p className="line-clamp-3" title={p.reason_text}>{p.reason_text}</p>
            </div>
          </li>
        ) })}
      </ul>
      <Dialog open={!!zoom} onOpenChange={(o) => { if (!o) setZoom(null) }}>
        <DialogContent className="sm:max-w-xl">
          <DialogTitle className="line-clamp-2">{zoom?.product_name}</DialogTitle>
          {zoom && careSafeImageUrl(zoom.image_url) && (
            // eslint-disable-next-line @next/next/no-img-element -- ảnh CDN ngoài next/image remotePatterns
            <img src={careSafeImageUrl(zoom.image_url)!} alt={zoom.product_name} referrerPolicy="no-referrer" className="max-h-[70vh] w-full rounded object-contain" />
          )}
          <p className="text-sm">{zoom?.reason_text}</p>
        </DialogContent>
      </Dialog>
    </>
  )
}
