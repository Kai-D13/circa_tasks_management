// BQ-V2 r2 (audit P1#1+#2) — ATOMIC LANDING GATE cho cron pull-kpi-targets,
// tách THUẦN để test được (kpi.ts giữ server-only IO mỏng).
//
// Contract: nguồn gold_buymed_vn2 pre-aggregated → kỳ vọng MỖI active OS
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
    const periodEnd = dateStr(raw.period_end) ?? periodStart

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
    const rawRowCount = Math.round(num(raw.raw_row_count))
    if (rawRowCount !== 1) {
      duplicates.add(`${periodType} ${periodStart} ${label}: ${rawRowCount} dòng nguồn`)
      continue
    }

    const upsertKey = `${storeId}|${periodType}|${periodStart}`
    if (byUpsertKey.has(upsertKey)) {
      // 2 POS/pos_name khác nhau map về CÙNG store — cũng là nguồn trùng.
      duplicates.add(`${periodType} ${periodStart} ${labelByStoreId.get(storeId) ?? storeId}: 2 dòng nguồn map về cùng store`)
      continue
    }

    const actual = num(raw.actual)
    const target = num(raw.target)
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
