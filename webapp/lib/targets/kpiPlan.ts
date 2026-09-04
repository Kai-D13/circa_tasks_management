// BQ-V2 r2 (audit P1#1+#2) — ATOMIC LANDING GATE cho cron pull-kpi-targets,
// tách THUẦN để test được (kpi.ts giữ server-only IO mỏng).
//
// Contract: nguồn schema V2 — bảng buymed_tech pre-aggregated → kỳ vọng MỖI active OS
// store có ĐÚNG 1 row DAY + 1 row MONTH (WEEK chưa bật — vắng KHÔNG phải
// lỗi). Bất kỳ sai lệch nào — thiếu store×grain (missing), nguồn trùng dòng
// (duplicates), row không match store nào (unmatched), row hỏng (rowErrors)
// — → ok=false: caller KHÔNG upsert BẤT KỲ row nào và cron trả non-2xx.
// Không bao giờ "cron xanh một phần": store này số mới, store kia snapshot cũ.
import { normalizeStoreName } from './parse'
import { POS_CODE_BY_NAME } from './posMap'

export type KpiGrain = 'day' | 'week' | 'month'
// Grain BẮT BUỘC đủ coverage; 'week' thêm vào đây khi BI có dữ liệu WEEK.
export const REQUIRED_GRAINS: KpiGrain[] = ['day', 'month']
const KNOWN_GRAINS: KpiGrain[] = ['day', 'week', 'month']

export interface KpiStoreRef { id: string; name: string; code: string | null }

export interface KpiUpsertRow {
  store_id: string
  period_type: KpiGrain
  period_start: string
  period_end: string
  actual: number
  target: number
  run_rate: number | null
  status: string | null
  remaining_target: number | null
  raw_row_count: number
  refreshed_at: string
  source: 'api'
}

export interface KpiUpsertPlan {
  ok: boolean
  payload: KpiUpsertRow[]        // CHỈ dùng khi ok=true
  periods: Record<KpiGrain, number>
  missing: string[]              // active OS store thiếu row grain bắt buộc
  duplicates: string[]           // nguồn trùng dòng (raw_row_count!=1 / 2 POS → 1 store)
  unmatched: string[]            // row BQ không match store nào
  rowErrors: string[]            // row hỏng (period/pos thiếu, coercion fail)
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : 0
  }
  return 0
}
// r2.1 (audit P2): phân biệt NULL (hợp lệ → 0đ) với NON-NULL không parse được
// (rác từ nguồn → rowErrors → atomic 422) — không âm thầm biến rác thành 0đ
// trên màn tiền. Trả null = INVALID.
function coerceNum(v: unknown): number | null {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}
// 112.4 (audit P1#2): COUNT(*)/COUNTIF của BigQuery LUÔN là số nguyên >= 0.
// KHÔNG dùng coerceNum cho counter: coerceNum(null) = 0 (quyết định r2.1, vẫn
// đúng cho actual/target) nên một counter null sẽ lọt qua như "0 ô NULL".
// Cũng KHÔNG Math.round: 1.4 mà làm tròn thành 1 thì raw_row_count sai vẫn
// được chấp nhận. Thiếu / null / âm / lẻ ⇒ query hoặc schema đã đổi.
function sourceCounter(v: unknown): number | null {
  if (v === null || v === undefined) return null
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v.trim())
  else return null
  return Number.isInteger(n) && n >= 0 ? n : null
}
const dateStr = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

export function buildKpiUpsertPlan(
  rawRows: Record<string, unknown>[],
  stores: KpiStoreRef[],
  refreshedAt: string,
): KpiUpsertPlan {
  // 3-tier matching giữ nguyên: pos_code → stores.code, pos_name chuẩn hóa →
  // stores.name, fallback POS_CODE_BY_NAME (hành vi cũ của kpi.ts).
  const byName = new Map(stores.map((s) => [normalizeStoreName(s.name), s.id]))
  const byCode = new Map(
    stores.filter((s) => s.code).map((s) => [String(s.code).trim().toUpperCase(), s.id]),
  )
  const labelByStoreId = new Map(stores.map((s) => [s.id, s.code ?? s.name]))

  const missing: string[] = []
  const duplicates = new Set<string>()
  const unmatched = new Set<string>()
  const rowErrors: string[] = []
  const byUpsertKey = new Map<string, KpiUpsertRow>()

  for (const raw of rawRows) {
    const periodType = str(raw.period_type) as KpiGrain | null
    if (!periodType || !KNOWN_GRAINS.includes(periodType)) {
      rowErrors.push(`period_type không hợp lệ: ${String(raw.period_type)}`)
      continue
    }
    const periodStart = dateStr(raw.period_start)
    if (!periodStart) {
      rowErrors.push(`${periodType}: period_start không hợp lệ`)
      continue
    }
    // r2.1 (audit P2): period_end NULL → fallback period_start (hợp lệ);
    // NON-NULL nhưng sai format → lỗi nguồn, không âm thầm fallback.
    const periodEnd = raw.period_end === null || raw.period_end === undefined
      ? periodStart
      : dateStr(raw.period_end)
    if (!periodEnd) {
      rowErrors.push(`${periodType} ${periodStart}: period_end không hợp lệ: ${String(raw.period_end)}`)
      continue
    }

    const posName = str(raw.pos_name)
    const posCode = str(raw.pos_code)?.toUpperCase() ?? null
    const label = posName ?? posCode
    if (!label) {
      rowErrors.push(`${periodType} ${periodStart}: thiếu pos_name/pos_code`)
      continue
    }

    const key = posName ? normalizeStoreName(posName) : ''
    const storeId = (posCode ? byCode.get(posCode) : undefined)
      ?? byName.get(key)
      ?? byCode.get(POS_CODE_BY_NAME[key] ?? '')
    if (!storeId) {
      unmatched.add(posCode ? `${label} (${posCode})` : label)
      continue
    }

    // r1 (P2#3): COUNT(*) thật từ query — nguồn trùng dòng cho cùng kỳ/POS.
    // 112.4: giá trị KHÔNG phải số nguyên >= 0 là lỗi SCHEMA, không phải
    // "nguồn trùng dòng" — tách hai bucket để thông báo không đánh lừa.
    const rawRowCount = sourceCounter(raw.raw_row_count)
    if (rawRowCount === null) {
      rowErrors.push(
        `${periodType} ${periodStart} ${label}: raw_row_count không hợp lệ (=${String(raw.raw_row_count)}) — COUNT(*) phải là số nguyên >= 0; query hoặc schema đã đổi`,
      )
      continue
    }
    if (rawRowCount !== 1) {
      duplicates.add(`${periodType} ${periodStart} ${label}: ${rawRowCount} dòng nguồn`)
      continue
    }

    // ── CONTRACT A+ (112.4, chốt 04/09 sau khi BI nạp tháng 9) ──────────────
    // Counter NULL là đường DUY NHẤT nhìn thấy ô trống: SUM() của BigQuery bỏ
    // qua NULL nên một khoá thiếu dữ liệu vẫn cho tổng trông hợp lệ.
    // Ngữ nghĩa (đo trên toàn view 04/09): view mã hoá "không phát sinh giao
    // dịch" bằng NULL chứ KHÔNG bằng số 0 — 0/7.139 dòng DAY có giá trị 0,
    // trong khi Tết 16–20/02 có 6–8/27 POS NULL và tháng 9 chưa tới có 25/25.
    //   · doanh thu + số đơn CÙNG NULL → không phát sinh giao dịch → 0đ HỢP LỆ
    //     (SUM() trả NULL, coerceNum đưa về 0 — ở đây chỉ cần KHÔNG chặn).
    //   · CHỈ MỘT field NULL → nguồn tự mâu thuẫn → fail-closed.
    // Siết KIỂU trước: thiếu field / null / âm / số lẻ / lớn hơn số dòng nguồn
    // đều là schema drift, KHÔNG được coerce về 0.
    // ⚠ Landing KHÔNG có gate "toàn bộ POS cùng NULL ở ngày ĐÃ KẾT THÚC" (gate
    // ETL nằm ở campaign daily — lib/kpi/offlineSource): hai grain của landing
    // luôn là kỳ ĐANG DIỄN RA, nên 25/25 POS NULL lúc 00:05 là số ĐÚNG (chưa
    // bán gì), không phải sự cố. Cũng vì thế không phát warning ở đây — sẽ là
    // 25 dòng nhiễu mỗi đêm.
    const revNullRaw = raw.offline_revenue_null_count
    const ordNullRaw = raw.offline_order_null_count
    const revNull = sourceCounter(revNullRaw)
    const ordNull = sourceCounter(ordNullRaw)
    if (revNull === null || ordNull === null || revNull > rawRowCount || ordNull > rawRowCount) {
      rowErrors.push(
        `${periodType} ${periodStart} ${label}: counter NULL không hợp lệ (offline_revenue_null_count=${String(revNullRaw)}, offline_order_null_count=${String(ordNullRaw)}, raw_row_count=${rawRowCount}) — COUNTIF phải là số nguyên trong [0, raw_row_count]; query hoặc schema đã đổi`,
      )
      continue
    }
    // Luật TIỀN, giống hệt campaign daily (lib/kpi/offlineSource):
    //   revNull = 0                      → doanh thu ĐÃ BIẾT, dùng bình thường
    //   revNull = ordNull = rawRowCount  → không phát sinh giao dịch → 0đ
    //   revNull > 0 mà ordNull < revNull → CÓ ĐƠN nhưng THIẾU TIỀN → fail-closed
    // Ca cuối là ca nguy hiểm duy nhất: ghi 0đ khi thực tế có giao dịch.
    if (revNull > 0 && ordNull !== revNull) {
      rowErrors.push(
        `${periodType} ${periodStart} ${label}: doanh thu NULL (${revNull}/${rawRowCount} dòng) trong khi số đơn KHÔNG NULL (${ordNull}) — có giao dịch mà thiếu tiền, KHÔNG coi là 0đ`,
      )
      continue
    }

    const upsertKey = `${storeId}|${periodType}|${periodStart}`
    if (byUpsertKey.has(upsertKey)) {
      // 2 POS/pos_name khác nhau map về CÙNG store — cũng là nguồn trùng.
      duplicates.add(`${periodType} ${periodStart} ${labelByStoreId.get(storeId) ?? storeId}: 2 dòng nguồn map về cùng store`)
      continue
    }

    // r2.1 (audit P2): actual/target NULL → 0 hợp lệ; non-null không parse
    // được → rowErrors (atomic gate chặn toàn bộ).
    const actual = coerceNum(raw.actual)
    if (actual === null) {
      rowErrors.push(`${periodType} ${periodStart} ${label}: actual không parse được: ${String(raw.actual)}`)
      continue
    }
    const target = coerceNum(raw.target)
    if (target === null) {
      rowErrors.push(`${periodType} ${periodStart} ${label}: target không parse được: ${String(raw.target)}`)
      continue
    }
    const hasGoal = target > 0
    byUpsertKey.set(upsertKey, {
      store_id: storeId,
      period_type: periodType,
      period_start: periodStart,
      period_end: periodEnd,
      actual,
      target,
      run_rate: hasGoal ? Math.round((actual / target) * 100 * 100) / 100 : null,
      status: !hasGoal ? null : actual >= target ? 'Achieved' : 'Not Achieved',
      remaining_target: hasGoal ? Math.max(target - actual, 0) : null,
      raw_row_count: rawRowCount,
      refreshed_at: refreshedAt,
      source: 'api',
    })
  }

  // r2 (P1#2): COVERAGE — mỗi active OS store phải có đủ row từng grain bắt
  // buộc. Store biến mất khỏi nguồn (24/25) không còn lọt qua im lặng.
  const payload = [...byUpsertKey.values()]
  const grainsByStore = new Map<string, Set<KpiGrain>>()
  for (const p of payload) {
    if (!grainsByStore.has(p.store_id)) grainsByStore.set(p.store_id, new Set())
    grainsByStore.get(p.store_id)!.add(p.period_type)
  }
  for (const s of stores) {
    for (const grain of REQUIRED_GRAINS) {
      if (!grainsByStore.get(s.id)?.has(grain)) missing.push(`${s.code ?? s.name}/${grain}`)
    }
  }

  const periods: Record<KpiGrain, number> = { day: 0, week: 0, month: 0 }
  for (const p of payload) periods[p.period_type]++

  return {
    ok: missing.length === 0 && duplicates.size === 0 && unmatched.size === 0 && rowErrors.length === 0,
    payload,
    periods,
    missing,
    duplicates: [...duplicates],
    unmatched: [...unmatched],
    rowErrors,
  }
}
