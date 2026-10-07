// BigQuery REST client cho CRM-CSKH (SPEC B0 mục 4) — LÕI THUẦN.
//
// Vì sao không dùng runBigQuery() của lib/targets/bigquery.ts: hàm đó chỉ đọc
// trang đầu (maxResults 1000), không pageToken, không poll job chưa xong, không
// tham số ⇒ feed đơn N3 có thể âm thầm bị cắt. Cron KPI giữ nguyên, không sửa.
//
// Hợp đồng với caller:
//   · TẤT CẢ HOẶC KHÔNG: chỉ trả rows khi đã đọc đủ mọi trang và số dòng khớp
//     `totalRows`; mọi lỗi (HTTP, job lỗi, quá hạn, schema lạ, vượt trần dòng)
//     ném `BigQueryError` và KHÔNG trả gì ⇒ caller giữ nguyên snapshot cũ,
//     không bao giờ ghi số 0/thiếu giả (AGENTS.md §4.7).
//   · Tham số NAMED (`@name`) cho mọi GIÁ TRỊ; chỉ tên bảng phải nội suy và
//     được validate ở lib/care/config.ts.
//   · Một hạn tổng (`deadlineMs`) cho cả poll + phân trang; mỗi request còn
//     timeout riêng ⇒ không request nào giữ handler quá hạn.
//
// IO (fetch, token, đồng hồ, sleep) được tiêm qua `BqTransport` để test bằng
// mock; wrapper thật (server-only, xác thực service account) ở ./client.ts.

export type BqScalarType = 'STRING' | 'INT64' | 'NUMERIC' | 'BOOL' | 'DATE' | 'TIMESTAMP'

export type BqParam =
  | { name: string; type: BqScalarType; value: string | number | boolean | null }
  | { name: string; type: 'ARRAY'; arrayType: BqScalarType; values: (string | number | boolean)[] }

export type BqRow = Record<string, string | null>

export interface BqQueryOptions {
  /** Billing project (project_id của service account). */
  projectId: string
  sql: string
  params?: BqParam[]
  /** Dòng tối đa mỗi trang (maxResults). */
  pageSize?: number
  /** Hạn tổng cho toàn bộ truy vấn (poll + mọi trang). */
  deadlineMs?: number
  /** Thời gian long-poll phía BigQuery mỗi request (timeoutMs). */
  pollTimeoutMs?: number
  /** Trần số dòng — vượt ⇒ lỗi, không trả dữ liệu cắt cụt. */
  maxRows?: number
}

export interface BqTransport {
  fetch: typeof fetch
  getToken: () => Promise<string>
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export type BigQueryErrorKind =
  | 'config'     // thiếu/sai cấu hình (service account, tham số)
  | 'http'       // BigQuery/Google trả HTTP lỗi (gồm job lỗi cú pháp/quyền)
  | 'timeout'    // quá hạn tổng hoặc request bị abort
  | 'row_limit'  // kết quả vượt maxRows
  | 'malformed'  // response thiếu jobReference/schema, giá trị lồng, thiếu trang

export class BigQueryError extends Error {
  readonly kind: BigQueryErrorKind
  readonly status?: number
  constructor(kind: BigQueryErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'BigQueryError'
    this.kind = kind
    this.status = status
  }
}

export interface BqQueryResult {
  rows: BqRow[]
  fields: string[]
  totalRows: number
  jobId: string
  pages: number
}

const DEFAULTS = {
  pageSize: 10_000,
  deadlineMs: 120_000,
  pollTimeoutMs: 10_000,
  maxRows: 200_000,
}
// Request HTTP được phép dài hơn long-poll phía server một khoảng đệm.
const REQUEST_SLACK_MS = 15_000
// Nghỉ giữa hai lần poll khi BigQuery trả về sớm mà job chưa xong.
const POLL_BACKOFF_MS = 500
const BASE = 'https://bigquery.googleapis.com/bigquery/v2'

const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

function scalarValue(type: BqScalarType, v: string | number | boolean): string {
  if (type === 'BOOL') return v ? 'true' : 'false'
  if ((type === 'INT64' || type === 'NUMERIC') && typeof v === 'number' && !Number.isFinite(v)) {
    throw new BigQueryError('config', `tham số ${type} không hữu hạn: ${v}`)
  }
  return String(v)
}

/** Dựng `queryParameters` (parameterMode NAMED). Export để test hợp đồng tham số. */
export function buildQueryParameters(params: BqParam[]): unknown[] {
  const seen = new Set<string>()
  return params.map((p) => {
    if (!PARAM_NAME_RE.test(p.name)) throw new BigQueryError('config', `tên tham số không hợp lệ: ${p.name}`)
    if (seen.has(p.name)) throw new BigQueryError('config', `tham số trùng tên: ${p.name}`)
    seen.add(p.name)
    if (p.type === 'ARRAY') {
      return {
        name: p.name,
        parameterType: { type: 'ARRAY', arrayType: { type: p.arrayType } },
        parameterValue: { arrayValues: p.values.map((v) => ({ value: scalarValue(p.arrayType, v) })) },
      }
    }
    return {
      name: p.name,
      parameterType: { type: p.type },
      parameterValue: p.value === null ? {} : { value: scalarValue(p.type, p.value) },
    }
  })
}

interface QueryResponse {
  jobReference?: { projectId?: string; jobId?: string; location?: string }
  jobComplete?: boolean
  schema?: { fields?: { name: string }[] }
  rows?: { f?: { v?: unknown }[] }[]
  totalRows?: string
  pageToken?: string
}

export async function bqQueryAll(transport: BqTransport, opts: BqQueryOptions): Promise<BqQueryResult> {
  const pageSize = opts.pageSize ?? DEFAULTS.pageSize
  const deadlineMs = opts.deadlineMs ?? DEFAULTS.deadlineMs
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULTS.pollTimeoutMs
  const maxRows = opts.maxRows ?? DEFAULTS.maxRows
  if (!opts.projectId) throw new BigQueryError('config', 'thiếu projectId')
  if (!opts.sql.trim()) throw new BigQueryError('config', 'SQL rỗng')

  const deadline = transport.now() + deadlineMs
  const remaining = () => deadline - transport.now()
  const token = await transport.getToken()

  async function call(url: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<QueryResponse> {
    const left = remaining()
    if (left <= 0) throw new BigQueryError('timeout', `quá hạn tổng ${deadlineMs}ms`)
    let res: Response
    try {
      res = await transport.fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(Math.min(left, pollTimeoutMs + REQUEST_SLACK_MS)),
      })
    } catch (err) {
      const name = (err as { name?: string } | null)?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new BigQueryError('timeout', 'request BigQuery bị hủy do quá thời gian')
      }
      throw new BigQueryError('http', `không gọi được BigQuery: ${(err as Error)?.message ?? String(err)}`)
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      throw new BigQueryError('http', `BigQuery HTTP ${res.status}: ${text}`, res.status)
    }
    try {
      return (await res.json()) as QueryResponse
    } catch {
      throw new BigQueryError('malformed', 'response BigQuery không phải JSON')
    }
  }

  // 1) Gửi truy vấn.
  let page = await call(`${BASE}/projects/${encodeURIComponent(opts.projectId)}/queries`, {
    method: 'POST',
    body: {
      query: opts.sql,
      useLegacySql: false,
      timeoutMs: pollTimeoutMs,
      maxResults: pageSize,
      ...(opts.params?.length
        ? { parameterMode: 'NAMED', queryParameters: buildQueryParameters(opts.params) }
        : {}),
    },
  })
  const jobId = page.jobReference?.jobId
  if (!jobId) throw new BigQueryError('malformed', 'response thiếu jobReference.jobId')
  const location = page.jobReference?.location

  const resultsUrl = (pageToken?: string) => {
    const q = new URLSearchParams({ maxResults: String(pageSize), timeoutMs: String(pollTimeoutMs) })
    if (location) q.set('location', location)
    if (pageToken) q.set('pageToken', pageToken)
    return `${BASE}/projects/${encodeURIComponent(opts.projectId)}/queries/${encodeURIComponent(jobId)}?${q}`
  }

  // 2) Poll tới khi job xong (getQueryResults long-poll theo timeoutMs).
  while (!page.jobComplete) {
    if (remaining() <= 0) throw new BigQueryError('timeout', `job ${jobId} chưa xong sau ${deadlineMs}ms`)
    await transport.sleep(Math.min(POLL_BACKOFF_MS, Math.max(0, remaining())))
    page = await call(resultsUrl(), { method: 'GET' })
  }

  // 3) Đọc mọi trang.
  const fields = (page.schema?.fields ?? []).map((f) => f.name)
  if (fields.length === 0) throw new BigQueryError('malformed', 'response thiếu schema')
  const totalRows = Number(page.totalRows ?? 0)
  if (!Number.isSafeInteger(totalRows) || totalRows < 0) {
    throw new BigQueryError('malformed', `totalRows không hợp lệ: ${page.totalRows}`)
  }
  if (totalRows > maxRows) throw new BigQueryError('row_limit', `kết quả ${totalRows} dòng vượt trần ${maxRows}`)

  const rows: BqRow[] = []
  let pages = 0
  for (;;) {
    pages += 1
    for (const r of page.rows ?? []) rows.push(toRow(fields, r))
    if (rows.length > maxRows) throw new BigQueryError('row_limit', `đã đọc ${rows.length} dòng, vượt trần ${maxRows}`)
    if (!page.pageToken) break
    page = await call(resultsUrl(page.pageToken), { method: 'GET' })
  }

  if (rows.length !== totalRows) {
    throw new BigQueryError('malformed', `thiếu dữ liệu: đọc ${rows.length}/${totalRows} dòng`)
  }
  return { rows, fields, totalRows, jobId, pages }
}

function toRow(fields: string[], r: { f?: { v?: unknown }[] }): BqRow {
  const cells = r.f ?? []
  if (cells.length !== fields.length) {
    throw new BigQueryError('malformed', `dòng có ${cells.length} ô, schema có ${fields.length} cột`)
  }
  const out: BqRow = {}
  fields.forEach((name, i) => {
    const v = cells[i]?.v
    if (v === null || v === undefined) out[name] = null
    else if (typeof v === 'string') out[name] = v
    // N3 là bảng phẳng; RECORD/REPEATED ⇒ schema khác hợp đồng ⇒ fail-closed.
    else throw new BigQueryError('malformed', `cột ${name} trả giá trị lồng (RECORD/REPEATED) — ngoài hợp đồng`)
  })
  return out
}
