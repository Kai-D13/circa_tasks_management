// CMS-CALC-RET-2 P5.5 — job BÁO CÁO TRẢ HÀNG SAU CHỐT `/api/cron/cms-returns-after-close` (PM D11; thiết kế Dev r2 §6.6 + §14.2; PM work
// order 14/11 §P5.5). Lõi THUẦN + handler, deps tiêm vào (route thật: lib/cms/server/returnsAfterCloseDeps.ts; test: deps giả).
//  · Bearer CRON_SECRET; cờ CMS_RETURNS_ENABLED OFF ⇒ 200 {status:'DISABLED'} và KHÔNG gọi deps nào (không query nguồn / DB).
//  · Mỗi chương trình đã chốt: run chốt lấy từ DB (rpc_cms_frozen_sales_lines — chỉ chương trình locked có payout); provider đọc MỘT
//    snapshot ghim as_of theo phạm vi chốt (kỳ + tập SP); payload = pin + phiếu thô (buildCmsCloseReportPayload) ⇒
//    rpc_cms_return_close_report_save. DB tự suy mọi số từ dòng bán ĐÃ ĐÓNG BĂNG; app không gửi số nào để DB tin.
//  · Không là lệnh thu / chi: không đụng cms_payouts / payout_staff / chốt. Lỗi nguồn / phiếu sai dạng / sổ lệch ⇒ chương trình đó HELD,
//    không ghi báo cáo (báo cáo hợp lệ trước giữ nguyên) — thiếu nguồn ≠ 0 phiếu trả.
//  · Idempotent: DB trả báo cáo cũ khi cùng snapshot (as_of + digest); job chạy song song an toàn (DB khoá chương trình FOR UPDATE).
//  · Log / response: id + số đếm + mã cố định — không email / tên / số tiền.

import { cronBearerMatches } from './cronProducts'
import { buildCmsCloseReportPayload, type CmsCloseReportPayload } from './calc/closeReport'
import { normalizeReturnRow, type CmsReturnRecord } from './calc/returns'
import type { CmsContractSourceCode, CmsContractSourceProvider } from './source/contractSource'
import { vnProgramWindowMicros } from './time'

export interface CmsAfterCloseProgram {
  id: string
  name?: string
  startDate: string
  endDate: string
  isTest: boolean
  productIds: string[]
}
export type CmsAfterCloseStatus = 'saved' | 'already' | 'held' | 'error' | 'skipped'
export interface CmsAfterCloseItem {
  programId: string
  status: CmsAfterCloseStatus
  code: string | null
  reportId?: string | null
  returnsRead?: number
  /** ID kỹ thuật phiếu / dòng gốc DB nêu ở DETAIL khi từ chối (không PII; tối đa 20) — ghi vết (db-reviewer 14/11 P2-5 / P2-4 cuối). */
  refs?: string[]
}
export interface CmsAfterCloseDeps {
  /** Năng lực DB: đường close_report của rpc_cms_capabilities (DB trước 130 / lệch version ⇒ false ⇒ không đọc nguồn). */
  capsOk(): Promise<boolean>
  /** Chương trình đã chốt cần kiểm (đã lọc cửa sổ ngày ở deps thật). */
  listPrograms(): Promise<CmsAfterCloseProgram[]>
  /** Run chốt của chương trình (rpc_cms_frozen_sales_lines limit 1). Không chốt / lỗi ⇒ code. */
  payoutRun(programId: string): Promise<{ ok: true; runId: string; legacy: boolean } | { ok: false; code: string }>
  provider: CmsContractSourceProvider | null
  save(programId: string, payoutRunId: string, payload: CmsCloseReportPayload): Promise<{ ok: true; data: unknown } | { ok: false; code: string; refs?: string[] }>
  nowMicros(): bigint
  /** ms còn lại của ngân sách lượt chạy. */
  remainingMs(): number
}

/**
 * Lỗi RPC ⇒ MÃ CMS_* (không message thô). Hết lock_timeout (SQLSTATE 55P03) không mang mã CMS_* ⇒ CMS_LOCK_TIMEOUT (held, thử lượt
 * sau) — db-reviewer 14/11 P2-4.
 */
export function cmsAfterCloseRpcCode(error: { message?: string; code?: string } | null, fallback: string): string {
  if (String(error?.code ?? '') === '55P03') return 'CMS_LOCK_TIMEOUT'
  const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(error?.message ?? ''))
  return m ? m[0] : fallback
}
/** DETAIL 'refs: a,b,…' của report_save (≤ 20 ID phiếu / dòng gốc, không PII) ⇒ danh sách đã lọc ký tự, tối đa 20. */
export function cmsAfterCloseRefs(details: unknown): string[] {
  const m = /^refs:\s*([^]*)$/.exec(String(details ?? ''))
  if (!m) return []
  return m[1].split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9:._-]{1,80}$/.test(x)).slice(0, 20)
}

/** Mã nguồn ⇒ held (cùng tập worker contract — contractSync HELD_SOURCE); còn lại (TIMEOUT / SOURCE_ERROR) ⇒ error. Cả hai: không ghi. */
const SOURCE_HELD: ReadonlySet<CmsContractSourceCode> = new Set(['NOT_CONFIGURED', 'PERMISSION_DENIED', 'CONTRACT_MISMATCH', 'INCOMPLETE', 'OVER_CAP', 'BYTES_LIMIT'])
const MIN_PROGRAM_MS = 20_000

function saveReply(raw: unknown): { status: 'saved' | 'already' | 'held'; code: string | null; reportId: string | null } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.saved === true) {
    const id = typeof o.report_id === 'string' ? o.report_id : null
    return { status: o.already === true ? 'already' : 'saved', code: null, reportId: id }
  }
  if (o.saved === false) return { status: 'held', code: typeof o.code === 'string' && /^CMS_[A-Z0-9_]+$/.test(o.code) ? o.code : 'CMS_REPORT_HELD', reportId: null }
  return null
}

export async function runCmsReturnsAfterCloseProgram(deps: CmsAfterCloseDeps, p: CmsAfterCloseProgram): Promise<CmsAfterCloseItem> {
  const item = (status: CmsAfterCloseStatus, code: string | null, extra: Partial<CmsAfterCloseItem> = {}): CmsAfterCloseItem =>
    ({ programId: p.id, status, code, ...extra })
  const provider = deps.provider
  if (!provider) return item('error', 'PROVIDER_MISSING')
  // Nguồn giả chỉ cho chương trình QA (DB cũng chặn: CMS_REPORT_PIN_PROVIDER).
  if (provider.kind === 'fixture' && !p.isTest) return item('held', 'FIXTURE_REAL_PROGRAM')
  if (p.productIds.length === 0) return item('error', 'CONFIG_INVALID')
  const pay = await deps.payoutRun(p.id)
  if (!pay.ok) return item(pay.code === 'CMS_REPORT_NOT_LOCKED' ? 'skipped' : 'error', pay.code)
  // Batch này DB chỉ nhận run chốt legacy (cms__lock_eval chặn chốt run contract) — hỏi trước khi tốn job nguồn.
  if (!pay.legacy) return item('skipped', 'CMS_REPORT_CONTRACT_UNSUPPORTED')
  let win: { fromMicros: bigint; toMicrosExclusive: bigint }
  try { win = vnProgramWindowMicros(p.startDate, p.endDate) } catch { return item('error', 'CONFIG_INVALID') }
  if (deps.remainingMs() < MIN_PROGRAM_MS) return item('held', 'DEADLINE')
  const asOf = deps.nowMicros()
  const read = await provider.read({
    fromMicros: win.fromMicros, toMicrosExclusive: win.toMicrosExclusive, productIds: p.productIds, asOfMicros: asOf, withReturns: true,
    deadlineMs: Math.max(1000, deps.remainingMs() - 10_000),
  })
  if (!read.ok) return item(SOURCE_HELD.has(read.code) ? 'held' : 'error', `SOURCE_${read.code}`)
  // Provider phải trả đúng mốc ghim, đúng loại, có phần trả (không [] / null giả), đúng một job / snapshot.
  if (read.asOfMicros !== asOf || read.provider !== provider.kind || read.returnsRaw === null
      || (read.jobId === undefined) === (read.snapshotId === undefined)) {
    return item('error', 'SOURCE_PIN_MISMATCH')
  }
  const returns: CmsReturnRecord[] = []
  for (const raw of read.returnsRaw) {
    const n = normalizeReturnRow(raw)
    // Một phiếu sai dạng ⇒ cả chương trình held (không gửi tập thiếu — digest sẽ khác nguồn).
    if (!n.ok) return item('held', 'RETURN_ROW_INVALID', { returnsRead: read.returnsRaw.length })
    returns.push(n.value)
  }
  let payload: CmsCloseReportPayload
  try {
    payload = buildCmsCloseReportPayload({ startDate: p.startDate, endDate: p.endDate, productIds: p.productIds }, returns, {
      provider: read.provider, asOfMicros: asOf, ...(read.jobId !== undefined ? { jobId: read.jobId } : { snapshotId: read.snapshotId as string }),
    })
  } catch {
    return item('held', 'RETURN_SET_INVALID', { returnsRead: returns.length })
  }
  const saved = await deps.save(p.id, pay.runId, payload)
  if (!saved.ok) {
    return item(saved.code === 'CMS_REPORT_AS_OF_STALE' || saved.code === 'CMS_LOCK_TIMEOUT' ? 'held' : 'error', saved.code,
      { returnsRead: returns.length, ...(saved.refs?.length ? { refs: saved.refs } : {}) })
  }
  const r = saveReply(saved.data)
  if (!r) return item('error', 'SAVE_REPLY_INVALID', { returnsRead: returns.length })
  return item(r.status, r.code, { reportId: r.reportId, returnsRead: returns.length })
}

/**
 * Thứ tự xử lý xoay vòng theo ngày UTC (db-reviewer 14/11 P2-2): danh sách vượt trần số chương trình / lượt ⇒ mỗi ngày bắt đầu từ vị trí
 * khác, chương trình cuối danh sách không bị dồn "pending" mãi. Danh sách không vượt trần ⇒ giữ nguyên thứ tự.
 */
export function cmsAfterCloseRotate<T>(list: readonly T[], nowMicros: bigint, maxPrograms: number): T[] {
  if (list.length <= maxPrograms) return [...list]
  const start = Number((nowMicros / BigInt(86_400_000_000)) % BigInt(list.length))
  return [...list.slice(start), ...list.slice(0, start)]
}

export interface CmsAfterCloseSummary { programs: number; results: CmsAfterCloseItem[]; pending: string[]; code?: string }

export async function runCmsReturnsAfterClose(deps: CmsAfterCloseDeps, o: { maxPrograms: number }): Promise<CmsAfterCloseSummary> {
  if (!(await deps.capsOk())) return { programs: 0, results: [], pending: [], code: 'CAPS_UNAVAILABLE' }
  const list = await deps.listPrograms()
  const results: CmsAfterCloseItem[] = []
  const pending: string[] = []
  for (const p of cmsAfterCloseRotate(list, deps.nowMicros(), o.maxPrograms)) {
    if (results.length >= o.maxPrograms || deps.remainingMs() < MIN_PROGRAM_MS) { pending.push(p.id); continue }
    try {
      results.push(await runCmsReturnsAfterCloseProgram(deps, p))
    } catch {
      results.push({ programId: p.id, status: 'error', code: 'UNEXPECTED' })
    }
  }
  return { programs: list.length, results, pending }
}

export function cmsAfterCloseHttpStatus(s: CmsAfterCloseSummary): number {
  const bad = s.results.filter((r) => r.status === 'error').length
  if (bad === 0) return 200
  return bad === s.results.length ? 500 : 207
}

export async function handleCmsReturnsAfterClose(input: {
  authorization: string | null
  cronSecret: string | undefined
  returnsEnabled: boolean
  makeDeps: () => CmsAfterCloseDeps
  maxPrograms?: number
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!cronBearerMatches(input.authorization, input.cronSecret)) return { status: 401, body: { error: 'Unauthorized' } }
  // Cờ OFF ⇒ 200 DISABLED rõ ràng (task lịch có thể tạo trước mà không báo đỏ), không gọi deps.
  if (!input.returnsEnabled) return { status: 200, body: { status: 'DISABLED', code: 'RETURNS_DISABLED' } }
  let deps: CmsAfterCloseDeps
  try { deps = input.makeDeps() } catch { return { status: 503, body: { error: 'Cấu hình nguồn CMS không hợp lệ', code: 'CONFIG_INVALID' } } }
  let s: CmsAfterCloseSummary
  try {
    s = await runCmsReturnsAfterClose(deps, { maxPrograms: input.maxPrograms ?? 5 })
  } catch {
    return { status: 500, body: { error: 'Lỗi chọn chương trình CMS', code: 'LIST_FAILED' } }
  }
  if (s.code === 'CAPS_UNAVAILABLE') return { status: 503, body: { status: 'error', ...s } }
  const status = cmsAfterCloseHttpStatus(s)
  return { status, body: { status: status === 200 ? 'ok' : status === 207 ? 'partial' : 'error', ...s } }
}
