'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { QrCode, ExternalLink } from 'lucide-react'

// P3-H (stakeholder 24/07) — QR Affiliate của store trên landing /targets:
// khách quét → đặt hàng Circa Online → đơn gắn partner code của store (GMV
// affiliate ghi nhận đúng store). Ảnh tĩnh public GCS: loading=lazy + cache
// immutable, KHÔNG proxy qua Next.js, KHÔNG gọi Mongo. Parent quyết định khi
// nào render (flag KPI_AFFILIATE_ENABLED bật + landing, ẩn trong ?campaign=).
// Thiếu mapping → trạng thái gọn, không render ảnh vỡ.

export function AffiliateQrCard({ storeName, partnerCode, imageUrl, destinationUrl }: {
  storeName: string
  partnerCode: string | null
  imageUrl: string | null
  destinationUrl: string | null
}) {
  const [open, setOpen] = useState(false)

  return (
    <Card className="rounded-lg">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-semibold text-sm">
            <QrCode className="h-4 w-4 text-primary" /> Mã QR Circa Online
          </p>
          {destinationUrl && (
            <a
              href={destinationUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Mở Circa Online"
              className="inline-flex items-center justify-center h-[44px] w-[44px] md:h-8 md:w-8 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>

        {!imageUrl ? (
          <p className="text-sm text-muted-foreground">Chưa cấu hình mã QR cho cửa hàng.</p>
        ) : (
          <>
            <div className="flex flex-col items-center gap-2">
              {/* Nền TRẮNG cố định + quiet zone nguyên bản (kể cả dark mode) để
                  máy khác quét ổn định. Chạm → modal phóng lớn. */}
              <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label="Phóng to mã QR"
                className="rounded-lg border bg-white p-2 active:opacity-80"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt={`Mã QR Affiliate ${storeName}`}
                  loading="lazy"
                  className="h-[220px] w-[220px] sm:h-[240px] sm:w-[240px] object-contain"
                />
              </button>
              <p className="text-xs text-muted-foreground text-center">
                {storeName}{partnerCode ? <> · <span className="font-mono">{partnerCode}</span></> : null}
              </p>
              <p className="text-xs text-muted-foreground text-center max-w-[300px]">
                Khách quét mã để đặt hàng trên Circa Online — doanh số ghi nhận cho cửa hàng theo mã đối tác.
              </p>
            </div>

            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent className="w-fit">
                <DialogTitle className="text-sm pr-8">Mã QR Circa Online · {storeName}</DialogTitle>
                <div className="mx-auto rounded-lg border bg-white p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageUrl}
                    alt={`Mã QR Affiliate ${storeName}`}
                    className="w-[300px] sm:w-[320px] max-w-full aspect-square object-contain"
                  />
                </div>
              </DialogContent>
            </Dialog>
          </>
        )}
      </CardContent>
    </Card>
  )
}
