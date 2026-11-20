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
//  · Q-233: cửa sổ job theo NGÀY VN, đồng hồ ghim một lần: D+1 ≤ hôm nay ≤ D+30 (D = ngày kết thúc kỳ); D+31 không tự chọn ⇒ đường
//    thủ công một chương trình qua PHIÊN SUPER (runCmsManualCloseReport — server action; PM 18/11 audit r0 P1-04). Ngày cuối (D+30) gắn
//    lastDay để log liệt kê chương trình chưa xong.
//  · Q-236 / Q-237 (132): profile báo cáo theo LỰA CHỌN ĐÃ GHIM của từng chương trình (cmsAfterCloseProfile — run chốt contract đã chọn
//    trả ⇒ policy của run; còn lại ⇒ profile báo cáo đã lưu; chưa chọn ⇒ skipped REPORT_POLICY_UNSELECTED, không đọc nguồn). full_line cần
//    đường full_line của DB (DB 130 / 131 ⇒ CAPS_UNAVAILABLE). Trần phiếu / báo cáo theo profile (full_line 10.000 — đề xuất r1, Q-238).

import { cronBearerMatches } from './cronProducts'
import type { CmsAdminAccessLike } from './lockAction'
import { CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE, buildCmsCloseReportPayload, cmsCloseReportMaxReturns, type CmsCloseReportPayload } from './calc/closeReport'
import { cmsPolicyReadsReturns, type CmsReturnProfile, type CmsReturnsPolicy } from './calc/policy'
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
  /** Q-233: hôm nay (VN) = D+30 — lần chạy job tự động cuối của chương trình. */
  lastDay?: boolean
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
  /** Q-233: chương trình đang ở ngày cuối cửa sổ job (D+30). */
  lastDay?: boolean
}

/** Q-233: cửa sổ job mặc định (ngày sau kết thúc kỳ). Không phải TTL ledger / báo cáo. */
export const CMS_AFTER_CLOSE_WINDOW_DAYS = 30
const DAY_MS = 86_400_000
const vnDate = (ms: number): string => new Date(ms + 7 * 3600_000).toISOString().slice(0, 10)
/**
 * Q-233 — cửa sổ theo NGÀY VN từ MỘT mốc đồng hồ (ghim đầu lượt): chọn chương trình có `since ≤ end_date < today`
 * (⇔ D+1 ≤ hôm nay ≤ D+maxAge); `lastDay` = ngày kết thúc của chương trình đang ở D+maxAge.
 */
export function cmsAfterCloseWindow(nowMs: number, maxAgeDays: number): { today: string; since: string; lastDay: string } {
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1) throw new Error('CONFIG_INVALID')
  const today = vnDate(nowMs)
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - maxAgeDays * DAY_MS).toISOString().slice(0, 10)
  return { today, since, lastDay: since }
}
/** Run chốt của chương trình + lựa chọn profile báo cáo đã ghim (rpc_cms_frozen_sales_lines limit 1). */
export interface CmsAfterClosePayoutRun {
  runId: string
  legacy: boolean
  /** returns_policy GHIM trên run chốt (legacy ⇒ sales_only_v1). */
  runPolicy: CmsReturnsPolicy
  /** Profile của các báo cáo đã lưu cho chương trình (DB ghim một profile / chương trình); chưa có báo cáo ⇒ null. */
  reportProfile: CmsReturnProfile | null
}
/** Lưu báo cáo đường thủ công (phiên super): lý do + khoá yêu cầu đi cùng ghi; DB lấy actor từ PHIÊN (auth.uid()), không từ body. */
export interface CmsAfterCloseManualSave { reason: string; request: string }

export interface CmsAfterCloseDeps {
  /** Năng lực DB: đường close_report (+ full_line khi profile full_line; + manual_report khi lập tay qua phiên super) của
   *  rpc_cms_capabilities. Thiếu / lệch ⇒ false ⇒ không đọc nguồn. */
  capsOk(profile: CmsReturnProfile, manual?: boolean): Promise<boolean>
  /** Chương trình đã chốt cần kiểm (đã lọc cửa sổ ngày ở deps thật). */
  listPrograms(): Promise<CmsAfterCloseProgram[]>
  /** Run chốt của chương trình (rpc_cms_frozen_sales_lines limit 1). Không chốt / lỗi ⇒ code. */
  payoutRun(programId: string): Promise<({ ok: true } & CmsAfterClosePayoutRun) | { ok: false; code: string }>
  provider: CmsContractSourceProvider | null
  /** Cron: service_role `rpc_cms_return_close_report_save`. Thủ công: SESSION client `rpc_cms_return_close_report_save_super`. */
  save(programId: string, payoutRunId: string, payload: CmsCloseReportPayload, manual?: CmsAfterCloseManualSave)
    : Promise<{ ok: true; data: unknown } | { ok: false; code: string; refs?: string[] }>
  nowMicros(): bigint
  /** ms còn lại của ngân sách lượt chạy. */
  remainingMs(): number
}

/**
 * PM 18/11 audit r0 §3.1 (Q-237) — profile báo cáo sau chốt theo LỰA CHỌN ĐÃ GHIM, không theo hằng của job:
 *  · run chốt là contract đã chọn trả (net / full_line) ⇒ đúng policy của run (lệch lựa chọn tay ⇒ CMS_REPORT_PROFILE_MISMATCH);
 *  · run chốt legacy / contract sales-only ⇒ profile của báo cáo đã lưu (DB ghim một profile / chương trình);
 *  · chưa có lựa chọn ⇒ REPORT_POLICY_UNSELECTED (bỏ qua TRƯỚC khi đọc nguồn) — chỉ super (phiên) chọn được ở lần lập tay đầu tiên.
 */
export function cmsAfterCloseProfile(pay: CmsAfterClosePayoutRun, chosen: CmsReturnProfile | null = null): { profile: CmsReturnProfile } | { code: string } {
  if (!pay.legacy && cmsPolicyReadsReturns(pay.runPolicy)) {
    const runProfile = pay.runPolicy as CmsReturnProfile
    if (chosen !== null && chosen !== runProfile) return { code: 'CMS_REPORT_PROFILE_MISMATCH' }
    return { profile: runProfile }
  }
  if (pay.reportProfile !== null) {
    if (chosen !== null && chosen !== pay.reportProfile) return { code: 'CMS_REPORT_PROFILE_LEDGER_MISMATCH' }
    return { profile: pay.reportProfile }
  }
  return chosen !== null ? { profile: chosen } : { code: 'REPORT_POLICY_UNSELECTED' }
}

/**
 * Lỗi RPC ⇒ MÃ CMS_* (không message thô). Hết lock_timeout (SQLSTATE 55P03) không mang mã CMS_* ⇒ CMS_LOCK_TIMEOUT (held, thử lượt
 * sau) — db-reviewer 14/11 P2-4.
 */
export function cmsAfterCloseRpcCode(error: { message?: string; code?: string } | null, fallback: string): string {
  if (String(error?.code ?? '') === '55P03') return 'CMS_LOCK_TIMEOUT'
  // r1 P1-2: statement_timeout của vai PostgREST (prod 8 s — authenticated / authenticator) ⇒ lượt bị huỷ, 0 ghi (một transaction).
  if (String(error?.code ?? '') === '57014') return 'CMS_STATEMENT_TIMEOUT'
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

/** Đường thủ công (phiên super): ghim run chốt, lý do, khoá yêu cầu; `profile` chỉ dùng khi chương trình CHƯA có lựa chọn. */
export interface CmsAfterCloseManualRun { expectedPayoutRunId: string; reason: string; request: string; profile: CmsReturnProfile | null }

export async function runCmsReturnsAfterCloseProgram(deps: CmsAfterCloseDeps, p: CmsAfterCloseProgram,
  manual?: CmsAfterCloseManualRun): Promise<CmsAfterCloseItem> {
  const item = (status: CmsAfterCloseStatus, code: string | null, extra: Partial<CmsAfterCloseItem> = {}): CmsAfterCloseItem =>
    ({ programId: p.id, status, code, ...(p.lastDay ? { lastDay: true } : {}), ...extra })
  const provider = deps.provider
  if (!provider) return item('error', 'PROVIDER_MISSING')
  // Nguồn giả chỉ cho chương trình QA (DB cũng chặn: CMS_REPORT_PIN_PROVIDER).
  if (provider.kind === 'fixture' && !p.isTest) return item('held', 'FIXTURE_REAL_PROGRAM')
  if (p.productIds.length === 0) return item('error', 'CONFIG_INVALID')
  const pay = await deps.payoutRun(p.id)
  if (!pay.ok) return item(pay.code === 'CMS_REPORT_NOT_LOCKED' ? 'skipped' : 'error', pay.code)
  // Đường thủ công ghim run chốt: lệch ⇒ dừng TRƯỚC khi đọc nguồn (chốt lại / đổi run ⇒ super tải lại trang).
  if (manual && pay.runId !== manual.expectedPayoutRunId) return item('error', 'CMS_MANUAL_RUN_MISMATCH')
  // Profile theo lựa chọn đã ghim (không hằng của job) — chưa chọn ⇒ bỏ qua có lý do, không tốn job nguồn.
  const sel = cmsAfterCloseProfile(pay, manual?.profile ?? null)
  if ('code' in sel) return item(sel.code === 'REPORT_POLICY_UNSELECTED' ? 'skipped' : 'error', sel.code)
  const profile = sel.profile
  if (!(await deps.capsOk(profile, manual !== undefined))) return item('held', 'CAPS_UNAVAILABLE')
  let win: { fromMicros: bigint; toMicrosExclusive: bigint }
  try { win = vnProgramWindowMicros(p.startDate, p.endDate) } catch { return item('error', 'CONFIG_INVALID') }
  if (deps.remainingMs() < MIN_PROGRAM_MS) return item('held', 'DEADLINE')
  const asOf = deps.nowMicros()
  const read = await provider.read({
    fromMicros: win.fromMicros, toMicrosExclusive: win.toMicrosExclusive, productIds: p.productIds, asOfMicros: asOf, withReturns: true,
    returnsProfile: profile, deadlineMs: Math.max(1000, deps.remainingMs() - 10_000),
  })
  if (!read.ok) return item(SOURCE_HELD.has(read.code) ? 'held' : 'error', `SOURCE_${read.code}`)
  // Provider phải trả đúng mốc ghim, đúng loại, có phần trả (không [] / null giả), đúng một job / snapshot.
  if (read.asOfMicros !== asOf || read.provider !== provider.kind || read.returnsRaw === null
      || (read.jobId === undefined) === (read.snapshotId === undefined)) {
    return item('error', 'SOURCE_PIN_MISMATCH')
  }
  // Trần phiếu / báo cáo theo profile (full_line CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE; = DB). Run chốt CONTRACT (hợp đồng đóng băng r1) ⇒ cùng trần cả
  // khi profile net_returns_v1 (= DB, db-reviewer r1 P2); 100.000 chỉ còn cho run legacy. Vượt ⇒ dừng rõ, 0 ghi; không cắt / chia.
  const maxReturns = pay.legacy ? cmsCloseReportMaxReturns(profile) : CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE
  if (read.returnsRaw.length > maxReturns) return item('held', 'CMS_REPORT_TOO_LARGE', { returnsRead: read.returnsRaw.length })
  const returns: CmsReturnRecord[] = []
  for (const raw of read.returnsRaw) {
    const n = normalizeReturnRow(raw, profile)
    // Một phiếu sai dạng ⇒ cả chương trình held (không gửi tập thiếu — digest sẽ khác nguồn).
    if (!n.ok) return item('held', 'RETURN_ROW_INVALID', { returnsRead: read.returnsRaw.length })
    returns.push(n.value)
  }
  let payload: CmsCloseReportPayload
  try {
    payload = buildCmsCloseReportPayload({ startDate: p.startDate, endDate: p.endDate, productIds: p.productIds }, returns, {
      provider: read.provider, asOfMicros: asOf, profile, ...(read.jobId !== undefined ? { jobId: read.jobId } : { snapshotId: read.snapshotId as string }),
    })
  } catch {
    return item('held', 'RETURN_SET_INVALID', { returnsRead: returns.length })
  }
  const saved = await deps.save(p.id, pay.runId, payload, manual ? { reason: manual.reason, request: manual.request } : undefined)
  if (!saved.ok) {
    return item(saved.code === 'CMS_REPORT_AS_OF_STALE' || saved.code === 'CMS_LOCK_TIMEOUT' || saved.code === 'CMS_STATEMENT_TIMEOUT'
      || saved.code === 'CMS_REPORT_TOO_LARGE' ? 'held' : 'error', saved.code,
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

export interface CmsAfterCloseSummary { programs: number; results: CmsAfterCloseItem[]; pending: string[]; code?: string; lastDayOpen?: string[] }

export async function runCmsReturnsAfterClose(deps: CmsAfterCloseDeps, o: { maxPrograms: number }): Promise<CmsAfterCloseSummary> {
  // Đường close_report phải có trước mọi chương trình; full_line kiểm thêm theo profile từng chương trình.
  if (!(await deps.capsOk('net_returns_v1'))) return { programs: 0, results: [], pending: [], code: 'CAPS_UNAVAILABLE' }
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
  // Q-233 checklist: chương trình ở ngày cuối (D+30) mà lần này chưa saved / already (held / error / skipped / pending) ⇒ operator xử lý
  // bằng đường thủ công; không coi là đủ trả chỉ vì ngày mai ra khỏi bộ lọc.
  const lastDayOpen = [
    ...results.filter((r) => r.lastDay && r.status !== 'saved' && r.status !== 'already').map((r) => r.programId),
    ...list.filter((p) => p.lastDay && pending.includes(p.id)).map((p) => p.id),
  ]
  return { programs: list.length, results, pending, ...(lastDayOpen.length ? { lastDayOpen } : {}) }
}

// ── Q-233 đường thủ công ngày 31 (MỘT chương trình) — PHIÊN SUPER (PM 18/11 audit r0 P1-04) ──────────────────────────────────────
// Server action (app/actions/cmsReturns.ts) ⇒ lõi này. Thứ tự: cờ (program + earnings + returns) → server QA chỉ đọc → super SESSION →
// đầu vào → chương trình (locked; QA không marker ⇒ NOT_FOUND) → job một chương trình (ghim run chốt; profile đã ghim, hoặc super chọn
// khi chưa có) → lưu bằng SESSION client: DB lấy actor = auth.uid() + kiểm is_super_admin(), lưu lý do + khoá yêu cầu cùng báo cáo.
// KHÔNG có đường Bearer + UUID khai báo (POST cũ đã bỏ). GET cron giữ Bearer CRON_SECRET, created_via = cron.
export interface CmsManualReportDeps {
  enabled(): boolean
  qaReadonly(): boolean
  /** Phiên super (allowlist) — không service role, không tin body. */
  access(): Promise<CmsAdminAccessLike>
  /** Chương trình theo id (KHÔNG lọc cửa sổ ngày) — chỉ locked; khác ⇒ code. */
  manualProgram(programId: string): Promise<{ ok: true; program: CmsAfterCloseProgram } | { ok: false; code: string }>
  /** Deps job cho MỘT chương trình; `save(…, manual)` dùng SESSION client. */
  job(): CmsAfterCloseDeps
}
export interface CmsManualReportInput { programId: string; payoutRunId: string; profile: CmsReturnProfile | null; reason: string; idem: string }
export type CmsManualReportResult =
  | { ok: true; status: 'saved' | 'already'; reportId: string | null; returnsRead: number | null }
  | { ok: false; code: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Cùng luật DB: lý do 10–500 ký tự (code point, sau trim), không ký tự điều khiển.
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/
export const CMS_MANUAL_REASON_MIN = 10
export const CMS_MANUAL_REASON_MAX = 500

/** Đầu vào form: { programId, payoutRunId, profile?, reason, idem }. Sai ⇒ null. */
export function parseCmsManualReportInput(raw: unknown): CmsManualReportInput | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = (k: string) => (typeof o[k] === 'string' && UUID_RE.test(o[k] as string) ? (o[k] as string) : null)
  const programId = id('programId'), payoutRunId = id('payoutRunId'), idem = id('idem')
  if (!programId || !payoutRunId || !idem || typeof o.reason !== 'string' || CTRL_RE.test(o.reason)) return null
  const reason = o.reason.trim()
  const cp = [...reason].length
  if (cp < CMS_MANUAL_REASON_MIN || cp > CMS_MANUAL_REASON_MAX) return null
  const pr = o.profile ?? null
  if (pr !== null && pr !== 'net_returns_v1' && pr !== 'full_line_qty_refund_v1') return null
  return { programId, payoutRunId, profile: pr, reason, idem }
}

export async function runCmsManualCloseReport(deps: CmsManualReportDeps, raw: unknown): Promise<CmsManualReportResult> {
  if (!deps.enabled()) return { ok: false, code: 'RETURNS_DISABLED' }
  if (deps.qaReadonly()) return { ok: false, code: 'QA_SERVER_READONLY' }
  let a: CmsAdminAccessLike
  try { a = await deps.access() } catch { return { ok: false, code: 'UNAVAILABLE' } }
  if (a.kind === 'anonymous') return { ok: false, code: 'UNAUTHENTICATED' }
  if (a.kind === 'forbidden') return { ok: false, code: 'FORBIDDEN' }
  if (a.kind !== 'ok') return { ok: false, code: 'UNAVAILABLE' }
  const input = parseCmsManualReportInput(raw)
  if (!input) return { ok: false, code: 'BAD_INPUT' }
  let pr: Awaited<ReturnType<CmsManualReportDeps['manualProgram']>>
  try { pr = await deps.manualProgram(input.programId) } catch { return { ok: false, code: 'UNAVAILABLE' } }
  if (!pr.ok) return { ok: false, code: pr.code }
  // Chương trình QA chỉ cho phiên có marker QA (cùng luật xác nhận phục hồi) — không lộ tồn tại.
  if (pr.program.isTest && !a.qa) return { ok: false, code: 'CMS_PROGRAM_NOT_FOUND' }
  let r: CmsAfterCloseItem
  try {
    r = await runCmsReturnsAfterCloseProgram(deps.job(), { ...pr.program, lastDay: false },
      { expectedPayoutRunId: input.payoutRunId, reason: input.reason, request: input.idem, profile: input.profile })
  } catch {
    return { ok: false, code: 'UNEXPECTED' }
  }
  if (r.status === 'saved' || r.status === 'already') return { ok: true, status: r.status, reportId: r.reportId ?? null, returnsRead: r.returnsRead ?? null }
  return { ok: false, code: r.code ?? 'CMS_REPORT_HELD' }
}

/** Mã ⇒ câu cho super (không lộ message thô). */
export const CMS_MANUAL_REPORT_CODE_LABEL: Record<string, string> = {
  RETURNS_DISABLED: 'Pipeline trả hàng đang tắt.',
  QA_SERVER_READONLY: 'Server QA chỉ đọc.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết — đăng nhập lại.',
  FORBIDDEN: 'Chỉ super admin được lập báo cáo thủ công.',
  UNAVAILABLE: 'Không kiểm được quyền / chương trình — thử lại.',
  BAD_INPUT: `Lý do cần ${CMS_MANUAL_REASON_MIN}–${CMS_MANUAL_REASON_MAX} ký tự, không ký tự điều khiển.`,
  CMS_PROGRAM_NOT_FOUND: 'Không tìm thấy chương trình.',
  CMS_REPORT_NOT_LOCKED: 'Chương trình chưa chốt.',
  CMS_MANUAL_RUN_MISMATCH: 'Lần chốt vừa đổi — tải lại trang rồi lập lại.',
  REPORT_POLICY_UNSELECTED: 'Chương trình chưa chọn quy tắc báo cáo — chọn quy tắc trước khi lập.',
  CMS_REPORT_PROFILE_MISMATCH: 'Quy tắc chọn khác quy tắc trả hàng đã ghim trên lần chốt.',
  CMS_REPORT_PROFILE_LEDGER_MISMATCH: 'Chương trình đã có báo cáo theo quy tắc khác — không trộn hai quy tắc.',
  CAPS_UNAVAILABLE: 'Cơ sở dữ liệu chưa hỗ trợ quy tắc này.',
  CMS_REPORT_TOO_LARGE: 'Quá số phiếu trả tối đa của một báo cáo — báo Dev.',
  CMS_RETURN_LEDGER_CONFLICT: 'Phiếu trả đã nhận bị đổi / mất ở nguồn — xử lý conflict trước.',
  CMS_REPORT_FORBIDDEN: 'Chỉ super admin được lập báo cáo thủ công.',
  CMS_LOCK_TIMEOUT: 'Chương trình đang được xử lý — thử lại sau ít phút.',
  CMS_STATEMENT_TIMEOUT: 'Lập báo cáo quá thời gian cho phép — không ghi gì; thử lại sau ít phút, lặp lại thì báo Dev.',
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
