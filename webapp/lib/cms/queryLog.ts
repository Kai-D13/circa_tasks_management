// CMS — lỗi truy vấn đọc danh mục / kết quả: chỉ mang MÃ MÁY, không mang message (PM 03/11 §3.2, review P2-b R3).
// Message của PostgREST / Postgres có thể chứa giá trị dòng (email, tên, ProductID, số tiền) ⇒ không bao giờ đưa vào log
// hay response. Thuần (không server-only) để test được; dùng ở lib/cms/server/{catalog,staffCatalog,resultLoad}.ts.

// SQLSTATE (5 ký tự chữ hoa / số) hoặc mã PostgREST (PGRST + 3 số) — cùng whitelist với server/results.ts (cmsSafeErrorCode).
const SAFE_SQLSTATE_RE = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/
/** Mã nội bộ cố định của lớp đọc (không lấy từ DB). */
const INTERNAL = new Set(['TOO_MANY_ROWS'])

export function cmsSafeSqlstate(code: unknown): string {
  return typeof code === 'string' && (SAFE_SQLSTATE_RE.test(code) || INTERNAL.has(code)) ? code : 'UNKNOWN'
}

/** Lỗi truy vấn đã làm sạch: `message` cố định, `sqlstate` đã qua whitelist. */
export class CmsQueryError extends Error {
  readonly sqlstate: string
  constructor(code: unknown) {
    super('CMS_QUERY_FAILED')
    this.name = 'CmsQueryError'
    this.sqlstate = cmsSafeSqlstate(code)
  }
}

/** Dòng log cho một lỗi bất kỳ khi đọc: `[tag] QUERY_FAILED sqlstate=XXXXX` — không message, không giá trị. */
export function cmsQueryFailLine(tag: string, e: unknown): string {
  return `[${tag}] QUERY_FAILED sqlstate=${e instanceof CmsQueryError ? e.sqlstate : 'UNKNOWN'}`
}
