import type { CareReportRow } from './browse'

// CRM-CSKH B5a r1.1 — logic THUẦN cho báo cáo /care/reports + export (SPEC §B5a r1.1, Q-91). Một nguồn
// số liệu: RPC care_report (task theo owner hiện tại; "Khách có đơn" = số task DISTINCT có ≥1 đơn
// COMPLETED sau lượt Hoàn thành, theo snapshot + tháng của lượt — Q-59). GĐ1 KHÔNG số đơn/tiền (Q-91).
// Màn hình và export dùng CHUNG careReportLines/careReportSummary/careReportExportRows ⇒ cùng filter,
// cùng scope, cùng số. Không import Next/Supabase.

// ── Trạng thái dữ liệu đơn (care_order_sync_status) ─────────────────────────────
/** 'none' = chưa đồng bộ thành công lần nào ⇒ KHÔNG trình bày số 0 như kết quả đã xác thực. */
export type CareOrderDataState =
  | { kind: 'none' }
  | { kind: 'synced'; lastSuccessAt: string; lastFailed: boolean }

export const CARE_ORDER_NO_DATA = 'Chưa có dữ liệu đơn'
/** Task chưa có đơn SAU khi đã đồng bộ: chưa thấy — không khẳng định "không có đơn". */
export const CARE_ORDER_NOT_SEEN = 'Chưa thấy đơn theo dữ liệu đến lần đồng bộ'
export const CARE_REPORT_STORE_OUT_OF_SCOPE = 'Cửa hàng đã chọn không thuộc phạm vi của bạn'

export function careOrderDataState(row: { has_synced?: unknown; last_success_at?: unknown; last_failed?: unknown } | null | undefined): CareOrderDataState {
  if (!row || row.has_synced !== true || typeof row.last_success_at !== 'string' || !row.last_success_at) return { kind: 'none' }
  return { kind: 'synced', lastSuccessAt: row.last_success_at, lastFailed: row.last_failed === true }
}

/** 'YYYY-MM-DDTHH:MM…' (UTC) ⇒ "HH:mm dd/MM/yyyy" giờ VN. */
export function vnDateTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const d = new Date(t + 7 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`
}

/**
 * Filter cửa hàng (URL) có thuộc scope người xem? null = không lọc. Ngoài scope ⇒ caller trả RỖNG/lỗi
 * filter, KHÔNG âm thầm nới thành toàn scope (SPEC §B5a r1.1). Dùng chung /care, /care/reports, export.
 */
export function careStoreFilterInScope(storeId: string | null, scopeStores: readonly { id: string }[]): boolean {
  return !storeId || scopeStores.some((s) => s.id === storeId)
}

/** Câu "chưa thấy đơn" kèm mốc đồng bộ thành công cuối (dùng chung UI + export). */
export function careOrderNotSeenText(state: Extract<CareOrderDataState, { kind: 'synced' }>): string {
  return `${CARE_ORDER_NOT_SEEN} ${vnDateTime(state.lastSuccessAt)}`
}

// ── Dòng báo cáo ───────────────────────────────────────────────────────────────
export interface CareReportLine {
  storeId: string
  storeCode: string
  storeName: string
  assigneeId: string
  assigneeName: string
  tasks: number
  completed: number
  notCared: number
  inProgress: number
  overdueInPeriod: number
  closedUnfinished: number
  /** Số task Có đơn (DISTINCT task — nhiều đơn cùng task vẫn 1). */
  convertedTasks: number
  /**
   * B8.2 (Q-113): task có ≥1 lượt chăm sóc (`last_interaction_at` có giá trị), kể cả kỳ đã đóng =
   * Hoàn thành + Đang theo dõi + Không hoàn thành ĐÃ TỪNG có lượt. Hoàn thành luôn có lượt (chỉ lượt
   * kết thúc mới chuyển completed); phần "không hoàn thành có lượt" đọc riêng (careReportLines `touched`).
   */
  contacted: number
}

export type CareReportTotals = Omit<CareReportLine, 'storeId' | 'storeCode' | 'storeName' | 'assigneeId' | 'assigneeName'>

/** Khoá dòng store × dược sĩ (dùng cho bảng phụ `touched`). */
export const careReportKey = (storeId: string, assigneeId: string) => `${storeId}|${assigneeId}`

/** Một dòng RPC (store × dược sĩ) ⇒ một dòng báo cáo; KHÔNG JOIN sản phẩm/lượt/đơn (không nhân task). */
export function careReportLines(
  rows: readonly CareReportRow[],
  ctx: { stores: ReadonlyMap<string, { code: string; name: string }>; names: ReadonlyMap<string, string> },
  /** Số task closed_unfinished CÓ lượt theo careReportKey (kỳ đang mở luôn rỗng). */
  touched: ReadonlyMap<string, number> = new Map(),
): CareReportLine[] {
  return rows
    .map((r) => ({
      storeId: r.store_id,
      storeCode: ctx.stores.get(r.store_id)?.code ?? '—',
      storeName: ctx.stores.get(r.store_id)?.name ?? '',
      assigneeId: r.assignee_id,
      assigneeName: ctx.names.get(r.assignee_id) ?? '—',
      tasks: r.tasks_total,
      completed: r.completed,
      notCared: r.open_not_cared,
      inProgress: r.open_in_progress,
      overdueInPeriod: r.overdue_in_period,
      closedUnfinished: r.closed_unfinished,
      convertedTasks: r.converted_tasks,
      contacted: r.completed + r.open_in_progress + Math.min(r.closed_unfinished, touched.get(careReportKey(r.store_id, r.assignee_id)) ?? 0),
    }))
    // Store không xác định ('—', vd. store đã xoá khỏi danh mục) xuống cuối.
    .sort((a, b) => Number(a.storeCode === '—') - Number(b.storeCode === '—') || a.storeCode.localeCompare(b.storeCode)
      || a.assigneeName.localeCompare(b.assigneeName, 'vi') || a.assigneeId.localeCompare(b.assigneeId))
}

/** Số task Có đơn trên dòng RPC (dashboard /care) — cùng phép cộng với báo cáo. */
export function careReportConvertedTotal(rows: readonly CareReportRow[]): number {
  return rows.reduce((s, r) => s + r.converted_tasks, 0)
}

export function careReportSummary(lines: readonly CareReportLine[]): CareReportTotals {
  const n = (k: keyof CareReportTotals) => lines.reduce((s, l) => s + l[k], 0)
  return {
    tasks: n('tasks'), completed: n('completed'), notCared: n('notCared'), inProgress: n('inProgress'),
    overdueInPeriod: n('overdueInPeriod'), closedUnfinished: n('closedUnfinished'), convertedTasks: n('convertedTasks'),
    contacted: n('contacted'),
  }
}

// ── B8.2: nhóm theo cửa hàng, nhịp kỳ, link danh sách ──────────────────────────
/** Nhóm dòng theo cửa hàng (giữ thứ tự careReportLines); tổng phụ = cộng ĐÚNG các dòng của store trong scope. */
export function careReportGroups(lines: readonly CareReportLine[]): { storeId: string; storeCode: string; storeName: string; totals: CareReportTotals; lines: CareReportLine[] }[] {
  const out: { storeId: string; storeCode: string; storeName: string; lines: CareReportLine[] }[] = []
  for (const l of lines) {
    const g = out.find((x) => x.storeId === l.storeId)
    if (g) g.lines.push(l); else out.push({ storeId: l.storeId, storeCode: l.storeCode, storeName: l.storeName, lines: [l] })
  }
  return out.map((g) => ({ ...g, totals: careReportSummary(g.lines) }))
}

const daysInMonth = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate()
/**
 * Phần thời gian của kỳ đã qua theo NGÀY VN (Q-114 — chỉ hiển thị thanh, không cảnh báo). Kỳ cũ ⇒ 100%
 * (`ended`); kỳ hiện tại ⇒ ngày hôm nay (tính cả hôm nay) / số ngày của tháng. Kỳ tương lai không xảy ra
 * (parseCareFilters chặn) ⇒ 0.
 */
export function carePeriodElapsed(period: string, todayISO: string): { elapsedDays: number; totalDays: number; pct: number; ended: boolean } {
  const totalDays = daysInMonth(period)
  const cur = todayISO.slice(0, 7) + '-01'
  if (period < cur) return { elapsedDays: totalDays, totalDays, pct: 100, ended: true }
  if (period > cur) return { elapsedDays: 0, totalDays, pct: 0, ended: false }
  const elapsedDays = Math.min(totalDays, Number(todayISO.slice(8, 10)))
  return { elapsedDays, totalDays, pct: Math.round((elapsedDays / totalDays) * 100), ended: false }
}

export const carePct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0)

/** Khoá bộ lọc số liệu phụ /care/reports (kỳ/store/dược sĩ) — trang dùng làm `key` provider, provider chặn lúc render. */
export const careReportExtrasKey = (p: { month: string; store: string | null; assignee: string | null }) => `${p.month}|${p.store ?? ''}|${p.assignee ?? ''}`

/**
 * Cột báo cáo được phép thành link sang /care/tasks — CHỈ khi filter danh sách trả ĐÚNG CÙNG TẬP task
 * với số đếm care_report (theo store + owner hiện tại): tasks/completed/notCared/inProgress/closedUnfinished.
 * KHÔNG link: overdueInPeriod (first_overdue_on gồm cả task đã kết thúc ≠ filter overdue_open), convertedTasks
 * (snapshot lượt Hoàn thành), contacted (không có filter tương ứng) — PM audit B8 P1.
 */
export const CARE_REPORT_LINK_STATUS = {
  tasks: null, completed: 'completed', notCared: 'not_cared', inProgress: 'following', closedUnfinished: 'closed_unfinished',
} as const
export type CareReportLinkKey = keyof typeof CARE_REPORT_LINK_STATUS

/**
 * B8.4 — ô KPI dashboard /care được làm link sang /care/tasks CHỈ khi danh sách đích trả ĐÚNG CÙNG TẬP với số đếm:
 * 4 khoá của CARE_REPORT_LINK_STATUS (cùng care_report) + "Quá hạn đang mở" (đếm bằng chính bộ lọc `overdue_open`,
 * chỉ kỳ hiện tại). Dashboard lọc kỳ + cửa hàng, KHÔNG lọc dược sĩ ⇒ link không mang dược sĩ.
 * KHÔNG link: "Từng trễ hẹn" (first_overdue_on ≠ overdue_open), "Khách có đơn" (snapshot lượt Hoàn thành).
 */
export const CARE_DASHBOARD_LINK_STATUS = {
  tasks: null, completed: 'completed', notCared: 'not_cared', closedUnfinished: 'closed_unfinished', overdueOpen: 'overdue_open',
} as const
export type CareDashboardLinkKey = keyof typeof CARE_DASHBOARD_LINK_STATUS

// ── Export (cùng dòng/filter với màn hình) ──────────────────────────────────────
/** Trần phòng thủ: dòng = store × dược sĩ (thực tế vài trăm). */
export const CARE_REPORT_EXPORT_MAX_ROWS = 5000

/**
 * Dòng Excel: KHÔNG có SĐT/ID khách/mã đơn (báo cáo tổng hợp theo store × dược sĩ), KHÔNG số đơn/tiền
 * (Q-91). Trước đồng bộ đơn đầu tiên, cột "Khách có đơn" ghi rõ "Chưa có dữ liệu đơn" (không xuất 0
 * giả); có dữ liệu ⇒ số task Có đơn + mốc cập nhật (lần sau lỗi ⇒ giữ số cũ + ghi chú).
 */
export function careReportExportRows(
  lines: readonly CareReportLine[], totals: CareReportTotals, state: CareOrderDataState, monthLabel: string,
): Record<string, unknown>[] {
  const synced = state.kind === 'synced' ? `${vnDateTime(state.lastSuccessAt)}${state.lastFailed ? ' (lần gần nhất lỗi — chưa cập nhật)' : ''}` : CARE_ORDER_NO_DATA
  const base = (l: CareReportTotals, store: string, storeName: string, who: string) => ({
    'Kỳ chăm sóc': monthLabel, 'Cửa hàng': store, 'Tên cửa hàng': storeName, 'Dược sĩ': who,
    'Khách (task)': l.tasks, 'Hoàn thành': l.completed, 'Chưa chăm sóc': l.notCared, 'Đang theo dõi': l.inProgress,
    'Từng trễ hẹn': l.overdueInPeriod, 'Không hoàn thành': l.closedUnfinished,
    'Khách có đơn': state.kind === 'none' ? CARE_ORDER_NO_DATA : l.convertedTasks, 'Dữ liệu đơn cập nhật': synced,
  })
  return [
    ...lines.map((l) => base(l, l.storeCode, l.storeName, l.assigneeName)),
    ...(lines.length ? [base(totals, 'TỔNG', '', '')] : []),
  ]
}
