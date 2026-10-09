import 'server-only'
import { runBigQueryPaged } from '@/lib/bigquery/client'
import { careBqOrdersTable } from '@/lib/care/config'
import {
  CareN3SourceError, collectN3Orders, runN3Preflight,
  type CareN3FetchResult, type CareN3Preflight, type CareN3RunQuery, type CareN3Window,
} from '@/lib/care/orders/source'

// CRM-CSKH B5b.1 — nối adapter N3 thuần (lib/care/orders/source.ts) với BigQuery thật bằng đúng SA app
// (BQ_SERVICE_ACCOUNT_KEY, scope readonly). Chỉ ĐỌC; không Supabase. Lỗi ⇒ CareN3SourceError (mã an toàn).

export const runN3Query: CareN3RunQuery = (sql, params, opts) => runBigQueryPaged(sql, params, opts)

/** Tên VIEW N3 đã validate; thiếu/sai ⇒ lỗi mã an toàn (không lộ giá trị env). */
export function careN3Table(): string {
  let table: string | null
  try { table = careBqOrdersTable(process.env) } catch { throw new CareN3SourceError('table_invalid') }
  if (!table) throw new CareN3SourceError('table_missing')
  return table
}

/** Hạn tổng mỗi job BigQuery (poll + mọi trang) — mặc định Dev; đo lại ở B6 với volume thật. */
export const CARE_N3_QUERY_DEADLINE_MS = 120_000

export function fetchN3Orders(windows: readonly CareN3Window[], opts: { deadlineMs?: number } = {}): Promise<CareN3FetchResult> {
  return collectN3Orders(careN3Table(), windows, runN3Query, { deadlineMs: opts.deadlineMs ?? CARE_N3_QUERY_DEADLINE_MS })
}

export function preflightN3(): Promise<CareN3Preflight> {
  return runN3Preflight(careN3Table(), runN3Query)
}
