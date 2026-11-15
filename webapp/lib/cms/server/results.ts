import 'server-only'
import { createClient } from '@/lib/supabase/server'
import {
  parseCmsResultEvents, parseCmsResultHeader, parseCmsResultLines, parseCmsResultRows,
  type CmsResultHeaderDto, type CmsResultLinesPage, type CmsResultRowsDto,
} from '@/lib/cms/resultView'
import { getCmsCapabilityState } from './capabilities'

// CMS P2-c — đọc kết quả bằng SESSION client qua 4 RPC 122 (authenticated, SECDEF lọc phạm vi hiện tại + marker QA trong DB).
// Không service role; app chỉ kiểm cờ / vai trước khi gọi (UI ẩn thêm). Lỗi ⇒ mã chung, không đưa message DB lên UI:
//   FORBIDDEN (ngoài phạm vi / chương trình test không marker) · RUN_GONE (run đã thay / dọn ⇒ "dữ liệu đã thay đổi, tải lại")
//   · TOO_LARGE · QUERY_FAILED (lỗi kết nối / DTO sai shape — không hiện 0 giả).

export type CmsResultError = 'FORBIDDEN' | 'RUN_GONE' | 'TOO_LARGE' | 'BAD_INPUT' | 'QUERY_FAILED'
export type CmsResultRead<T> = { ok: true; data: T } | { ok: false; error: CmsResultError }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function mapError(message: string | undefined): CmsResultError {
  const m = String(message ?? '')
  if (m.includes('CMS_RESULT_FORBIDDEN')) return 'FORBIDDEN'
  if (m.includes('CMS_RESULT_RUN_GONE')) return 'RUN_GONE'
  if (m.includes('CMS_RESULT_TOO_LARGE')) return 'TOO_LARGE'
  if (m.includes('CMS_RESULT_BAD_INPUT')) return 'BAD_INPUT'
  return 'QUERY_FAILED'
}

// Log chỉ mã cố định (PM 03/11 R3): không ghi message DB / transport / parse (có thể mang giá trị dòng, email, id).
// SQLSTATE (5 ký tự) / mã PostgREST (PGRST + 3 số) là mã máy, ghi được; mọi thứ khác ⇒ UNKNOWN.
const SAFE_CODE_RE = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/
export const cmsSafeErrorCode = (c: unknown): string => (typeof c === 'string' && SAFE_CODE_RE.test(c) ? c : 'UNKNOWN')

async function call<T>(fn: string, args: Record<string, unknown>, parse: (raw: unknown) => T): Promise<CmsResultRead<T>> {
  let raw: unknown
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.rpc(fn, args)
    if (error) {
      const code = mapError(error.message)
      if (code === 'QUERY_FAILED') console.error(`[cms-results] ${fn} QUERY_FAILED sqlstate=${cmsSafeErrorCode(error.code)}`)
      return { ok: false, error: code }
    }
    raw = data
  } catch {
    console.error(`[cms-results] ${fn} TRANSPORT_FAILED`)
    return { ok: false, error: 'QUERY_FAILED' }
  }
  try {
    return { ok: true, data: parse(raw) }
  } catch {
    console.error(`[cms-results] ${fn} DTO_INVALID`)
    return { ok: false, error: 'QUERY_FAILED' }
  }
}

const badId = (id: string | null | undefined) => typeof id !== 'string' || !UUID_RE.test(id)

/**
 * CMS-CALC-RET-2 P5.2 — phiên bản reader theo NĂNG LỰC DB (không theo cờ): đường readers_v2 bật ⇒ v2 (đọc cả run legacy lẫn run
 * contract, khối hợp đồng ghim từ run). Khác ⇒ v1 (122): 130 chèn RAISE ở reader cũ cho run contract ⇒ v1 không bao giờ trả số của run
 * contract với nhãn legacy — lỗi hiện thành QUERY_FAILED, không rỗng / 0 giả.
 */
export async function cmsReaderVersion(): Promise<1 | 2> {
  const s = await getCmsCapabilityState()
  return s.kind === 'ok' && s.caps.paths.readers_v2 ? 2 : 1
}

export async function cmsLoadResultHeader(programId: string): Promise<CmsResultRead<CmsResultHeaderDto>> {
  if (badId(programId)) return { ok: false, error: 'BAD_INPUT' }
  const v = await cmsReaderVersion()
  return call(v === 2 ? 'rpc_cms_result_header_v2' : 'rpc_cms_result_header', { p_program_id: programId }, (x) => parseCmsResultHeader(x, v))
}

/** runId null ⇒ run hiện hành (có thể chưa có ⇒ runId null trong data). */
export async function cmsLoadResultRows(programId: string, runId: string | null): Promise<CmsResultRead<CmsResultRowsDto>> {
  if (badId(programId) || (runId !== null && badId(runId))) return { ok: false, error: 'BAD_INPUT' }
  const v = await cmsReaderVersion()
  return call(v === 2 ? 'rpc_cms_result_rows_v2' : 'rpc_cms_result_rows', { p_program_id: programId, p_run_id: runId }, (x) => parseCmsResultRows(x, v))
}

export async function cmsLoadResultLines(o: {
  programId: string; runId: string; programProductId?: string | null; userId?: string | null; afterSeq?: number | null; limit: number
}): Promise<CmsResultRead<CmsResultLinesPage>> {
  if (badId(o.programId) || badId(o.runId) || (o.programProductId && badId(o.programProductId)) || (o.userId && badId(o.userId))
      || !Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > 500
      || (o.afterSeq !== null && o.afterSeq !== undefined && (!Number.isSafeInteger(o.afterSeq) || o.afterSeq < 0))) {
    return { ok: false, error: 'BAD_INPUT' }
  }
  // v2: sự kiện SALE + RETURN (cùng tham số / keyset seq với reader dòng 122).
  if ((await cmsReaderVersion()) === 2) {
    return call('rpc_cms_result_events_v2', {
      p_program_id: o.programId, p_run_id: o.runId, p_program_product_id: o.programProductId ?? null, p_user_id: o.userId ?? null,
      p_after_seq: o.afterSeq ?? null, p_limit: o.limit,
    }, parseCmsResultEvents)
  }
  return call('rpc_cms_result_lines', {
    p_program_id: o.programId, p_run_id: o.runId, p_program_product_id: o.programProductId ?? null, p_user_id: o.userId ?? null,
    p_after_seq: o.afterSeq ?? null, p_limit: o.limit,
  }, parseCmsResultLines)
}

/** Dòng chưa gán / ngoài phạm vi — DB chỉ cho super (có email nguồn để sửa mapping). P5.4: reader v2 thêm kind 'quantity' (dòng INCLUDED
 *  không vào lượng của run contract); DB trước v2 ⇒ chỉ 'disposition' (122) — 'quantity' ⇒ BAD_INPUT (run contract không đọc được qua 122). */
export async function cmsLoadResultExcluded(o: { programId: string; runId: string; afterSeq?: number | null; limit: number; kind?: 'disposition' | 'quantity' }): Promise<CmsResultRead<unknown>> {
  if (badId(o.programId) || badId(o.runId) || !Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > 500) {
    return { ok: false, error: 'BAD_INPUT' }
  }
  if ((await cmsReaderVersion()) === 2) {
    return call('rpc_cms_result_excluded_v2', { p_program_id: o.programId, p_run_id: o.runId, p_kind: o.kind ?? 'disposition', p_after_seq: o.afterSeq ?? null, p_limit: o.limit }, (x) => x)
  }
  if (o.kind === 'quantity') return { ok: false, error: 'BAD_INPUT' }
  return call('rpc_cms_result_excluded', { p_program_id: o.programId, p_run_id: o.runId, p_after_seq: o.afterSeq ?? null, p_limit: o.limit }, (x) => x)
}

/**
 * Đọc ĐỦ mọi trang lịch sử dòng của MỘT run (XLSX): ghim runId, con trỏ seq; vượt `maxRows` ⇒ TOO_LARGE (không xuất thiếu).
 */
export async function cmsLoadAllResultLines(o: { programId: string; runId: string; programProductId?: string | null; userId?: string | null; maxRows: number }):
  Promise<CmsResultRead<CmsResultLinesPage['rows']>> {
  const out: CmsResultLinesPage['rows'] = []
  let after: number | null = null
  for (;;) {
    const r = await cmsLoadResultLines({ ...o, afterSeq: after, limit: 500 })
    if (!r.ok) return r
    if (r.data.runId !== o.runId) return { ok: false, error: 'RUN_GONE' }
    out.push(...r.data.rows)
    if (out.length > o.maxRows) return { ok: false, error: 'TOO_LARGE' }
    if (r.data.nextAfterSeq === null) return { ok: true, data: out }
    after = r.data.nextAfterSeq
  }
}
