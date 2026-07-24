'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { QrCode, ExternalLink } from 'lucide-react'
import { qrCardState, urlStateActive } from '@/lib/affiliate/qrDisplay'

// P3-H r1 (stakeholder 24/07) — QR Affiliate của store trên landing /targets:
// khách quét → đặt hàng Circa Online → đơn gắn partner code của store (GMV
// affiliate ghi nhận đúng store). Ảnh tĩnh public GCS: loading=lazy + cache
// immutable, KHÔNG proxy qua Next.js, KHÔNG gọi Mongo. Parent quyết định khi
// nào render (qrCardVisible — flag + role + landing). 3 trạng thái phân biệt
// (audit P2 #3): lỗi query DB → "Không tải được"; thiếu mapping → "Chưa cấu
// hình"; có QR → ảnh (kèm onError → không bao giờ hiện broken image).

export function AffiliateQrCard({ storeName, partnerCode, imageUrl, destinationUrl, queryError = false }: {
  storeName: string
  partnerCode: string | null
  imageUrl: string | null
  destinationUrl: string | null
  queryError?: boolean
}) {
  // r1.2 (audit P2 vòng A→B→A): parent gắn key={qrCardKey(storeId, imageUrl)}
  // — đổi store/ảnh ⇒ REMOUNT instance mới, state sạch + browser retry ảnh;
  // quay lại store cũ cũng là instance mới (React không giữ state qua unmount).
  // urlStateActive (r1.1) giữ làm phòng thủ trong đời một instance.
  const [openUrl, setOpenUrl] = useState<string | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const open = urlStateActive(openUrl, imageUrl)
  const imgFailed = urlStateActive(failedUrl, imageUrl)
  const state = qrCardState(queryError, imageUrl ? { qr_image_url: imageUrl } : null)

  return (
    <Card className="rounded-lg">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-semibold text-sm">
            <QrCode className="h-4 w-4 text-primary" /> Mã QR Circa Online
          </p>
          {state === 'qr' && destinationUrl && (
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

        {state === 'error' ? (
          <p className="text-sm text-muted-foreground">Không tải được mã QR. Vui lòng thử lại sau hoặc báo Admin.</p>
        ) : state === 'missing' ? (
          <p className="text-sm text-muted-foreground">Chưa cấu hình mã QR cho cửa hàng.</p>
        ) : imgFailed ? (
          // Ảnh GCS lỗi (mạng/object) — không bao giờ hiện broken image.
          <p className="text-sm text-muted-foreground">Không tải được ảnh mã QR. Vui lòng thử lại sau.</p>
        ) : (
          <>
            <div className="flex flex-col items-center gap-2">
              {/* Nền TRẮNG cố định + quiet zone nguyên bản (kể cả dark mode) để
                  máy khác quét ổn định. Chạm → modal phóng lớn. */}
              <button
                type="button"
                onClick={() => setOpenUrl(imageUrl)}
                aria-label="Phóng to mã QR"
                className="rounded-lg border bg-white p-2 active:opacity-80"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl!}
                  alt={`Mã QR Affiliate ${storeName}`}
                  loading="lazy"
                  onError={() => setFailedUrl(imageUrl)}
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

            {/* r1 (audit P2 #5): modal bo theo viewport — không sát/tràn 360px */}
            <Dialog open={open} onOpenChange={(o) => setOpenUrl(o ? imageUrl : null)}>
              <DialogContent className="w-[calc(100vw-2rem)] max-w-sm">
                <DialogTitle className="text-sm pr-8">Mã QR Circa Online · {storeName}</DialogTitle>
                <div className="mx-auto w-full max-w-[320px] rounded-lg border bg-white p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageUrl!}
                    alt={`Mã QR Affiliate ${storeName}`}
                    onError={() => setFailedUrl(imageUrl)}
                    className="w-full aspect-square object-contain"
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
