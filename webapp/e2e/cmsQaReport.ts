// CMS P4-A (PM 22/11 §3 A3) — BÁO CÁO TRẢ HÀNG SAU CHỐT cho chương trình QA, bằng PHIÊN SUPER, có sổ. Phần THUẦN (không IO / mạng /
// secret); CLI scripts/cms-qa-report.mjs và close của launcher (scripts/cms-qa-run.mjs) nạp file này qua jiti.
//
// Vì sao cần: cron báo cáo sau chốt bỏ qua chương trình is_test; action super trên app bị server QA từ chối (CMS_QA_SERVER) và cần cờ
// RETURNS của container. CLI này KHÔNG viết thuật toán thứ hai: gọi nguyên lõi lib/cms/returnsAfterClose.ts runCmsManualCloseReport
// (ghim run chốt → profile đã ghim → một snapshot nguồn bán + trả ghim as_of → payload) và chỉ thay bước LƯU bằng request PostgREST mang
// token phiên super (rpc_cms_return_close_report_save_super: DB lấy actor = auth.uid(), kiểm is_super_admin(), chương trình đọc được bởi
// phiên) — không service_role cho bước ghi, không nhận UUID actor thay xác thực.
// Sổ r-….json (ghi độc quyền TRƯỚC request, cập nhật atomic sau): intent → done | rejected | unknown; mất phản hồi ⇒ unknown, KHÔNG gửi
// lại mù — reconcile đọc DB theo đúng (chương trình, khoá yêu cầu). Close: thao tác chưa khép ⇒ ĐỎ; mọi báo cáo lập trong cửa sổ trên
// chương trình QA phải khớp một thao tác trong sổ; báo cáo ngoài sổ / sổ ghi đã lập mà DB không có ⇒ ĐỎ.

import crypto from 'node:crypto'
import type { CmsQaRunManifest } from './cmsQaTooling'
import type { CmsAttestRpcOutcome } from './cmsSourceAttest'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RUN_ID_RE = /^cms-qa-[0-9A-Za-z]{8,20}-[0-9a-f]{4}$/
const HEX64 = /^[0-9a-f]{64}$/
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/
const mask = (id: string | null | undefined) => (typeof id === 'string' && UUID_RE.test(id) ? `${id.slice(0, 8)}…` : '—')

export const CMS_QA_REPORT_OP_ID_RE = /^r-[0-9a-f]{12}$/
/** Mã lõi nhận từ bước lưu của CLI (không phải mã DB). */
export const CMS_QA_REPORT_DRY_RUN = 'QA_REPORT_DRY_RUN'
export const CMS_QA_REPORT_UNKNOWN = 'QA_REPORT_UNKNOWN'
export const CMS_QA_REPORT_GUARD = 'QA_REPORT_GUARD'
export const CMS_QA_REPORT_LEDGER = 'QA_REPORT_LEDGER_FAILED'
/** Thời gian lắng trước khi reconcile được kết luận "chưa lập" (≥ timeout request + statement_timeout). */
export const CMS_QA_REPORT_SETTLE_MS = 60_000
export const CMS_QA_REPORT_PROFILES = ['net_returns_v1', 'full_line_qty_refund_v1'] as const

export type CmsQaReportStatus = 'intent' | 'done' | 'rejected' | 'unknown' | 'reconciled'

export interface CmsQaReportOp {
  kind: 'cms-qa-close-report-op'
  version: 1
  operationId: string
  qaRunId: string
  host: string
  pid: number
  programId: string
  /** Run chốt operator đã ghim (lõi dừng CMS_MANUAL_RUN_MISMATCH nếu DB khác). */
  payoutRunId: string
  /** Profile operator chọn (chỉ dùng khi chương trình chưa có lựa chọn ghim); null = theo lựa chọn đã ghim. */
  profile: string | null
  /** Khoá yêu cầu do operator cấp (DB: manual_request — phát lại cùng khoá ⇒ báo cáo đã lập). */
  idemKey: string
  /** sha256 của lý do (không lưu nguyên văn vào sổ ngoài DB). */
  reasonSha256: string
  /** uid phiên super (claim sub) — không email / token. */
  actorId: string
  /** sha256(JSON payload gửi DB) + số phiếu + mốc as_of + digest tập phiếu (pin của lõi) — để so replay; không dòng phiếu. */
  payload: { sha256: string; returns: number; asOf: string | null; returnsDigest: string | null }
  startedAt: string
  status: CmsQaReportStatus
  finishedAt: string | null
  result: { code: string | null; saved: 'saved' | 'already' | null; reportId: string | null } | null
  reconcile?: { at: string; found: boolean; reportId: string | null } | null
}

export function newCmsQaReportOp(i: Omit<CmsQaReportOp, 'kind' | 'version' | 'status' | 'finishedAt' | 'result'>): CmsQaReportOp {
  const bad = !CMS_QA_REPORT_OP_ID_RE.test(i.operationId) || !RUN_ID_RE.test(i.qaRunId) || !i.host || !Number.isInteger(i.pid) || i.pid <= 0
    || !UUID_RE.test(i.programId) || !UUID_RE.test(i.payoutRunId) || !UUID_RE.test(i.idemKey) || !UUID_RE.test(i.actorId)
    || !HEX64.test(i.reasonSha256) || (i.profile !== null && !(CMS_QA_REPORT_PROFILES as readonly string[]).includes(i.profile))
    || !i.payload || !HEX64.test(i.payload.sha256) || !Number.isInteger(i.payload.returns) || i.payload.returns < 0
    || (i.payload.asOf !== null && (typeof i.payload.asOf !== 'string' || i.payload.asOf.length > 40))
    || (i.payload.returnsDigest !== null && !HEX64.test(String(i.payload.returnsDigest))) || Number.isNaN(Date.parse(i.startedAt))
  if (bad) throw new Error('mục sổ báo cáo sau chốt không hợp lệ')
  return { kind: 'cms-qa-close-report-op', version: 1, ...i, status: 'intent', finishedAt: null, result: null }
}

export function parseCmsQaReportOp(text: string): { ok: true; value: CmsQaReportOp } | { ok: false; reason: string } {
  let o: Partial<CmsQaReportOp>
  try { o = JSON.parse(text) } catch { return { ok: false, reason: 'không phải JSON' } }
  if (!o || typeof o !== 'object' || o.kind !== 'cms-qa-close-report-op' || o.version !== 1) return { ok: false, reason: 'sai loại / phiên bản' }
  if (typeof o.operationId !== 'string' || !CMS_QA_REPORT_OP_ID_RE.test(o.operationId)) return { ok: false, reason: 'operationId sai' }
  if (typeof o.qaRunId !== 'string' || !RUN_ID_RE.test(o.qaRunId)) return { ok: false, reason: 'qaRunId sai' }
  if (typeof o.host !== 'string' || !o.host) return { ok: false, reason: 'host sai' }
  for (const k of ['programId', 'payoutRunId', 'idemKey', 'actorId'] as const) if (typeof o[k] !== 'string' || !UUID_RE.test(o[k] as string)) return { ok: false, reason: `${k} sai` }
  if (!Number.isInteger(o.pid) || (o.pid as number) <= 0) return { ok: false, reason: 'pid sai' }
  if (typeof o.startedAt !== 'string' || Number.isNaN(Date.parse(o.startedAt))) return { ok: false, reason: 'startedAt sai' }
  if (!o.payload || typeof o.payload.sha256 !== 'string' || !HEX64.test(o.payload.sha256)) return { ok: false, reason: 'payload sai' }
  if (!['intent', 'done', 'rejected', 'unknown', 'reconciled'].includes(o.status as string)) return { ok: false, reason: 'trạng thái sai' }
  if ((o.status === 'done' || o.status === 'rejected' || o.status === 'unknown') && !o.result) return { ok: false, reason: 'thiếu kết quả' }
  if (o.status === 'done' && (!o.result?.reportId || !UUID_RE.test(o.result.reportId) || (o.result.saved !== 'saved' && o.result.saved !== 'already'))) return { ok: false, reason: 'done thiếu id báo cáo' }
  if (o.status === 'reconciled' && (!o.reconcile || typeof o.reconcile.found !== 'boolean' || (o.reconcile.found && !UUID_RE.test(String(o.reconcile.reportId))))) return { ok: false, reason: 'thiếu đối chiếu' }
  return { ok: true, value: o as CmsQaReportOp }
}

/** Phản hồi của rpc_cms_return_close_report_save_super: { saved: true, already?, report_id } | { saved: false, code }. Khác ⇒ null. */
export function cmsQaReportReply(data: unknown): { saved: true; kind: 'saved' | 'already'; reportId: string } | { saved: false; code: string } | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const o = data as Record<string, unknown>
  if (o.saved === true) return typeof o.report_id === 'string' && UUID_RE.test(o.report_id) ? { saved: true, kind: o.already === true ? 'already' : 'saved', reportId: o.report_id } : null
  if (o.saved === false) return { saved: false, code: typeof o.code === 'string' && /^CMS_[A-Z0-9_]+$/.test(o.code) ? o.code : 'CMS_REPORT_HELD' }
  return null
}

/**
 * Kết cục một request lưu: 2xx + saved:true ⇒ done · 2xx + saved:false (DB giữ lại, không lập báo cáo) hoặc từ chối XÁC ĐỊNH ⇒ rejected ·
 * mất phản hồi / lỗi không phân loại / 2xx sai dạng ⇒ unknown (CÓ THỂ đã lập — chỉ reconcile kết luận).
 */
export function cmsQaReportOutcome(o: CmsAttestRpcOutcome): { status: 'done' | 'rejected' | 'unknown'; result: NonNullable<CmsQaReportOp['result']> } {
  if (o.kind === 'ok') {
    const r = cmsQaReportReply(o.data)
    if (!r) return { status: 'unknown', result: { code: 'REPLY_INVALID', saved: null, reportId: null } }
    if (r.saved) return { status: 'done', result: { code: null, saved: r.kind, reportId: r.reportId } }
    return { status: 'rejected', result: { code: r.code, saved: null, reportId: null } }
  }
  return { status: o.kind === 'rejected' ? 'rejected' : 'unknown', result: { code: o.code, saved: null, reportId: null } }
}

/** Thao tác CHƯA khép (intent / unknown) của cùng chương trình ⇒ chặn thao tác ghi mới tới khi reconcile. */
export function cmsQaReportPendingOps(ops: readonly CmsQaReportOp[], programId: string): CmsQaReportOp[] {
  return ops.filter((e) => e.programId === programId && (e.status === 'intent' || e.status === 'unknown'))
}

/** Khoá yêu cầu đã có trong sổ: chỉ được phát lại cho ĐÚNG chương trình + run chốt + người (DB trả báo cáo đã lập). */
export function cmsQaReportIdemReuse(ops: readonly CmsQaReportOp[], i: { idemKey: string; programId: string; payoutRunId: string; actorId: string }): string | null {
  const same = ops.find((e) => e.idemKey === i.idemKey)
  if (!same) return null
  return same.programId === i.programId && same.payoutRunId === i.payoutRunId && same.actorId === i.actorId ? null
    : `--idem đã dùng cho thao tác KHÁC (${same.operationId}) — không dùng lại khoá cho chương trình / run chốt / người khác`
}

/** Báo cáo đã lập theo sổ (done hoặc reconciled-found) ⇒ id; còn lại null. */
export function cmsQaReportLanded(e: CmsQaReportOp): string | null {
  if (e.status === 'done') return e.result?.reportId ?? null
  if (e.status === 'reconciled' && e.reconcile?.found) return e.reconcile.reportId
  return null
}

// ── Reconcile (đọc DB theo ĐÚNG chương trình + khoá yêu cầu) ────────────────────────────────────────────────────────────────

/** Bảng báo cáo + cột khoá yêu cầu (DB 132) đã có chưa. */
export const CMS_QA_HAS_REPORTS_SQL = `SELECT (to_regclass('public.cms_return_close_reports') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.cms_return_close_reports') AND attname = 'manual_request' AND NOT attisdropped)) AS has_reports`

export function cmsQaReportReconcileSql(e: Pick<CmsQaReportOp, 'programId' | 'idemKey'>): string {
  if (!UUID_RE.test(e.programId) || !UUID_RE.test(e.idemKey)) throw new Error('programId / idemKey không phải UUID')
  return `SELECT r.id::text AS id, r.program_id::text AS program_id, r.payout_run_id::text AS payout_run_id, r.created_via, r.created_by::text AS created_by
  FROM public.cms_return_close_reports r WHERE r.program_id = '${e.programId}'::uuid AND r.manual_request = '${e.idemKey}'::uuid`
}

/** Phiên DB đang chạy RPC lưu báo cáo (trừ chính phiên đọc). */
export const CMS_QA_REPORT_INFLIGHT_SQL = `SELECT
  (SELECT r.rolsuper OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') FROM pg_roles r WHERE r.rolname = current_user) AS can_see_all,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.pid <> pg_backend_pid() AND a.datname = current_database()
     AND a.backend_type = 'client backend' AND a.query = '<insufficient privilege>') AS hidden,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.pid <> pg_backend_pid() AND a.datname = current_database()
     AND a.backend_type = 'client backend' AND a.state IS DISTINCT FROM 'idle' AND a.query ILIKE '%rpc\\_cms\\_return\\_close\\_report%') AS inflight`

export interface CmsQaReportDbRow { id: string; program_id: string; payout_run_id: string; created_via: string; created_by: string | null }

export function cmsQaReportReconcileCheck(e: CmsQaReportOp, rows: readonly CmsQaReportDbRow[],
  o: { nowMs: number; pidAlive: boolean; probe: { can_see_all: boolean; hidden: number; inflight: number } | undefined }):
  { ok: true; found: boolean; reportId: string | null } | { ok: false; wait?: true; reason: string } {
  if (e.status === 'done' || e.status === 'rejected' || e.status === 'reconciled') return { ok: false, reason: `thao tác ${e.operationId} đã có kết quả (${e.status}) — không cần reconcile` }
  if (e.status === 'intent' && o.pidAlive) return { ok: false, wait: true, reason: `thao tác ${e.operationId} (pid ${e.pid}) còn chạy — chờ xong` }
  if (rows.length > 1) return { ok: false, reason: `${rows.length} báo cáo cùng khoá yêu cầu của ${e.operationId} — bất thường, báo PM / operator` }
  const row = rows[0]
  if (row) {
    // Đủ bộ: chương trình + run chốt + người lập + đường super — không nhận chỉ vì đúng khoá.
    const same = row.program_id === e.programId && row.payout_run_id === e.payoutRunId && row.created_by === e.actorId && row.created_via === 'super' && UUID_RE.test(row.id)
    if (!same) return { ok: false, reason: `khoá yêu cầu của ${e.operationId} đã gắn báo cáo KHÁC (run chốt / người / đường lập khác sổ) — điều tra, không tự nhận` }
    return { ok: true, found: true, reportId: row.id }
  }
  const pr = o.probe
  if (!pr || pr.can_see_all !== true || !Number.isInteger(pr.hidden) || pr.hidden > 0) {
    return { ok: false, reason: 'không chứng minh được không còn phiên lưu báo cáo (vai không thấy mọi phiên / có phiên ẩn) — chạy bằng vai superuser của pg-meta' }
  }
  if (!Number.isInteger(pr.inflight) || pr.inflight > 0) return { ok: false, wait: true, reason: `còn ${pr.inflight} phiên DB đang chạy RPC báo cáo — chờ rồi chạy lại reconcile` }
  const left = CMS_QA_REPORT_SETTLE_MS - (o.nowMs - Date.parse(e.finishedAt ?? e.startedAt))
  if (left > 0) return { ok: false, wait: true, reason: `chưa đủ thời gian lắng — chờ thêm ${Math.ceil(left / 1000)} s rồi chạy lại reconcile` }
  return { ok: true, found: false, reportId: null }
}

// ── Close run QA: sổ báo cáo ↔ DB ───────────────────────────────────────────────────────────────────────────────────────────

/** Mọi báo cáo sau chốt lập từ mốc run (kèm namespace chương trình). */
export function cmsQaRunReportsSql(startedAt: string): string {
  if (!ISO_UTC_RE.test(startedAt) || Number.isNaN(Date.parse(startedAt))) throw new Error('startedAt không hợp lệ')
  return `SELECT r.id::text AS id, r.program_id::text AS program_id, r.payout_run_id::text AS payout_run_id, r.created_via, r.created_by::text AS created_by,
       r.manual_request::text AS manual_request, p.is_test
  FROM public.cms_return_close_reports r JOIN public.cms_programs p ON p.id = r.program_id
 WHERE r.created_at >= '${startedAt}'::timestamptz ORDER BY r.created_at, r.id`
}

export interface CmsQaRunReportRow extends CmsQaReportDbRow { manual_request: string | null; is_test: boolean }

/**
 * Close: (1) sổ hỏng / thuộc run khác / sai tên / host khác ⇒ ĐỎ; thao tác intent (pid sống ⇒ chờ; chết ⇒ reconcile) / unknown ⇒ ĐỎ;
 * (2) báo cáo trong cửa sổ trên chương trình QA: phải là đường super, do tài khoản QA của run lập, chương trình thuộc run, và khớp ĐÚNG
 * một thao tác đã lập trong sổ (id báo cáo + chương trình + run chốt + khoá yêu cầu + người) — ngoài sổ ⇒ ĐỎ; (3) sổ ghi đã lập mà DB
 * không có báo cáo đó ⇒ ĐỎ; (4) chương trình THẬT: do tài khoản QA lập ⇒ ĐỎ, còn lại ⇒ cảnh báo (cần --ack-warnings).
 * DB chưa có bảng (trước 132) ⇒ chỉ kiểm sổ; sổ ghi đã lập ⇒ ĐỎ.
 */
export function cmsQaReportsCloseCheck(m: CmsQaRunManifest, files: readonly { name: string; text: string }[], rows: readonly CmsQaRunReportRow[],
  o: { pidAlive: (pid: number) => boolean; reportsTable: boolean; programIdsInRun: readonly string[] }):
  { reasons: string[]; entries: CmsQaReportOp[]; warningProgramIds: string[] } {
  const reasons: string[] = []
  const entries: CmsQaReportOp[] = []
  const rec = (id: string) => `chạy \`node scripts/cms-qa-report.mjs reconcile --op=${id} --confirm-run=${m.runId}\``
  for (const f of files) {
    const p = parseCmsQaReportOp(f.text)
    if (!p.ok) { reasons.push(`sổ báo cáo ${f.name} hỏng (${p.reason}) — không xoá tay; báo PM / operator`); continue }
    const e = p.value
    if (e.qaRunId !== m.runId) { reasons.push(`sổ báo cáo ${e.operationId} thuộc run khác`); continue }
    if (`${e.operationId}.json` !== f.name) { reasons.push(`sổ báo cáo ${f.name} sai tên file`); continue }
    if (e.host !== m.host) { reasons.push(`sổ báo cáo ${e.operationId} ghi cho host khác run`); continue }
    if (e.status === 'intent') reasons.push(o.pidAlive(e.pid) ? `thao tác báo cáo ${e.operationId} (pid ${e.pid}) CÒN CHẠY — chờ xong rồi mới close` : `thao tác báo cáo ${e.operationId} không rõ kết thúc — ${rec(e.operationId)}`)
    else if (e.status === 'unknown') reasons.push(`thao tác báo cáo ${e.operationId} kết thúc KHÔNG RÕ (${e.result?.code ?? '—'}; có thể đã lập) — ${rec(e.operationId)}`)
    entries.push(e)
  }
  const qaUsers = new Set(m.users.map((u) => u.id))
  const inRun = new Set(o.programIdsInRun)
  const landed = new Map<string, CmsQaReportOp>()
  for (const e of entries) { const id = cmsQaReportLanded(e); if (id) landed.set(id, e) }
  const warn = new Set<string>()
  const seen = new Set<string>()
  for (const r of rows) {
    seen.add(r.id)
    const byQa = r.created_by !== null && qaUsers.has(r.created_by)
    if (!r.is_test) {
      if (byQa || landed.has(r.id)) reasons.push(`báo cáo sau chốt ${mask(r.id)} của chương trình THẬT ${mask(r.program_id)} do tài khoản / công cụ QA lập — dừng, báo PM / operator`)
      else warn.add(r.program_id)
      continue
    }
    const e = landed.get(r.id)
    if (!inRun.has(r.program_id)) reasons.push(`chương trình QA ${mask(r.program_id)} ngoài run có báo cáo sau chốt trong cửa sổ — điều tra`)
    if (r.created_via !== 'super' || !byQa) reasons.push(`báo cáo QA ${mask(r.id)} không do tài khoản QA của run lập qua phiên super (đường ${r.created_via}) — điều tra`)
    if (!e) reasons.push(`báo cáo QA ${mask(r.id)} trên chương trình ${mask(r.program_id)} không có trong sổ của run — lập ngoài scripts/cms-qa-report.mjs`)
    else if (e.programId !== r.program_id || e.payoutRunId !== r.payout_run_id || e.idemKey !== r.manual_request || e.actorId !== r.created_by) {
      reasons.push(`báo cáo QA ${mask(r.id)} lệch thao tác ${e.operationId} trong sổ (chương trình / run chốt / khoá yêu cầu / người) — điều tra, không tự nhận`)
    }
  }
  for (const [id, e] of landed) {
    // `already` có thể trỏ báo cáo lập TRƯỚC mốc run (phát lại khoá cũ) — chỉ đỏ khi là báo cáo MỚI của lượt này mà DB không thấy.
    if (!seen.has(id) && !(e.status === 'done' && e.result?.saved === 'already')) {
      reasons.push(o.reportsTable ? `sổ ${e.operationId} ghi đã lập báo cáo ${mask(id)} nhưng DB không có báo cáo đó trong cửa sổ — điều tra` : `sổ ${e.operationId} ghi đã lập báo cáo nhưng DB chưa có bảng báo cáo — điều tra`)
    }
  }
  return { reasons, entries, warningProgramIds: [...warn] }
}

/** sha256 hex của chuỗi (lý do / JSON payload) — dùng cho sổ. */
export function cmsQaReportSha(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}
