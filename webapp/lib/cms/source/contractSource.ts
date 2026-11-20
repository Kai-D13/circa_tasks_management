// CMS-CALC-RET-2 P3 — provider nguồn của RUN CONTRACT (thiết kế Dev r2 §4.3; plan PM 13/11 §2 "giao diện nguồn cố định").
// Thuần: nhận runner BigQuery tiêm vào (thật: source/bigqueryRunner.ts; test: transport giả đi qua bqQueryAll). Nguyên tắc:
//  · MỘT query job: `(bán 'S') UNION ALL (trả 'R')`, cùng một bố cục cột chuỗi ⇒ bán + trả cùng snapshot của chính job đó (không query
//    hai lần rồi coi là cùng snapshot). Mọi trang đọc từ kết quả của job (bqQueryAll theo jobId + pageToken, đếm = totalRows).
//  · Chỉ chương trình đọc trả (net_returns_v1 / full_line_qty_refund_v1 — Q-236, cùng projection 20 cột) mới đọc phần 'R'. Sales-only ⇒ job chỉ có phần 'S', kết quả `returnsRaw = null` (không phải []).
//  · Lọc: bán theo kỳ + ProductID + completed_at ≤ as_of; trả theo NGÀY BÁN GỐC + ProductID + (recorded_at NULL hoặc ≤ as_of). Phiếu
//    APPROVED (recorded_at NULL) vẫn đọc — engine biết là chưa hiệu lực; trạng thái lạ để normalizer HOLD, không lọc ở SQL.
//  · RET2-SRC-01 (PM audit r4 14/11): phiếu THIẾU ngữ cảnh phạm vi (ngày bán gốc NULL và / hoặc ProductID NULL / rỗng) KHÔNG bị WHERE
//    loại — vẫn vào job để normalizer HOLD (không bao giờ thành "0 phiếu trả"). Chỉ loại khi chắc chắn ngoài phạm vi: ProductID có thật
//    nhưng ngoài chương trình; ngày bán gốc có thật nhưng ngoài kỳ; ghi nhận trả TRƯỚC đầu kỳ (không thể là trả của dòng bán trong kỳ);
//    hoặc trạng thái đã biết là chưa hiệu lực (APPROVED — normalizer chỉ giữ ID + trạng thái, không tác động tiền; baseline đổi sang
//    trạng thái đó mà mất ngữ cảnh ⇒ vắng khỏi snapshot ⇒ sổ MISSING ⇒ held). Trạng thái lạ / NULL luôn được đọc. Cùng luật ở
//    cmsContractReturnInScope (fixture dùng chung).
//  · Tên view chỉ từ env đã validate; mọi giá trị khác là query parameter. Không hardcode FQN trả hàng giả (plan §2.1).
//  · Lỗi ⇒ mã cố định (NOT_CONFIGURED / PERMISSION_DENIED / CONTRACT_MISMATCH / INCOMPLETE / OVER_CAP / BYTES_LIMIT / TIMEOUT /
//    SOURCE_ERROR) — KHÔNG BAO GIỜ thành `{returns: []}`. Không mang message thô của BigQuery (có thể chứa giá trị dòng / tên view):
//    với HTTP 400 chỉ đọc đúng token `reason` cố định (invalidQuery / bytesBilledLimitExceeded…).
//  · Rỗng hợp lệ chỉ khi job thành công + đủ cột + đủ trang + jobId có thật.
// Fixture provider (QA / chương trình is_test) ở e2e/cmsContractFixture.ts — production không tự fallback.

import { BigQueryError, type BqParam, type BqQueryResult } from '../../bigquery/query'
import { isSafeBqTableName } from '../../care/config'
import type { CmsReturnProfile } from '../calc/policy'
import { CMS_RETURN_COLUMNS, CMS_RETURN_STATUS_DICTIONARY, cmsReturnNotEffectiveStatuses } from '../calc/returns'
import { CMS_SALES_ROW_CAP } from '../quality'
import { formatUtcMicros, parseUtcMicros } from '../time'
import { CMS_BQ_DEFAULT_DEADLINE_MS, CMS_SALES_SOURCE_COLUMN, type CmsBqRunner } from './bigquery'
import { CMS_SALES_COLUMNS, type CmsRawRow } from './contract'

/** Phiên bản bố cục truy vấn (đổi cột / lọc ⇒ tăng). */
export const CMS_CONTRACT_SOURCE_LAYOUT = 'cms-contract-source-v2'
/** Trần phiếu trả / chương trình / lượt (cùng trần báo cáo sau chốt). Vượt ⇒ OVER_CAP, không lấy một phần. */
export const CMS_CONTRACT_RETURNS_ROW_CAP = 100_000
/** Trạng thái đã biết là CHƯA hiệu lực (từ điển trả v1) — chỉ dùng loại phiếu THIẾU ngữ cảnh phạm vi (RET2-SRC-01). */
export const CMS_RETURN_NOT_EFFECTIVE_STATUSES: readonly string[] = [...CMS_RETURN_STATUS_DICTIONARY]
  .filter(([, e]) => e === 'NOT_EFFECTIVE').map(([s]) => s).sort()

/**
 * Cột VẬT LÝ của view trả hàng khi khác tên chuẩn. BI chưa giao FQN / tên cột cuối (plan §2.1) ⇒ rỗng = view dùng đúng tên chuẩn
 * CMS_RETURN_COLUMNS. Đổi tên DUY NHẤT ở SELECT / WHERE như CMS_SALES_SOURCE_COLUMN.
 */
export const CMS_RETURN_SOURCE_COLUMN: Readonly<Partial<Record<(typeof CMS_RETURN_COLUMNS)[number], string>>> = {}

const SALES_TS = new Set(['completed_at', 'source_updated_at'])
const RETURN_TS = new Set(['return_recorded_at', 'original_completed_at', 'source_updated_at'])
const SALES_SET = new Set<string>(CMS_SALES_COLUMNS)
const RETURN_SET = new Set<string>(CMS_RETURN_COLUMNS)

/** Bố cục cột chung của job: src_kind + cột bán + cột chỉ có ở trả (product_id / source_updated_at dùng chung). */
export const CMS_CONTRACT_SOURCE_COLUMNS: readonly string[] = [
  'src_kind', ...CMS_SALES_COLUMNS, ...CMS_RETURN_COLUMNS.filter((c) => !SALES_SET.has(c)),
]

export type CmsContractSourceCode =
  | 'NOT_CONFIGURED' | 'PERMISSION_DENIED' | 'CONTRACT_MISMATCH' | 'INCOMPLETE' | 'OVER_CAP' | 'BYTES_LIMIT' | 'TIMEOUT' | 'SOURCE_ERROR'

export interface CmsContractSourceFailure {
  ok: false
  code: CmsContractSourceCode
  /** Phần gây lỗi khi xác định được. */
  part?: 'sales' | 'returns' | 'job'
  /** Chỉ tên cột / số đếm / HTTP status — không giá trị dòng. */
  missing?: string[]
  status?: number | null
  read?: number | null
  total?: number | null
  cap?: number
}

export interface CmsContractScope {
  fromMicros: bigint
  toMicrosExclusive: bigint
  /** ProductID canonical của chương trình (≥ 1). */
  productIds: readonly string[]
  /** Mốc snapshot (µs UTC) — worker chọn TRƯỚC khi gửi job; phiếu trả sau mốc không đọc. */
  asOfMicros: bigint
  /** true ⇔ chương trình đọc trả (net_returns_v1 / full_line_qty_refund_v1). */
  withReturns: boolean
  /**
   * Profile của phần trả (từ điển trạng thái dùng trong luật phạm vi RET2-SRC-01). Bỏ trống ⇒ net_returns_v1 (từ điển v1). Projection
   * không đổi theo profile.
   */
  returnsProfile?: CmsReturnProfile
  deadlineMs?: number
}

export interface CmsContractSourceReady {
  ok: true
  provider: 'bq' | 'fixture'
  /** Đúng MỘT trong hai: job BigQuery / snapshot BI materialize (fixture dùng snapshotId). */
  jobId?: string
  snapshotId?: string
  asOfMicros: bigint
  /** Dòng bán thô (cột CMS_SALES_COLUMNS) theo thứ tự kết quả job. */
  salesRaw: CmsRawRow[]
  /** Phiếu trả thô (cột CMS_RETURN_COLUMNS); null ⇔ phạm vi sales-only (không đọc phần 'R'). */
  returnsRaw: CmsRawRow[] | null
  bytesProcessed: number | null
}

export type CmsContractSourceResult = CmsContractSourceReady | CmsContractSourceFailure

export interface CmsContractSourceProvider {
  readonly kind: 'bq' | 'fixture'
  read(scope: CmsContractScope): Promise<CmsContractSourceResult>
}

export interface CmsContractQueryArgs {
  salesTable: string
  /** null ⇔ sales-only. */
  returnsTable: string | null
  fromMicros: bigint
  toMicrosExclusive: bigint
  productIds: readonly string[]
  asOfMicros: bigint
  salesCap?: number
  returnsCap?: number
  /** Trạng thái chưa hiệu lực đã biết của từ điển run (RET2-SRC-01). Bỏ trống ⇒ từ điển v1. */
  notEffectiveStatuses?: readonly string[]
}

const TS = (expr: string, as: string) => `FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', ${expr}, 'UTC') AS ${as}`
const STR = (expr: string, as: string) => `CAST(${expr} AS STRING) AS ${as}`
const NUL = (as: string) => `CAST(NULL AS STRING) AS ${as}`
const salesCol = (c: string) => CMS_SALES_SOURCE_COLUMN[c as (typeof CMS_SALES_COLUMNS)[number]] ?? c
const returnCol = (c: string) => CMS_RETURN_SOURCE_COLUMN[c as (typeof CMS_RETURN_COLUMNS)[number]] ?? c

function badConfig(): never {
  // Không đưa tên view vào message (hạ tầng nội bộ).
  throw new BigQueryError('config', 'CMS contract: cấu hình nguồn không hợp lệ')
}

/** SQL + tham số của MỘT job. Ném BigQueryError('config') khi cấu hình / phạm vi sai (caller ⇒ NOT_CONFIGURED). */
export function buildCmsContractQuery(a: CmsContractQueryArgs): { sql: string; params: BqParam[]; salesCap: number; returnsCap: number } {
  if (!isSafeBqTableName(a.salesTable)) badConfig()
  if (a.returnsTable !== null && !isSafeBqTableName(a.returnsTable)) badConfig()
  if (a.productIds.length === 0 || a.toMicrosExclusive <= a.fromMicros) badConfig()
  const salesCap = a.salesCap ?? CMS_SALES_ROW_CAP
  const returnsCap = a.returnsCap ?? CMS_CONTRACT_RETURNS_ROW_CAP
  if (!Number.isSafeInteger(salesCap) || salesCap < 1 || !Number.isSafeInteger(returnsCap) || returnsCap < 1) badConfig()
  const salesSelect = CMS_CONTRACT_SOURCE_COLUMNS.map((c) => {
    if (c === 'src_kind') return `'S' AS src_kind`
    if (!SALES_SET.has(c)) return NUL(c)
    return SALES_TS.has(c) ? TS(salesCol(c), c) : STR(salesCol(c), c)
  })
  const parts = [
    '(',
    `SELECT ${salesSelect.join(', ')}`,
    `FROM \`${a.salesTable}\``,
    `WHERE ${salesCol('completed_at')} >= @from_ts AND ${salesCol('completed_at')} < @to_ts AND ${salesCol('completed_at')} <= @as_of`,
    `  AND CAST(${salesCol('product_id')} AS STRING) IN UNNEST(@product_ids)`,
    'LIMIT @sales_limit',
    ')',
  ]
  if (a.returnsTable !== null) {
    const retSelect = CMS_CONTRACT_SOURCE_COLUMNS.map((c) => {
      if (c === 'src_kind') return `'R' AS src_kind`
      if (!RETURN_SET.has(c)) return NUL(c)
      return RETURN_TS.has(c) ? TS(returnCol(c), c) : STR(returnCol(c), c)
    })
    const oc = returnCol('original_completed_at'), rr = returnCol('return_recorded_at')
    const pid = `CAST(${returnCol('product_id')} AS STRING)`, st = `CAST(${returnCol('return_status')} AS STRING)`
    const pidMissing = `NULLIF(TRIM(${pid}), '') IS NULL`
    parts.push(
      'UNION ALL',
      '(',
      `SELECT ${retSelect.join(', ')}`,
      `FROM \`${a.returnsTable}\``,
      `WHERE (${rr} IS NULL OR ${rr} <= @as_of)`,
      // (1) đủ ngữ cảnh, trong phạm vi.
      `  AND ((${oc} >= @from_ts AND ${oc} < @to_ts AND ${pid} IN UNNEST(@product_ids))`,
      // (2) RET2-SRC-01: thiếu ngày bán gốc / ProductID — giữ để normalizer HOLD, trừ khi chắc chắn ngoài phạm vi.
      `    OR ((${oc} IS NULL OR ${pidMissing})`,
      `        AND (${pidMissing} OR ${pid} IN UNNEST(@product_ids))`,
      `        AND (${oc} IS NULL OR (${oc} >= @from_ts AND ${oc} < @to_ts))`,
      `        AND (${rr} IS NULL OR ${rr} >= @from_ts)`,
      `        AND (${st} IS NULL OR ${st} NOT IN UNNEST(@not_effective_statuses))))`,
      'LIMIT @returns_limit',
      ')',
    )
  }
  const params: BqParam[] = [
    { name: 'from_ts', type: 'TIMESTAMP', value: formatUtcMicros(a.fromMicros) },
    { name: 'to_ts', type: 'TIMESTAMP', value: formatUtcMicros(a.toMicrosExclusive) },
    { name: 'as_of', type: 'TIMESTAMP', value: formatUtcMicros(a.asOfMicros) },
    { name: 'product_ids', type: 'ARRAY', arrayType: 'STRING', values: [...new Set(a.productIds)].sort() },
    // cap + 1 để PHÁT HIỆN vượt trần thay vì lặng lẽ cắt.
    { name: 'sales_limit', type: 'INT64', value: salesCap + 1 },
  ]
  if (a.returnsTable !== null) {
    params.push({ name: 'returns_limit', type: 'INT64', value: returnsCap + 1 },
      { name: 'not_effective_statuses', type: 'ARRAY', arrayType: 'STRING',
        values: [...(a.notEffectiveStatuses ?? CMS_RETURN_NOT_EFFECTIVE_STATUSES)].sort() })
  }
  return { sql: parts.join('\n'), params, salesCap, returnsCap }
}

/**
 * Luật phạm vi nhánh trả của job (GIỐNG WHERE ở buildCmsContractQuery) trên dòng thô dạng chuỗi — fixture provider dùng chung; test đối
 * chiếu với chính WHERE sinh ra chạy trên Postgres. Thời điểm không đọc được (chỉ có ở fixture; cột BigQuery là TIMESTAMP) ⇒ coi như
 * chưa biết (fail-closed: vẫn đọc để normalizer HOLD).
 */
export function cmsContractReturnInScope(
  r: CmsRawRow, s: { fromMicros: bigint; toMicrosExclusive: bigint; asOfMicros: bigint; productIds: ReadonlySet<string>;
    returnsProfile?: CmsReturnProfile },
): boolean {
  const at = (v: unknown): bigint | null => (v === null || v === undefined ? null : parseUtcMicros(String(v)))
  const rec = at(r.return_recorded_at), oc = at(r.original_completed_at)
  if (rec !== null && rec > s.asOfMicros) return false
  const pidRaw = r.product_id === null || r.product_id === undefined ? null : String(r.product_id)
  const pidMissing = pidRaw === null || pidRaw.trim() === ''
  const inSet = pidRaw !== null && s.productIds.has(pidRaw)
  const inWin = oc !== null && oc >= s.fromMicros && oc < s.toMicrosExclusive
  if (inWin && inSet) return true
  if (oc !== null && !pidMissing) return false
  if (!pidMissing && !inSet) return false
  if (oc !== null && !inWin) return false
  if (rec !== null && rec < s.fromMicros) return false
  const st = r.return_status === null || r.return_status === undefined ? null : String(r.return_status)
  const ne = s.returnsProfile ? cmsReturnNotEffectiveStatuses(s.returnsProfile) : CMS_RETURN_NOT_EFFECTIVE_STATUSES
  return st === null || !ne.includes(st)
}

// Token `reason` cố định trong body lỗi 400 của BigQuery (không đọc / không trả phần còn lại của message).
const REASON_RE = /"reason"\s*:\s*"(invalidQuery|bytesBilledLimitExceeded|accessDenied|notFound)"/

/** BigQueryError ⇒ mã cố định. */
export function cmsContractSourceErrorCode(e: unknown): { code: CmsContractSourceCode; status: number | null } {
  if (!(e instanceof BigQueryError)) return { code: 'SOURCE_ERROR', status: null }
  const status = typeof e.status === 'number' ? e.status : null
  if (e.kind === 'config') return { code: 'NOT_CONFIGURED', status }
  if (e.kind === 'timeout') return { code: 'TIMEOUT', status }
  if (e.kind === 'row_limit') return { code: 'OVER_CAP', status }
  if (e.kind === 'malformed') return { code: 'INCOMPLETE', status }
  if (status === 401 || status === 403) return { code: 'PERMISSION_DENIED', status }
  if (status === 404) return { code: 'NOT_CONFIGURED', status }
  if (status === 400) {
    const reason = REASON_RE.exec(String(e.message))?.[1]
    if (reason === 'bytesBilledLimitExceeded') return { code: 'BYTES_LIMIT', status }
    if (reason === 'accessDenied') return { code: 'PERMISSION_DENIED', status }
    if (reason === 'notFound') return { code: 'NOT_CONFIGURED', status }
    if (reason === 'invalidQuery') return { code: 'CONTRACT_MISMATCH', status }
  }
  return { code: 'SOURCE_ERROR', status }
}

/** Tách kết quả job thành bán / trả + kiểm cấu trúc (đủ cột, jobId, đủ dòng, nhãn phần, trần từng phần). */
export function splitCmsContractResult(result: BqQueryResult, withReturns: boolean, salesCap: number, returnsCap: number):
  { ok: true; salesRaw: CmsRawRow[]; returnsRaw: CmsRawRow[] | null } | CmsContractSourceFailure {
  const have = new Set(result.fields)
  const missing = CMS_CONTRACT_SOURCE_COLUMNS.filter((c) => !have.has(c))
  if (missing.length) return { ok: false, code: 'CONTRACT_MISMATCH', part: 'job', missing }
  if (typeof result.jobId !== 'string' || result.jobId.trim() === '') return { ok: false, code: 'INCOMPLETE', part: 'job' }
  if (result.rows.length !== result.totalRows) {
    return { ok: false, code: 'INCOMPLETE', part: 'job', read: result.rows.length, total: result.totalRows }
  }
  const salesRaw: CmsRawRow[] = []
  const returnsRaw: CmsRawRow[] = []
  for (const r of result.rows) {
    const k = r.src_kind
    if (k === 'S') salesRaw.push(Object.fromEntries(CMS_SALES_COLUMNS.map((c) => [c, r[c] ?? null])))
    else if (k === 'R' && withReturns) returnsRaw.push(Object.fromEntries(CMS_RETURN_COLUMNS.map((c) => [c, r[c] ?? null])))
    // Nhãn lạ / phần trả trong job sales-only ⇒ kết quả không phải job của bố cục này.
    else return { ok: false, code: 'CONTRACT_MISMATCH', part: 'job' }
  }
  if (salesRaw.length > salesCap) return { ok: false, code: 'OVER_CAP', part: 'sales', cap: salesCap }
  if (returnsRaw.length > returnsCap) return { ok: false, code: 'OVER_CAP', part: 'returns', cap: returnsCap }
  return { ok: true, salesRaw, returnsRaw: withReturns ? returnsRaw : null }
}

export interface CmsBqContractProviderConfig {
  runner: CmsBqRunner
  salesTable: string | null
  /** FQN view trả (CMS_BQ_RETURNS_TABLE); null = chưa cấu hình ⇒ phạm vi net trả NOT_CONFIGURED, KHÔNG truy vấn. */
  returnsTable: string | null
  /** Trần byte BigQuery tự chặn (maximumBytesBilled); undefined = không đặt (như nguồn bán hiện hành). */
  maxBytesBilled?: number
  salesCap?: number
  returnsCap?: number
}

/** Provider BigQuery production. */
export function createCmsBqContractProvider(cfg: CmsBqContractProviderConfig): CmsContractSourceProvider {
  return {
    kind: 'bq',
    async read(scope) {
      if (cfg.salesTable === null) return { ok: false, code: 'NOT_CONFIGURED', part: 'sales' }
      if (scope.withReturns && cfg.returnsTable === null) return { ok: false, code: 'NOT_CONFIGURED', part: 'returns' }
      let q: ReturnType<typeof buildCmsContractQuery>
      try {
        q = buildCmsContractQuery({
          salesTable: cfg.salesTable, returnsTable: scope.withReturns ? cfg.returnsTable : null, fromMicros: scope.fromMicros,
          toMicrosExclusive: scope.toMicrosExclusive, productIds: scope.productIds, asOfMicros: scope.asOfMicros,
          salesCap: cfg.salesCap, returnsCap: cfg.returnsCap,
          notEffectiveStatuses: cmsReturnNotEffectiveStatuses(scope.returnsProfile ?? 'net_returns_v1'),
        })
      } catch {
        return { ok: false, code: 'NOT_CONFIGURED', part: 'job' }
      }
      let result: BqQueryResult
      try {
        result = await cfg.runner(q.sql, q.params, {
          maxRows: q.salesCap + 1 + (scope.withReturns ? q.returnsCap + 1 : 0),
          deadlineMs: scope.deadlineMs ?? CMS_BQ_DEFAULT_DEADLINE_MS,
          ...(cfg.maxBytesBilled !== undefined ? { maximumBytesBilled: cfg.maxBytesBilled } : {}),
        })
      } catch (e) {
        const m = cmsContractSourceErrorCode(e)
        return { ok: false, code: m.code, part: 'job', status: m.status }
      }
      const s = splitCmsContractResult(result, scope.withReturns, q.salesCap, q.returnsCap)
      if (!s.ok) return s
      return {
        ok: true, provider: 'bq', jobId: result.jobId, asOfMicros: scope.asOfMicros, salesRaw: s.salesRaw, returnsRaw: s.returnsRaw,
        bytesProcessed: result.totalBytesProcessed,
      }
    },
  }
}
