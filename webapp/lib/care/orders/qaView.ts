// CRM-CSKH B5b.1 — logic THUẦN cho route QA đọc VIEW N3 thật trên localhost (SPEC §B5b "QA đọc VIEW thật").
// Route chỉ tồn tại ở development + UI_CATALOG=1 + Bearer CRON_SECRET; response chỉ có số tổng hợp/mã
// lỗi — KHÔNG ID khách, DHC, timestamp từng đơn, message BigQuery thô hay key.
import type { BqQueryResult } from '../../bigquery/query'
import { parseN3Rows } from './n3'
import {
  assertN3Fields, buildN3SampleSql, careN3ErrorCode, collectN3Orders,
  runN3Preflight, type CareN3RunQuery, type CareN3SourceCode,
} from './source'

type Env = Record<string, string | undefined>

export type CareN3QaGate = { status: 404 } | { status: 401 } | { status: 'ok' }

/** So sánh chuỗi không lộ thời gian theo vị trí ký tự khác nhau (độ dài vẫn lộ — chấp nhận được). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 404 ngoài development hoặc thiếu UI_CATALOG=1 (kể cả khi có secret); 401 thiếu/sai Bearer CRON_SECRET. */
export function careN3QaGate(env: Env, authorization: string | null): CareN3QaGate {
  if (env.NODE_ENV !== 'development' || env.UI_CATALOG !== '1') return { status: 404 }
  const secret = env.CRON_SECRET
  if (!secret || authorization === null || !safeEqual(authorization, `Bearer ${secret}`)) return { status: 401 }
  return { status: 'ok' }
}

export const CARE_N3_QA_READY_NOTE =
  'readyForSync chỉ là kiểm tra TỰ ĐỘNG (đọc được nguồn + không có mốc hoàn tất ở tương lai); KHÔNG phải duyệt đồng bộ ghi công thật — cần đối chiếu 2 DHC mẫu với mốc UTC gốc (< 1 giây, Q-100/SPEC §B5b.3) trước khi bật CARE_SYNC_ENABLED.' as const

/** ID giả chắc chắn không phải khách thật — kiểm đường named params, kỳ vọng 0 dòng. */
export const CARE_N3_QA_FAKE_ID = 'QA-NOT-A-CUSTOMER'

export interface CareN3QaReport {
  /** Đọc được nguồn: mẫu có dữ liệu qua parser + đường tham số chạy. KHÔNG phải điều kiện sync. */
  ok: boolean
  /**
   * ok && freshness.ok. Vẫn chỉ là điều kiện CẦN cho sync: futureCount = 0 lúc ít đơn không chứng minh múi
   * giờ đúng (Q-100 — sau chuẩn hoá B5b.3 vẫn phải đối chiếu 2 DHC mẫu với mốc UTC raw).
   */
  readyForSync: boolean
  /** Diễn giải cố định đi kèm response (PM audit Lô 3): readyForSync KHÔNG phải duyệt đồng bộ/rollout. */
  readyForSyncNote: typeof CARE_N3_QA_READY_NOTE
  code?: CareN3SourceCode
  fields: string[]
  sampleCount: number
  pages: number
  elapsedMs: number
  bytesProcessed: number | null
  paramQuery: { ok: boolean; code?: CareN3SourceCode; rows: number; pages: number; elapsedMs: number }
  /** Q-100: futureCount > 0 ⇒ còn mốc hoàn tất (ĐÃ trừ 7 giờ — B5b.3) ở tương lai. maxAgeMinutes chỉ là metric. */
  freshness: { ok: boolean; code?: CareN3SourceCode; futureCount: number | null; maxAgeMinutes: number | null }
}

/** Ba truy vấn chỉ đọc: mẫu ≤5 dòng qua parser thật · SQL production với ID giả · preflight thời gian. */
export async function runCareN3Qa(table: string, runQuery: CareN3RunQuery, now: () => number = () => Date.now()): Promise<CareN3QaReport> {
  const report: CareN3QaReport = {
    ok: false, readyForSync: false, readyForSyncNote: CARE_N3_QA_READY_NOTE, fields: [], sampleCount: 0, pages: 0, elapsedMs: 0, bytesProcessed: null,
    paramQuery: { ok: false, rows: 0, pages: 0, elapsedMs: 0 },
    freshness: { ok: false, futureCount: null, maxAgeMinutes: null },
  }
  // 1) Mẫu.
  const t1 = now()
  try {
    const r: BqQueryResult = await runQuery(buildN3SampleSql(table), [], { maxRows: 5 })
    report.fields = r.fields // tên cột/alias (không phải dữ liệu khách)
    report.pages = r.pages
    report.bytesProcessed = r.totalBytesProcessed
    assertN3Fields(r.fields)
    const parsed = parseN3Rows(r.rows)
    if (!parsed.ok) report.code = 'parse_failed'
    else if (parsed.orders.length === 0) report.code = 'no_data'
    else report.sampleCount = parsed.orders.length
  } catch (err) {
    report.code = careN3ErrorCode(err)
  }
  report.elapsedMs = now() - t1
  // 2) SQL production qua adapter thật, một khoảng với ID giả.
  const t2 = now()
  try {
    const res = await collectN3Orders(table, [{ customerExternalId: CARE_N3_QA_FAKE_ID, lo: '2026-10-01T00:00:00Z', hi: null }], runQuery)
    report.paramQuery = { ok: res.orders.length === 0, rows: res.orders.length, pages: res.stats.pages, elapsedMs: now() - t2 }
  } catch (err) {
    report.paramQuery = { ok: false, code: careN3ErrorCode(err), rows: 0, pages: 0, elapsedMs: now() - t2 }
  }
  // 3) Preflight thời gian (Q-100).
  try {
    const p = await runN3Preflight(table, runQuery)
    report.freshness = {
      ok: p.futureCount === 0, ...(p.futureCount > 0 ? { code: 'source_time_future' as const } : {}),
      futureCount: p.futureCount, maxAgeMinutes: p.maxAgeMinutes,
    }
  } catch (err) {
    report.freshness = { ok: false, code: careN3ErrorCode(err), futureCount: null, maxAgeMinutes: null }
  }
  // ok = đọc được mẫu có dữ liệu + đường tham số chạy. freshness báo riêng (gate Q-100 trên giờ đã chuẩn hoá).
  report.ok = report.code === undefined && report.sampleCount > 0 && report.paramQuery.ok
  report.readyForSync = report.ok && report.freshness.ok
  return report
}
