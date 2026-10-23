import Link from 'next/link'
import { ChevronRight, Receipt } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import {
  CARE_IMPORT_NO_DATA_HINT, careImportCountState, careImportStale, careImportWarnText, carePeriodCloseText, careVnTime, type CareImportOrderState,
} from '@/lib/care/orderLinks/view'
import { cn } from '@/lib/utils'

// E3 — khối "Đơn xác thực sau import" trên /care/reports (thiết kế E0 r3.4 §5, §9). Tách khỏi KPI 114 "Khách có đơn sau
// chăm sóc" (ghi công theo lượt Hoàn thành): ở đây là đơn N3 hoàn tất SAU mốc import của task, đối chiếu bằng mã đơn trên POS.
// Số toàn chuỗi chỉ cho super / care admin (RPC trả `chain` theo quyền); mọi vai còn lại chỉ trạng thái + link danh sách.

const fmt = (n: number) => n.toLocaleString('vi-VN')

export function CareImportOrdersBlock({ state, href, now = new Date() }: { state: CareImportOrderState | 'error' | null; href: string; now?: Date }) {
  // F1 (audit cuối P2 + vòng 2): không đọc được trạng thái (lỗi RPC hoặc RPC trả NULL) ⇒ nói rõ + thử lại, không ẩn im lặng, không
  // số. Cờ UI OFF không tới đây (trang không dựng khối). Q-204: PM 23/10 chấp nhận lời nhắc tải lại.
  if (state === null || state === 'error') {
    return (
      <section aria-labelledby="care-import-orders" data-testid="care-import-orders-block"
        className="flex flex-col gap-2 rounded-care-panel border border-dashed border-care-line p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 id="care-import-orders" className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <Receipt className="size-4 text-muted-foreground" aria-hidden /> Đơn xác thực sau import
            <StatusBadge tone="neutral">Chưa có dữ liệu đơn</StatusBadge>
          </h2>
          <p className="text-xs break-words text-muted-foreground">Không đọc được trạng thái đơn sau import — tải lại trang để thử lại.</p>
        </div>
      </section>
    )
  }
  const close = carePeriodCloseText(state)
  // PM 22/10 P1 "số 0 giả": số toàn chuỗi chỉ hiện khi phạm vi đã được quét (careImportCountState); chưa quét ⇒ chỉ trạng thái.
  // Lượt gần nhất lỗi hoặc quá 24 giờ (kỳ hiện tại) ⇒ "Chưa cập nhật", số (nếu có) là một phần. PM 23/10 P1-1: mốc chỉ là "lượt đồng
  // bộ hoàn tất gần nhất" — lượt sau có thể đã ghi chunk ⇒ không gán số cho mốc ấy.
  const stale = state.isCurrentPeriod && state.hasSynced && !state.lastFailed && careImportStale(state.lastSuccessAt, now)
  const cs = state.chain ? careImportCountState({
    isCurrentPeriod: state.isCurrentPeriod, periodStatus: state.periodStatus, lastSuccessAt: state.hasSynced ? state.lastSuccessAt : null,
    tasks: state.chain.tasks, covered: state.chain.covered, partial: state.lastFailed || stale,
  }) : null
  const none = state.isCurrentPeriod && (!state.hasSynced || cs === 'none')
  return (
    <section aria-labelledby="care-import-orders" data-testid="care-import-orders-block"
      className={cn('flex flex-col gap-2 rounded-care-panel border border-care-line bg-card p-4 md:flex-row md:items-center md:justify-between', none && 'border-dashed bg-transparent')}>
      <div className="min-w-0 space-y-1">
        <h2 id="care-import-orders" className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <Receipt className="size-4 text-muted-foreground" aria-hidden /> Đơn xác thực sau import
          {close ? <StatusBadge tone={close.tone}>{close.label}</StatusBadge>
            : none ? <StatusBadge tone="neutral">Chưa có dữ liệu đơn</StatusBadge>
            : state.lastFailed || stale ? <StatusBadge tone="warning">Chưa cập nhật</StatusBadge> : null}
        </h2>
        {state.chain && cs !== 'none' && (
          <p className="text-sm tabular-nums">
            <b className="text-lg">{fmt(state.chain.withOrders)}</b> / {fmt(state.chain.tasks)} task có đơn N3 sau mốc import
            <span className="text-muted-foreground"> · {fmt(state.chain.covered)} task đã quét{cs === 'partial' && ' — đang cập nhật một phần'}</span>
          </p>
        )}
        <p className="text-xs break-words text-muted-foreground">
          {close ? close.text
            : none ? CARE_IMPORT_NO_DATA_HINT
            : state.lastFailed ? careImportWarnText('failed', state.lastSuccessAt!)
            : stale ? careImportWarnText('stale', state.lastSuccessAt!)
            : `Lượt đồng bộ hoàn tất gần nhất: ${careVnTime(state.lastSuccessAt!)}.`}
          {' '}“Đã đặt đơn” trong Kết quả liên hệ là dược sĩ ghi nhận, chưa phải xác nhận từ N3.
        </p>
      </div>
      <Link href={href} className="inline-flex min-h-[44px] shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline md:min-h-0">
        Xem danh sách <ChevronRight className="size-4" aria-hidden />
      </Link>
    </section>
  )
}
