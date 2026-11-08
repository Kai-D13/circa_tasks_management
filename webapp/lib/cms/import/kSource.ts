// CMS S2 (PM spec r1 08/11 §5.1) — đọc bằng chứng quy đổi đơn vị cho kiểm K khi import. Nguồn = view dòng đơn ĐÃ cấu hình cho đồng bộ
// bán (CMS_BQ_SALES_TABLE, tên validate ở lib/cms/config.ts) — không nhận SQL / tên bảng / FQN từ client; giá trị đi bằng THAM SỐ
// (ProductID của chính file, mốc thời gian). Không có view BI mới. Chỉ tổng hợp ProductID × đơn vị (số đếm / tỷ lệ / tổng) — không
// email / mã đơn / người bán xuống trình duyệt hay vào run.
// r1 (PM 08/11 audit SIMPLE-P1-1): trả CÁC CẶP lượng gốc khác nhau (quantity_raw, base_quantity) dạng CHUỖI + số dòng theo ProductID ×
// đơn vị — KHÔNG SAFE_CAST / SAFE_DIVIDE / MIN-MAX tỷ lệ ở SQL (phép chia NUMERIC làm tròn scale 9 từng che hai dòng lệch bù nhau). App
// parse decimal9 chính xác; ô không đọc được (> 9 chữ số lẻ, số mũ, chữ) = dòng lỗi nguồn, KHÔNG làm tròn. Trần dòng = trần CẶP.
// Cổng chi phí: dry-run trước (byte > trần ⇒ KHÔNG chạy, KHÔNG KIỂM ĐƯỢC), chạy thật với maximumBytesBilled = trần, hạn tổng, trần
// dòng (vượt ⇒ lỗi, không lấy một phần), đọc đủ trang (bqQueryAll). Mọi lỗi ⇒ { ok:false, reason } với MÃ cố định (không message thô).
import type { BqParam, BqQueryResult } from '../../bigquery/query'
import { BigQueryError } from '../../bigquery/query'
import { isSafeBqTableName } from '../../care/config'
import { canonicalProductId } from '../productId'
import { cmsKDec, type CmsKEvidence, type CmsKEvidenceRow } from './kCheck'

/** Trần byte cho một lần kiểm K (dry-run + maximumBytesBilled). */
export const CMS_K_BYTES_CAP = 2_000_000_000
/** Trần số CẶP lượng gốc khác nhau (ProductID × đơn vị × quantity × base) — vượt ⇒ KHÔNG KIỂM ĐƯỢC (không lấy một phần). */
export const CMS_K_ROW_CAP = 10_000
/** Hạn tổng (dry-run + chạy + mọi trang) — preview không treo lâu. */
export const CMS_K_DEADLINE_MS = 30_000
/** Cửa sổ dòng bán đọc làm bằng chứng (ngày). */
export const CMS_K_LOOKBACK_DAYS = 366

export interface CmsKProbeIo {
  dryRun(sql: string, params: BqParam[], deadlineMs: number): Promise<number>
  run(sql: string, params: BqParam[], opts: { maxRows: number; deadlineMs: number; maximumBytesBilled: number }): Promise<BqQueryResult>
  now(): number
}

const COLS = ['pid', 'uom', 'q_raw', 'b_raw', 'n_lines'] as const

export function buildCmsKEvidenceQuery(table: string, productIds: readonly string[], fromIso: string): { sql: string; params: BqParam[] } {
  if (!isSafeBqTableName(table)) throw new BigQueryError('config', 'CMS: tên view nguồn không hợp lệ')
  if (productIds.length === 0) throw new BigQueryError('config', 'CMS: không có ProductID để kiểm')
  const sql = [
    'SELECT CAST(product_id AS STRING) AS pid, TRIM(CAST(uom_raw AS STRING)) AS uom,',
    '  TRIM(CAST(quantity_raw AS STRING)) AS q_raw, TRIM(CAST(base_quantity AS STRING)) AS b_raw, CAST(COUNT(*) AS STRING) AS n_lines',
    `FROM \`${table}\``,
    'WHERE completed_at >= @from_ts AND CAST(product_id AS STRING) IN UNNEST(@product_ids)',
    'GROUP BY pid, uom, q_raw, b_raw ORDER BY pid, uom, q_raw, b_raw',
    'LIMIT @row_limit',
  ].join('\n')
  return {
    sql,
    params: [
      { name: 'from_ts', type: 'TIMESTAMP', value: fromIso },
      { name: 'product_ids', type: 'ARRAY', arrayType: 'STRING', values: [...new Set(productIds)].sort() },
      { name: 'row_limit', type: 'INT64', value: CMS_K_ROW_CAP + 1 },
    ],
  }
}

const COUNT_RE = /^[1-9][0-9]{0,14}$/

/**
 * Một cặp kết quả ⇒ CmsKEvidenceRow. ProductID / số dòng sai dạng ⇒ null (cả lần đọc KHÔNG KIỂM ĐƯỢC — fail-closed). quantity / base
 * rỗng hoặc không phải decimal9 chính xác ⇒ q / b = null (DÒNG LỖI của SP đó — classifier báo NGUỒN LỖI), không làm tròn, không bỏ.
 */
export function normalizeCmsKEvidenceRow(r: Record<string, string | null>): CmsKEvidenceRow | null {
  const pid = canonicalProductId(r.pid ?? null)
  if (!pid.ok || !COUNT_RE.test(r.n_lines ?? '')) return null
  return { productId: pid.id, uomRaw: r.uom ?? '', q: cmsKDec(r.q_raw), b: cmsKDec(r.b_raw), lines: BigInt(r.n_lines!) }
}

export async function fetchCmsKEvidence(io: CmsKProbeIo, a: { table: string | null; productIds: readonly string[]; deadlineMs?: number; bytesCap?: number }): Promise<CmsKEvidence> {
  if (!a.table) return { ok: false, reason: 'CONFIG' }
  const startedAt = io.now()
  const deadline = startedAt + (a.deadlineMs ?? CMS_K_DEADLINE_MS)
  const cap = a.bytesCap ?? CMS_K_BYTES_CAP
  let q: ReturnType<typeof buildCmsKEvidenceQuery>
  try {
    q = buildCmsKEvidenceQuery(a.table, a.productIds, new Date(startedAt - CMS_K_LOOKBACK_DAYS * 86_400_000).toISOString())
  } catch { return { ok: false, reason: 'CONFIG' } }
  const fail = (e: unknown): CmsKEvidence => ({ ok: false, reason: e instanceof BigQueryError ? `SOURCE_${e.kind.toUpperCase()}` : 'SOURCE_UNKNOWN' })
  let bytes: number
  try { bytes = await io.dryRun(q.sql, q.params, Math.max(1, deadline - io.now())) } catch (e) { return fail(e) }
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, reason: 'SOURCE_MALFORMED' }
  if (bytes > cap) return { ok: false, reason: 'BYTE_CAP' }
  const left = deadline - io.now()
  if (left <= 0) return { ok: false, reason: 'SOURCE_TIMEOUT' }
  let res: BqQueryResult
  try { res = await io.run(q.sql, q.params, { maxRows: CMS_K_ROW_CAP, deadlineMs: left, maximumBytesBilled: cap }) } catch (e) { return fail(e) }
  const have = new Set(res.fields)
  if (COLS.some((c) => !have.has(c))) return { ok: false, reason: 'SOURCE_SCHEMA' }
  if (res.rows.length !== res.totalRows || res.rows.length > CMS_K_ROW_CAP) return { ok: false, reason: 'SOURCE_INCOMPLETE' }
  const rows: CmsKEvidenceRow[] = []
  for (const raw of res.rows) {
    const n = normalizeCmsKEvidenceRow(raw)
    if (!n) return { ok: false, reason: 'SOURCE_MALFORMED' }
    rows.push(n)
  }
  return { ok: true, asOf: new Date(startedAt).toISOString(), rows }
}
