// CRM-CSKH E3 — dạng hiển thị "đơn xác thực sau import" (thiết kế E0 r3.4 §5, §7, §9). THUẦN: đọc jsonb RPC 116 (fail-closed)
// + nhãn trạng thái theo bảng §5. Không ID khách; mã đơn (DHC) chỉ ở care_task_orders (chi tiết task) — không vào URL / log.
// Không import ./source (node:crypto, BigQuery) — file này dùng được ở client component.
import type { StatusTone } from '@/components/ds/StatusBadge'

/** = CARE_US_TS của ./source (mốc µs UTC của care__utc_us). */
const CARE_US_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/

export type CareOrderPeriodStatus = 'none' | 'active' | 'closed' | 'close_failed'
const PERIOD_STATUS: readonly string[] = ['none', 'active', 'closed', 'close_failed']

export interface CareTaskOrder { orderCode: string; completedAt: string; linkId: number }
export type CareTaskOrdersView =
  | { found: false }
  | {
    found: true; orders: CareTaskOrder[]; hasMore: boolean; ordersCount: number; coverage: boolean; coveredUntil: string | null
    periodMonth: string; isCurrentPeriod: boolean; periodStatus: CareOrderPeriodStatus; closedAt: string | null; closedThrough: string | null; lagging: boolean
  }

const malformed = () => new Error('care_order_view_malformed')
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const ts = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || !CARE_US_TS.test(v)) throw malformed()
  return v
}
const period = (v: unknown): string => { if (typeof v !== 'string' || !/^\d{4}-\d\d-01$/.test(v)) throw malformed(); return v }
const pstatus = (v: unknown): CareOrderPeriodStatus => { if (typeof v !== 'string' || !PERIOD_STATUS.includes(v)) throw malformed(); return v as CareOrderPeriodStatus }
const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') throw malformed(); return v }

export function parseTaskOrders(raw: unknown): CareTaskOrdersView {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') throw malformed()
  if (r.found === false) return { found: false }
  if (r.found !== true || !Array.isArray(r.orders)) throw malformed()
  const orders = r.orders.map((o) => {
    const x = o as Record<string, unknown>
    if (typeof x.order_code !== 'string' || x.order_code.length < 1 || x.order_code.length > 200 || !isCount(x.link_id)) throw malformed()
    return { orderCode: x.order_code, completedAt: ts(x.completed_at)!, linkId: x.link_id }
  })
  if (orders.some((o) => o.completedAt === null) || !isCount(r.orders_count)) throw malformed()
  return {
    found: true, orders, hasMore: bool(r.has_more), ordersCount: r.orders_count, coverage: bool(r.coverage), coveredUntil: ts(r.covered_until),
    periodMonth: period(r.period_month), isCurrentPeriod: bool(r.is_current_period), periodStatus: pstatus(r.period_status),
    closedAt: ts(r.closed_at), closedThrough: ts(r.closed_through), lagging: r.lagging === true,
  }
}

/** Giờ VN `HH:MM dd/mm/yyyy` từ mốc µs UTC (phần µs chỉ để so sánh — hiển thị tới phút). */
export function careVnTime(iso: string): string {
  const d = new Date(Date.parse(iso.slice(0, 23) + 'Z') + 7 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`
}
/** `dd/mm` theo ngày VN. */
const vnDayMonth = (iso: string) => careVnTime(iso).slice(6, 11)

export interface CareOrderStateNote {
  /** Nhãn chính (StatusBadge). */
  label: string
  tone: StatusTone
  /** Câu giải thích dưới danh sách / thay danh sách khi 0 đơn. */
  text: string
  /** Hiện "Chưa cập nhật" (Q-183) — chỉ kỳ hiện tại. */
  lagging: boolean
}

/**
 * TODO(Q-189): nhãn "Đang chờ chốt kỳ" (kỳ cũ active) tách khỏi "Chưa chốt đủ dữ liệu đơn" (close_failed) — mặc định Dev.
 * TODO(Q-194): BI chưa có watermark ⇒ "Đã chốt" chỉ nghĩa là theo VIEW N3 tại mốc chốt, không hứa đủ mọi đơn.
 * TODO(Q-183): "Chưa cập nhật" = mốc dữ liệu cũ hơn 24 h (RPC trả `lagging`).
 * Bảng E0 §5. `ordersCount` của task (0 ⇒ câu "chưa thấy đơn" đúng giới hạn nguồn; KHÔNG "Chưa có đơn" khi chưa quét).
 * Kỳ đã chốt: "Đã chốt theo VIEW N3 lúc …" — không hứa BI đã nạp đủ mọi đơn (Q-194).
 */
export function careOrderStateNote(v: Extract<CareTaskOrdersView, { found: true }>): CareOrderStateNote {
  const none = (extra = ''): CareOrderStateNote => ({ label: 'Chưa có dữ liệu đơn', tone: 'neutral', text: `Chưa có dữ liệu đơn sau import cho khách này${extra}.`, lagging: false })
  if (v.isCurrentPeriod) {
    if (!v.coverage) return { ...none(), lagging: v.lagging }
    return {
      label: v.ordersCount > 0 ? `${v.ordersCount} đơn xác thực` : 'Chưa thấy đơn', tone: v.ordersCount > 0 ? 'success' : 'neutral',
      text: v.ordersCount > 0 ? `Theo dữ liệu đơn N3 đến ${careVnTime(v.coveredUntil!)}.` : `Chưa thấy đơn theo dữ liệu đến ${careVnTime(v.coveredUntil!)}.`,
      lagging: v.lagging,
    }
  }
  if (v.periodStatus === 'none' || !v.coverage) return none()
  if (v.periodStatus === 'closed') {
    const head = `Đã chốt theo VIEW N3 lúc ${careVnTime(v.closedAt!)} — đơn hoàn tất trước 00:00 ${vnDayMonth(v.closedThrough!)}.`
    return {
      label: 'Đã chốt kỳ', tone: v.ordersCount > 0 ? 'success' : 'neutral',
      text: v.ordersCount > 0 ? head : `${head} Không thấy đơn theo dữ liệu VIEW tại mốc chốt.`, lagging: false,
    }
  }
  const upTo = v.coveredUntil ? ` Dữ liệu đến ${careVnTime(v.coveredUntil)}.` : ''
  if (v.periodStatus === 'active') return { label: 'Đang chờ chốt kỳ', tone: 'info', text: `Kỳ đã kết thúc, đang chờ lượt chốt dữ liệu đơn.${upTo}`, lagging: false }
  return { label: 'Chưa chốt đủ dữ liệu đơn', tone: 'warning', text: `Lượt chốt dữ liệu đơn của kỳ chưa thành công.${upTo}`, lagging: false }
}

// ── /care/orders basis=import ────────────────────────────────────────────────────────────────────────────────────────
export interface CareImportOrderRow {
  taskId: string; customerName: string; storeId: string; assigneeId: string; storeCode: string | null; assigneeName: string | null; status: string
  ordersCount: number; latestCompletedAt: string; coveredUntil: string | null; lagging: boolean
}
export interface CareImportOrderList {
  periodMonth: string; isCurrentPeriod: boolean; periodStatus: CareOrderPeriodStatus; closedAt: string | null; closedThrough: string | null
  lastSuccessAt: string | null
  summary: { tasks: number; covered: number; withOrders: number; notCovered: number; lagging: number; minCoveredUntil: string | null; maxCoveredUntil: string | null }
  partial: boolean
  rows: CareImportOrderRow[]
  hasMore: boolean
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const uuid = (v: unknown): string => { if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) throw malformed(); return v }

export function parseImportOrderList(raw: unknown): CareImportOrderList {
  const r = raw as Record<string, unknown> | null
  const s = r?.summary as Record<string, unknown> | undefined
  if (!r || !s || !Array.isArray(r.rows)) throw malformed()
  for (const k of ['tasks', 'covered', 'with_orders', 'not_covered', 'lagging']) if (!isCount(s[k])) throw malformed()
  return {
    periodMonth: period(r.period_month), isCurrentPeriod: bool(r.is_current_period), periodStatus: pstatus(r.period_status),
    closedAt: ts(r.closed_at), closedThrough: ts(r.closed_through), lastSuccessAt: ts(r.last_success_at),
    summary: { tasks: s.tasks as number, covered: s.covered as number, withOrders: s.with_orders as number, notCovered: s.not_covered as number,
      lagging: s.lagging as number, minCoveredUntil: ts(s.min_covered_until), maxCoveredUntil: ts(s.max_covered_until) },
    partial: bool(r.partial),
    rows: r.rows.map((x) => {
      const o = x as Record<string, unknown>
      if (typeof o.customer_name !== 'string' || typeof o.status !== 'string' || !isCount(o.orders_count)) throw malformed()
      return { taskId: uuid(o.task_id), customerName: o.customer_name, storeId: uuid(o.store_id), assigneeId: uuid(o.assignee_id),
        storeCode: str(o.store_code), assigneeName: str(o.assignee_name), status: o.status,
        ordersCount: o.orders_count, latestCompletedAt: ts(o.latest_completed_at)!, coveredUntil: ts(o.covered_until), lagging: o.lagging === true }
    }),
    hasMore: bool(r.has_more),
  }
}

/**
 * PM 22/10 P1 "số 0 giả" (CONTRACT §E Q-186): số đơn sau import chỉ là số thật khi phạm vi đã được quét.
 *  · 'none'    — kỳ hiện tại chưa có lượt sync E thành công, kỳ cũ chưa từng bật đối chiếu, hoặc chưa task nào trong phạm vi
 *                được quét ⇒ KHÔNG hiện số / câu "không có đơn" — hiện "Chưa có dữ liệu đơn";
 *  · 'partial' — đã quét một phần (hoặc RPC báo partial: task chậm / lượt lỗi giữ mốc cũ; hoặc — khi truyền `now` — kỳ hiện tại
 *                quá 24 giờ từ lần thành công, PM 22/10 F1) ⇒ hiện số kèm "Đang cập nhật một phần" / "Chưa cập nhật" + mốc;
 *  · 'full'    — mọi task trong phạm vi đã quét, lượt còn trong hạn ⇒ số hiện ra (kể cả 0) là số theo VIEW N3 tại mốc hiển thị.
 */
export type CareImportCountState = 'none' | 'partial' | 'full'
export function careImportCountState(p: {
  isCurrentPeriod: boolean; periodStatus?: CareOrderPeriodStatus; lastSuccessAt: string | null; tasks: number; covered: number; partial?: boolean
  now?: Date
}): CareImportCountState {
  if (p.isCurrentPeriod ? !p.lastSuccessAt : p.periodStatus === 'none') return 'none'
  if (p.tasks > 0 && p.covered === 0) return 'none'
  const stale = p.isCurrentPeriod && !!p.now && careImportStale(p.lastSuccessAt, p.now)
  return p.partial || stale || p.covered < p.tasks ? 'partial' : 'full'
}
export const CARE_IMPORT_NO_DATA_HINT = 'Sẽ có sau lượt đồng bộ đơn sau import đầu tiên của kỳ.'
/** "Chưa cập nhật" theo thời gian (Q-183): lượt đồng bộ hoàn tất gần nhất cách `now` quá 24 giờ — một ngưỡng chung cho
 *  /care/my, /care/orders, /care/reports (PM 23/10: Q-183 đã chốt, không mở câu hỏi mới). */
export const CARE_IMPORT_STALE_MS = 24 * 3600_000
export function careImportStale(lastSuccessAt: string | null, now: Date): boolean {
  if (!lastSuccessAt) return false
  const t = Date.parse(lastSuccessAt.slice(0, 23) + 'Z') // mốc µs UTC như careVnTime
  return Number.isFinite(t) && now.getTime() - t > CARE_IMPORT_STALE_MS
}

/**
 * PM 23/10 P1-1 (Q-181): `last_success_at` chỉ là mốc lượt đồng bộ HOÀN TẤT gần nhất — lượt sau ghi link + coverage theo từng chunk
 * ngay cả khi rồi lỗi / còn đang chạy ⇒ số đang hiện có thể gồm task cập nhật SAU mốc này. Không gán số cho mốc ấy, không suy số cả
 * kỳ từ nó. Dùng chung cho /care/my, /care/orders, /care/reports.
 */
export function careImportDoneText(lastSuccessAt: string): string {
  return `Lượt đồng bộ hoàn tất gần nhất: ${careVnTime(lastSuccessAt)}; số đang hiện có thể gồm task đã cập nhật sau mốc này, chưa phải số đầy đủ của cả kỳ.`
}
export function careImportWarnText(kind: 'failed' | 'stale', lastSuccessAt: string): string {
  return `${kind === 'failed' ? 'Chưa cập nhật — lượt đồng bộ đơn gần nhất chưa thành công.' : 'Chưa cập nhật quá 24 giờ.'} ${careImportDoneText(lastSuccessAt)}`
}

/**
 * /care/my (PM 22/10 F1 P1): gộp tóm tắt của dược sĩ (`care_my_order_summary`) với trạng thái lượt (`care_import_order_state`,
 * session dược sĩ — không `chain`) CỦA CÙNG KỲ. Thiếu / lỗi / lệch kỳ một nguồn ⇒ 'none' (không kết luận số; task vẫn dùng được).
 * `qa` (fixture is_test) ⇒ không áp trạng thái lượt thật — fixture chỉ theo coverage của chính nó.
 */
export interface CareMyOrdersView { state: CareImportCountState; note: string | null }
export function careMyOrdersView(p: {
  summary: CareMyOrderSummary | null; status: CareImportOrderState | null | 'error'; period: string; now: Date; qa: boolean
}): CareMyOrdersView {
  const s = p.summary
  if (!s) return { state: 'none', note: null }
  let failed = false
  if (!p.qa) {
    const st = p.status
    if (st === 'error') return { state: 'none', note: 'Không đọc được trạng thái đồng bộ đơn — tải lại trang để thử lại.' }
    if (!st || st.periodMonth !== p.period || !st.isCurrentPeriod) return { state: 'none', note: null }
    failed = st.lastFailed
  }
  const stale = !p.qa && careImportStale(s.lastSuccessAt, p.now)
  const state = careImportCountState({ isCurrentPeriod: true, lastSuccessAt: s.lastSuccessAt, tasks: s.tasks, covered: s.covered, partial: failed || stale })
  const note = state !== 'partial' ? null
    : failed ? careImportWarnText('failed', s.lastSuccessAt!)
    : stale ? careImportWarnText('stale', s.lastSuccessAt!)
    : `Đang cập nhật một phần — còn khách chưa được quét đơn. ${careImportDoneText(s.lastSuccessAt!)}`
  return { state, note }
}

/** Câu "Đang cập nhật một phần" (Q-181) — chỉ kỳ hiện tại; kỳ cũ dùng trạng thái chốt. */
export function careImportPartialText(l: CareImportOrderList): string | null {
  if (!l.isCurrentPeriod || !l.partial) return null
  const notYet = l.summary.notCovered + l.summary.lagging
  const range = l.summary.minCoveredUntil && l.summary.maxCoveredUntil
    ? ` (${careVnTime(l.summary.minCoveredUntil)} – ${careVnTime(l.summary.maxCoveredUntil)})` : ''
  return `Đang cập nhật một phần — ${l.summary.withOrders} task có đơn trong số task đã quét; ${notYet} task chưa quét / chưa cập nhật; mỗi task theo mốc riêng${range}.`
}

/** Trạng thái chốt của kỳ cũ cho banner danh sách. */
export function carePeriodCloseText(p: { isCurrentPeriod: boolean; periodStatus: CareOrderPeriodStatus; closedAt: string | null; closedThrough: string | null }): { tone: StatusTone; label: string; text: string } | null {
  if (p.isCurrentPeriod) return null
  if (p.periodStatus === 'closed') return { tone: 'success', label: 'Đã chốt kỳ', text: `Đã chốt theo VIEW N3 lúc ${careVnTime(p.closedAt!)} — đơn hoàn tất trước 00:00 ${vnDayMonth(p.closedThrough!)}. Không bao gồm đơn BI nạp sau mốc chốt.` }
  if (p.periodStatus === 'active') return { tone: 'info', label: 'Đang chờ chốt kỳ', text: 'Kỳ đã kết thúc, đang chờ lượt chốt dữ liệu đơn.' }
  if (p.periodStatus === 'close_failed') return { tone: 'warning', label: 'Chưa chốt đủ dữ liệu đơn', text: 'Lượt chốt dữ liệu đơn của kỳ chưa thành công — số dưới đây theo mốc riêng từng task.' }
  return { tone: 'neutral', label: 'Chưa có dữ liệu đơn', text: 'Kỳ này trước khi bật đối chiếu đơn sau import.' }
}

// ── /care/orders basis=care (cohort KPI) ─────────────────────────────────────────────────────────────────────────────
export interface CareConversionRow {
  taskId: string; customerName: string; storeId: string; assigneeId: string; storeCode: string | null; assigneeName: string | null
  orders: number; latestCompletedAt: string
}
export interface CareConversionList { periodMonth: string; cohortTotal: number; visibleTotal: number; rows: CareConversionRow[]; hasMore: boolean }

export function parseConversionList(raw: unknown): CareConversionList {
  const r = raw as Record<string, unknown> | null
  if (!r || !isCount(r.cohort_total) || !isCount(r.visible_total) || !Array.isArray(r.rows)) throw malformed()
  return {
    periodMonth: period(r.period_month), cohortTotal: r.cohort_total, visibleTotal: r.visible_total, hasMore: bool(r.has_more),
    rows: r.rows.map((x) => {
      const o = x as Record<string, unknown>
      if (typeof o.customer_name !== 'string' || !isCount(o.orders)) throw malformed()
      return { taskId: uuid(o.task_id), customerName: o.customer_name, storeId: uuid(o.store_id), assigneeId: uuid(o.assignee_id),
        storeCode: str(o.store_code), assigneeName: str(o.assignee_name), orders: o.orders, latestCompletedAt: ts(o.latest_completed_at)! }
    }),
  }
}

export interface CareImportOrderState {
  periodMonth: string; isCurrentPeriod: boolean; hasSynced: boolean; lastSuccessAt: string | null; lastFailed: boolean
  periodStatus: CareOrderPeriodStatus; closedAt: string | null; closedThrough: string | null
  chain: { tasks: number; covered: number; withOrders: number } | null
}
export function parseImportOrderState(raw: unknown): CareImportOrderState | null {
  if (raw === null || raw === undefined) return null
  const r = raw as Record<string, unknown>
  const c = r.chain as Record<string, unknown> | null
  if (c !== null && (!c || !isCount(c.tasks) || !isCount(c.covered) || !isCount(c.with_orders))) throw malformed()
  return {
    periodMonth: period(r.period_month), isCurrentPeriod: bool(r.is_current_period), hasSynced: bool(r.has_synced), lastSuccessAt: ts(r.last_success_at),
    lastFailed: bool(r.last_failed), periodStatus: pstatus(r.period_status), closedAt: ts(r.closed_at), closedThrough: ts(r.closed_through),
    chain: c ? { tasks: c.tasks as number, covered: c.covered as number, withOrders: c.with_orders as number } : null,
  }
}

export interface CareMyOrderSummary { tasks: number; covered: number; tasksWithOrders: number; orders: number; lastSuccessAt: string | null }
export function parseMyOrderSummary(raw: unknown): CareMyOrderSummary | null {
  if (raw === null || raw === undefined) return null
  const r = raw as Record<string, unknown>
  if (!isCount(r.tasks) || !isCount(r.covered) || !isCount(r.tasks_with_orders) || !isCount(r.orders)) throw malformed()
  return { tasks: r.tasks, covered: r.covered, tasksWithOrders: r.tasks_with_orders, orders: r.orders, lastSuccessAt: ts(r.last_success_at) }
}

/** care_my_order_tasks: một trang keyset (latest DESC, task_id DESC). NULL (không phải dược sĩ) ⇒ trang rỗng. */
export interface CareMyOrderTaskKey { taskId: string; latestCompletedAt: string }
export function parseMyOrderTasks(raw: unknown): { rows: CareMyOrderTaskKey[]; hasMore: boolean } {
  if (raw === null || raw === undefined) return { rows: [], hasMore: false }
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.rows)) throw malformed()
  return {
    rows: r.rows.map((x) => { const o = x as Record<string, unknown>; return { taskId: uuid(o.task_id), latestCompletedAt: ts(o.latest_completed_at)! } }),
    hasMore: bool(r.has_more),
  }
}

/** care_task_order_counts: chỉ task người xem đọc được (vị từ READ trong RPC); task 0 đơn có latest NULL. */
export interface CareTaskOrderCount { taskId: string; ordersCount: number; latestCompletedAt: string | null }
export function parseTaskOrderCounts(raw: unknown): CareTaskOrderCount[] {
  if (!Array.isArray(raw)) throw malformed()
  return raw.map((x) => {
    const o = x as Record<string, unknown>
    if (!isCount(o.orders_count)) throw malformed()
    return { taskId: uuid(o.task_id), ordersCount: o.orders_count, latestCompletedAt: ts(o.latest_completed_at) }
  })
}

/** Nối trang "Xem thêm" vào danh sách đang hiện: bỏ task đã có (đơn mới làm task nhảy lên giữa hai lần tải). */
export function appendNewById<R extends { id: string }>(cur: readonly R[], more: readonly R[]): R[] {
  const seen = new Set(cur.map((r) => r.id))
  const out = [...cur]
  for (const r of more) if (!seen.has(r.id)) { seen.add(r.id); out.push(r) }
  return out
}
