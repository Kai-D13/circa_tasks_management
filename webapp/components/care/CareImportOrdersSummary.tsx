import { Receipt } from 'lucide-react'
import { EmptyState } from '@/components/ds/EmptyState'
import { StatusBadge } from '@/components/ds/StatusBadge'
import {
  CARE_IMPORT_NO_DATA_HINT, careImportCountState, careImportPartialText, careImportStale, careImportWarnText, carePeriodCloseText, careVnTime,
  type CareImportOrderList, type CareImportOrderState,
} from '@/lib/care/orderLinks/view'

const fmt = (n: number) => n.toLocaleString('vi-VN')
const NOTE = 'rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-sm break-words text-status-warning'

// PM 22/10 P1 "số 0 giả": phần trạng thái của /care/orders (cơ sở import) — tách khỏi CareOrdersScreen để bàn thử /ui-catalog
// kiểm cùng mã. Chưa quét ('none') ⇒ không số, không câu "không có đơn"; số 0 chỉ hiện khi phạm vi đã quét đủ ('full') hoặc kèm
// "Đang cập nhật một phần" / "Chưa cập nhật" ('partial').
// F1 (audit cuối P1-1): `partial` của care_import_order_list chỉ bật khi lượt lỗi ĐÃ ghi chunk ⇒ kỳ hiện tại đọc thêm trạng thái
// lượt (care_import_order_state, cùng kỳ): lượt gần nhất lỗi / quá 24 giờ ⇒ "Chưa cập nhật". PM 23/10 P1-1: mốc chỉ là "lượt đồng bộ
// hoàn tất gần nhất" — số đang hiện có thể gồm task cập nhật sau mốc (chunk của lượt sau), kèm mốc quét từng task khi có.
// PM 23/10 P1-2 (Q-204): không đọc được trạng thái lượt (lỗi / RPC trả NULL / lệch kỳ) ⇒ 'unknown': giữ các dòng đã xác thực nhưng
// KHÔNG hiện tổng N / M hay banner đếm như kết quả cả kỳ; nhắc tải lại.
export function CareImportOrdersSummary({ list, table, status, now }: {
  list: CareImportOrderList
  table: React.ReactNode
  /** Trạng thái lượt đồng bộ của CÙNG kỳ; 'error' = không đọc được; null = RPC trả NULL (không quyền xem) ⇒ cũng coi là không đọc
   *  được (fail-closed); bỏ trống (undefined) = không xét (bàn thử cũ). */
  status?: CareImportOrderState | 'error' | null
  now?: Date
}) {
  const read = status === 'error' ? null : status ?? null
  const mismatch = !!read && read.periodMonth !== list.periodMonth
  const st = read && !mismatch ? read : null
  const cur = list.isCurrentPeriod && !!list.lastSuccessAt
  const unknown = cur && (status === 'error' || status === null || mismatch)
  const failed = cur && !unknown && !!st?.lastFailed
  const stale = cur && !unknown && !failed && !!now && careImportStale(list.lastSuccessAt, now)
  const cs = careImportCountState({
    isCurrentPeriod: list.isCurrentPeriod, periodStatus: list.periodStatus, lastSuccessAt: list.lastSuccessAt,
    tasks: list.summary.tasks, covered: list.summary.covered, partial: list.partial || failed || stale,
  })
  const view = unknown && cs !== 'none' ? 'unknown' : cs
  const at = list.lastSuccessAt ? careVnTime(list.lastSuccessAt) : ''
  const partial = view === 'unknown' ? null : careImportPartialText(list)
  // Mốc quét từng task (coverage) — chỉ thêm khi banner một phần (đã có mốc riêng) không hiện.
  const range = !partial && list.summary.minCoveredUntil && list.summary.maxCoveredUntil
    ? ` Mốc quét từng task: ${careVnTime(list.summary.minCoveredUntil)} – ${careVnTime(list.summary.maxCoveredUntil)}.` : ''
  const warn = view === 'none' ? null
    : view === 'unknown' ? 'Không đọc được trạng thái lượt đồng bộ đơn — chưa kết luận số task có đơn của cả kỳ; tải lại trang để thử lại.'
    : failed ? careImportWarnText('failed', list.lastSuccessAt!) + range
    : stale ? careImportWarnText('stale', list.lastSuccessAt!) + range
    : null
  const close = carePeriodCloseText(list)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="care-orders-state" data-count-state={view}>
        {close && <StatusBadge tone={close.tone}>{close.label}</StatusBadge>}
        {!close && view === 'none' && <StatusBadge tone="neutral">Chưa có dữ liệu đơn</StatusBadge>}
        {!close && warn && <StatusBadge tone="warning">{view === 'unknown' ? 'Chưa đọc được trạng thái' : 'Chưa cập nhật'}</StatusBadge>}
        {view === 'none'
          ? !close && <span className="text-muted-foreground">{CARE_IMPORT_NO_DATA_HINT}</span>
          : view === 'unknown' ? null
          : (
            <span className="text-muted-foreground">
              {fmt(list.summary.withOrders)} / {fmt(list.summary.tasks)} task có đơn sau import
              {cur && <> · lượt đồng bộ hoàn tất gần nhất {at}</>}
              {cs === 'partial' && !partial && !warn && <> · chưa quét đủ task</>}
            </span>
          )}
      </div>
      {close && <p className="text-sm break-words text-muted-foreground">{close.text}</p>}
      {warn && <p role="note" data-testid="care-orders-stale" className={NOTE}>{warn}</p>}
      {partial && <p role="note" data-testid="care-orders-partial" className={NOTE}>{partial}</p>}
      {list.rows.length > 0 ? table
        : view === 'none' ? <EmptyState icon={Receipt} title="Chưa có dữ liệu đơn" hint={close ? undefined : CARE_IMPORT_NO_DATA_HINT} />
        : view === 'unknown' ? <EmptyState icon={Receipt} title="Chưa đọc được trạng thái đơn" />
        : <EmptyState icon={Receipt} title="Chưa có task có đơn sau import"
            hint={cs === 'partial' ? 'Không thấy đơn trong số task đã quét — dữ liệu chưa đầy đủ.' : 'Không thấy đơn theo dữ liệu đã quét.'} />}
    </>
  )
}
