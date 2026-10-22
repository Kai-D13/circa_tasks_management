import Link from 'next/link'
import { ChevronRight, Receipt } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { carePeriodCloseText, careVnTime, type CareImportOrderState } from '@/lib/care/orderLinks/view'
import { cn } from '@/lib/utils'

// E3 — khối "Đơn xác thực sau import" trên /care/reports (thiết kế E0 r3.4 §5, §9). Tách khỏi KPI 114 "Khách có đơn sau
// chăm sóc" (ghi công theo lượt Hoàn thành): ở đây là đơn N3 hoàn tất SAU mốc import của task, đối chiếu bằng mã đơn trên POS.
// Số toàn chuỗi chỉ cho super / care admin (RPC trả `chain` theo quyền); mọi vai còn lại chỉ trạng thái + link danh sách.

const fmt = (n: number) => n.toLocaleString('vi-VN')

export function CareImportOrdersBlock({ state, href }: { state: CareImportOrderState | null; href: string }) {
  if (!state) return null
  const close = carePeriodCloseText(state)
  const none = state.isCurrentPeriod && !state.hasSynced
  return (
    <section aria-labelledby="care-import-orders" data-testid="care-import-orders-block"
      className={cn('flex flex-col gap-2 rounded-care-panel border border-care-line bg-card p-4 md:flex-row md:items-center md:justify-between', none && 'border-dashed bg-transparent')}>
      <div className="min-w-0 space-y-1">
        <h2 id="care-import-orders" className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <Receipt className="size-4 text-muted-foreground" aria-hidden /> Đơn xác thực sau import
          {close ? <StatusBadge tone={close.tone}>{close.label}</StatusBadge>
            : none ? <StatusBadge tone="neutral">Chưa có dữ liệu đơn</StatusBadge>
            : state.lastFailed ? <StatusBadge tone="warning">Chưa cập nhật</StatusBadge> : null}
        </h2>
        {state.chain && (
          <p className="text-sm tabular-nums">
            <b className="text-lg">{fmt(state.chain.withOrders)}</b> / {fmt(state.chain.tasks)} task có đơn N3 sau mốc import
            <span className="text-muted-foreground"> · {fmt(state.chain.covered)} task đã quét</span>
          </p>
        )}
        <p className="text-xs break-words text-muted-foreground">
          {close ? close.text
            : none ? 'Sẽ có khi đồng bộ đơn sau import được bật.'
            : state.lastFailed ? `Lần đồng bộ gần nhất chưa thành công — giữ dữ liệu đến lần thành công ${careVnTime(state.lastSuccessAt!)}.`
            : `Cập nhật lúc ${careVnTime(state.lastSuccessAt!)}.`}
          {' '}“Đã đặt đơn” trong Kết quả liên hệ là dược sĩ ghi nhận, chưa phải xác nhận từ N3.
        </p>
      </div>
      <Link href={href} className="inline-flex min-h-[44px] shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline md:min-h-0">
        Xem danh sách <ChevronRight className="size-4" aria-hidden />
      </Link>
    </section>
  )
}
