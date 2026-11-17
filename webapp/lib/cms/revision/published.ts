// r3 (PM P1-03) — đọc "số đã công bố" của run pointer cho dự toán sửa chương trình, FAIL-CLOSED. Lõi thuần: I/O qua reader tiêm
// (route nối service role thật; harness PGlite nối SQL cùng cột / lọc / thứ tự). Mọi sai lệch ⇒ ném CmsPublishedUnavailable — impact
// chuyển status 'error' (PUBLISHED_UNAVAILABLE), DB không cho ghi; KHÔNG bao giờ trả số 0 giả cho người thiếu dòng do đọc cụt.
//   header: đúng run + chương trình, kind 'sales', status 'ok' + published_at, chưa purge, amount_vnd nguyên ≥ 0, số dòng niêm phong
//           (seal_expect.results) nguyên ≥ 0, config_version nguyên ≥ 1;
//   trang:  xếp (user_id, program_product_id) TĂNG NGẶT xuyên trang (trang lặp / chồng / đảo ⇒ lỗi), mỗi dòng UUID + amount nguyên ≥ 0;
//   khớp:   tổng số dòng = số niêm phong, Σ amount = amount header; đọc lại header cuối — purge bắt đầu trong lúc đọc ⇒ lỗi.
// Header 0 thật + 0 dòng ⇒ hợp lệ (tổng 0, map rỗng). Không có run (pointer NULL) do impact xử lý (NULL, không gọi reader).

export const CMS_PUBLISHED_PAGE = 1000
export const CMS_PUBLISHED_MAX_PAGES = 500

export type CmsPublishedFailure =
  | 'RUN_MISSING' | 'RUN_PROGRAM_MISMATCH' | 'RUN_KIND' | 'RUN_NOT_PUBLISHED' | 'RUN_PURGED' | 'RUN_HEADER_INVALID'
  | 'ROW_INVALID' | 'ROWS_ORDER' | 'ROWS_COUNT_MISMATCH' | 'ROWS_SUM_MISMATCH' | 'ROWS_TOO_MANY' | 'READ_FAILED'

export class CmsPublishedUnavailable extends Error {
  constructor(public readonly reason: CmsPublishedFailure) { super(`PUBLISHED_UNAVAILABLE:${reason}`) }
}

export interface CmsPublishedReader {
  /** Một dòng cms_sync_runs (id, program_id, kind, status, published_at, purged_at, amount_vnd text, config_version,
   *  results_expected = seal_expect->>'results') hoặc null. Ném khi lỗi đọc. */
  header(runId: string): Promise<unknown>
  /** Dòng cms_results của run, ORDER BY user_id, program_product_id, lấy [from, to] (gồm hai đầu). Ném khi lỗi đọc. */
  page(runId: string, from: number, to: number): Promise<unknown[]>
}

export interface CmsPublishedLoad {
  amountVnd: string
  byUser: Map<string, bigint>
  configVersion: number
  publishedAt: string
  rows: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UINT_RE = /^(0|[1-9][0-9]{0,18})$/
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const uint = (x: unknown): string | null => {
  const s = typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? String(x) : typeof x === 'string' ? x : null
  return s !== null && UINT_RE.test(s) ? s : null
}

interface Header { amount: bigint; amountText: string; expected: number; configVersion: number; publishedAt: string }

function checkHeader(raw: unknown, programId: string, runId: string): Header {
  if (raw === null || raw === undefined) throw new CmsPublishedUnavailable('RUN_MISSING')
  if (!isObj(raw) || raw.id !== runId) throw new CmsPublishedUnavailable('RUN_HEADER_INVALID')
  if (raw.program_id !== programId) throw new CmsPublishedUnavailable('RUN_PROGRAM_MISMATCH')
  if (raw.kind !== 'sales') throw new CmsPublishedUnavailable('RUN_KIND')
  if (raw.status !== 'ok' || typeof raw.published_at !== 'string' || raw.published_at === '') throw new CmsPublishedUnavailable('RUN_NOT_PUBLISHED')
  if (raw.purged_at !== null && raw.purged_at !== undefined) throw new CmsPublishedUnavailable('RUN_PURGED')
  const amountText = uint(raw.amount_vnd)
  const expected = uint(raw.results_expected)
  const cv = raw.config_version
  if (amountText === null || expected === null || !Number.isSafeInteger(Number(expected)) || typeof cv !== 'number' || !Number.isSafeInteger(cv) || cv < 1) {
    throw new CmsPublishedUnavailable('RUN_HEADER_INVALID')
  }
  return { amount: BigInt(amountText), amountText, expected: Number(expected), configVersion: cv, publishedAt: raw.published_at }
}

export async function cmsLoadPublished(reader: CmsPublishedReader, programId: string, runId: string,
  opts: { pageSize?: number; maxPages?: number } = {}): Promise<CmsPublishedLoad> {
  const pageSize = opts.pageSize ?? CMS_PUBLISHED_PAGE
  const maxPages = opts.maxPages ?? CMS_PUBLISHED_MAX_PAGES
  const read = async <T>(f: () => Promise<T>): Promise<T> => {
    try { return await f() } catch (e) { if (e instanceof CmsPublishedUnavailable) throw e; throw new CmsPublishedUnavailable('READ_FAILED') }
  }
  const h = checkHeader(await read(() => reader.header(runId)), programId, runId)
  const byUser = new Map<string, bigint>()
  let sum = BigInt(0)
  let rows = 0
  let prev: string | null = null
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new CmsPublishedUnavailable('ROWS_TOO_MANY')
    const data = await read(() => reader.page(runId, page * pageSize, page * pageSize + pageSize - 1))
    if (!Array.isArray(data) || data.length > pageSize) throw new CmsPublishedUnavailable('READ_FAILED')
    for (const x of data) {
      if (!isObj(x) || typeof x.user_id !== 'string' || !UUID_RE.test(x.user_id) || typeof x.program_product_id !== 'string'
          || !UUID_RE.test(x.program_product_id)) throw new CmsPublishedUnavailable('ROW_INVALID')
      const a = uint(x.amount_vnd)
      if (a === null) throw new CmsPublishedUnavailable('ROW_INVALID')
      // UUID chữ thường cùng vị trí gạch ⇒ so chuỗi = so byte của Postgres. Tăng NGẶT ⇒ không trùng / chồng / lặp trang.
      const key = `${x.user_id}|${x.program_product_id}`
      if (prev !== null && !(key > prev)) throw new CmsPublishedUnavailable('ROWS_ORDER')
      prev = key
      const v = BigInt(a)
      sum += v
      byUser.set(x.user_id, (byUser.get(x.user_id) ?? BigInt(0)) + v)
      rows++
      if (rows > h.expected) throw new CmsPublishedUnavailable('ROWS_COUNT_MISMATCH')
    }
    if (data.length < pageSize) break
  }
  if (rows !== h.expected) throw new CmsPublishedUnavailable('ROWS_COUNT_MISMATCH')
  if (sum !== h.amount) throw new CmsPublishedUnavailable('ROWS_SUM_MISMATCH')
  // Purge đặt purged_at TRƯỚC khi xoá lô đầu: đọc lại header bắt purge bắt đầu trong lúc đọc trang (dù số dòng tình cờ khớp).
  const again = checkHeader(await read(() => reader.header(runId)), programId, runId)
  if (again.amountText !== h.amountText || again.expected !== h.expected || again.configVersion !== h.configVersion || again.publishedAt !== h.publishedAt) {
    throw new CmsPublishedUnavailable('RUN_HEADER_INVALID')
  }
  return { amountVnd: h.amountText, byUser, configVersion: h.configVersion, publishedAt: h.publishedAt, rows }
}
