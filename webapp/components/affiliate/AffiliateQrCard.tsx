'use client'

import { useEffect, useId, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { QrCode, ExternalLink, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { qrCardState, qrImageMounted, qrToggleState, urlStateActive } from '@/lib/affiliate/qrDisplay'

// P3-H r1 (stakeholder 24/07) — QR Affiliate của store trên landing /targets:
// khách quét → đặt hàng Circa Online → đơn gắn partner code của store (GMV
// affiliate ghi nhận đúng store). Ảnh tĩnh public GCS: loading=lazy + cache
// immutable, KHÔNG proxy qua Next.js, KHÔNG gọi Mongo. Parent quyết định khi
// nào render (qrCardVisible — flag + role + landing). 3 trạng thái phân biệt
// (audit P2 #3): lỗi query DB → "Không tải được"; thiếu mapping → "Chưa cấu
// hình"; có QR → ảnh (kèm onError → không bao giờ hiện broken image).
//
// Step 3.1 — DISCLOSURE COMPACT DƯỚI md: ảnh 220–240px chiếm gần trọn first
// viewport ở 360px và đẩy danh sách chiến dịch xuống dưới màn. Dưới md chỉ hiện
// một hàng compact; ảnh CHỈ MOUNT sau khi mở (không phải ẩn bằng CSS — xem
// qrImageMounted). Từ md trở lên giữ nguyên hình thức đã duyệt.

const DESKTOP_MQ = '(min-width: 768px)'

// Breakpoint phải là quyết định JS chứ không thể là class CSS: yêu cầu là ảnh
// KHÔNG NẰM TRONG DOM khi đóng, mà `hidden md:block` vẫn để nguyên nó trong DOM.
// Đánh đổi: server render = false (mobile-first) nên trên desktop ảnh xuất hiện
// sau khi hydrate — một frame trống. Chấp nhận thay vì đặt min-height đoán số:
// đoán sai là đẻ khoảng trắng chết trên desktop, tức đổi đúng thứ đã duyệt.
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ)
    const sync = () => setIsDesktop(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return isDesktop
}

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
  const [expanded, setExpanded] = useState(false)
  const isDesktop = useIsDesktop()
  const panelId = useId()

  const open = urlStateActive(openUrl, imageUrl)
  const imgFailed = urlStateActive(failedUrl, imageUrl)
  const state = qrCardState(queryError, imageUrl ? { qr_image_url: imageUrl } : null)
  const showImage = qrImageMounted({ isDesktop, expanded })

  // Thu gọn phải đóng luôn modal đang mở — nếu không, ảnh phóng to vẫn nằm đè
  // màn hình trong khi hàng compact đã báo là "đã đóng".
  //
  // ⚠ KHÔNG gọi setOpenUrl BÊN TRONG updater của setExpanded: updater phải
  // THUẦN, React được phép gọi lại nó (StrictMode) hoặc hoãn, nên setState lồng
  // trong đó không đảm bảo chạy — modal ở lại trong khi panel đã đóng. Bản đầu
  // của Step 3.1 viết đúng kiểu đó và test phòng thủ bắt được.
  function toggle() {
    const s = qrToggleState({ expanded })
    setExpanded(s.expanded)
    if (s.closeModal) setOpenUrl(null)
  }

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
          // Hai trạng thái này hiện NGAY ở mọi bề ngang — người dùng cần biết
          // liền, không bắt mở disclosure mới thấy có chuyện.
          <p className="text-sm text-muted-foreground">Không tải được mã QR. Vui lòng thử lại sau hoặc báo Admin.</p>
        ) : state === 'missing' ? (
          <p className="text-sm text-muted-foreground">Chưa cấu hình mã QR cho cửa hàng.</p>
        ) : imgFailed ? (
          // Ảnh GCS lỗi (mạng/object) — không bao giờ hiện broken image.
          <p className="text-sm text-muted-foreground">Không tải được ảnh mã QR. Vui lòng thử lại sau.</p>
        ) : (
          <>
            {/* Hàng compact — CHỈ dưới md. Cả hàng là vùng chạm 44px. */}
            <button
              type="button"
              onClick={toggle}
              aria-expanded={expanded}
              aria-controls={panelId}
              className="md:hidden flex w-full items-center gap-2.5 min-h-[44px] rounded-lg px-1 text-left transition-colors active:bg-muted/50"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <QrCode className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{storeName}</span>
                {partnerCode && <span className="block truncate font-mono text-xs text-muted-foreground">{partnerCode}</span>}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                {expanded ? 'Thu gọn' : 'Xem mã'}
                <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
              </span>
            </button>

            <div id={panelId} className={cn(!showImage && 'hidden')}>
              {showImage && (
                <div className="flex flex-col items-center gap-2">
                  {/* Nền TRẮNG cố định + quiet zone nguyên bản (kể cả dark mode)
                      để máy khác quét ổn định. Chạm → modal phóng lớn. */}
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
                  {/* Tên store đã nằm ở hàng compact trên mobile ⇒ dòng này chỉ
                      còn cần cho desktop, tránh lặp hai lần cùng một thông tin. */}
                  <p className="hidden md:block text-xs text-muted-foreground text-center">
                    {storeName}{partnerCode ? <> · <span className="font-mono">{partnerCode}</span></> : null}
                  </p>
                  <p className="text-xs text-muted-foreground text-center max-w-[300px]">
                    Khách quét mã để đặt hàng trên Circa Online — doanh số ghi nhận cho cửa hàng theo mã đối tác.
                  </p>
                </div>
              )}
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
