// F-A (PM spec 17/11 §2–§3) — lõi Route Handler sửa chương trình có version. Không import Next / Supabase (route.ts nối deps thật) ⇒
// test được ma trận quyền / cờ / file lỗi / map mã DB mà không cần DB.
//
// Preview (multipart, như import): cờ (OFF / DB chưa 131 ⇒ 404) → super từ SESSION (401 / 403 / 503) → byte-cap + đúng một .xlsx →
// chương trình (namespace QA) nháp / đang chạy → cách tính → CHÍNH parser / validator / kiểm K / kiểm đơn vị của import ở chế độ
// 'replace' (file = TOÀN BỘ danh mục mong muốn) → file còn nhóm lỗi / dòng bị bỏ ⇒ dừng (không tự bỏ SP vì lỗi dòng, spec §2.4; trả
// tóm tắt lỗi + kiểm K để sửa / xác nhận) → dự toán tác động trước / sau trên CÙNG nguồn + mapping ghim (impact.ts) → RPC preview
// bằng session người gọi (DB kiểm super, diff theo ProductID, khoá thuộc tính ngoài phạm vi, lưu snapshot + impact, hạn 15 phút).
// Commit (JSON): cờ → super → same-origin → shape → RPC commit (preview_id + config_version + digest + idempotency + lý do + xác
// nhận) — KHÔNG nhận lại file / tóm tắt từ client; DB kiểm lại mọi điều kiện dưới khoá. Phản hồi lỗi chỉ MÃ + nhãn (không message DB).

import { sha256Hex } from '@/lib/care/import/handler'
import type { CmsAdminAccess, CmsImportDeps, CmsImportFormat } from '../import/handler'
import { cmsImportInternals, cmsImportPayload } from '../import/handler'
import { cmsImportIssueSummary } from '../import/issueSummary'
import { cmsParseKAckInput } from '../import/kCheck'
import type { CmsRevisionDesiredProduct, CmsRevisionImpactResult } from './impact'
import {
  CMS_REVISION_DB_ERRORS, CMS_REVISION_ERROR_LABELS, cmsRevisionReasonOk, parseCmsRevisionCommitReply, parseCmsRevisionPreviewReply,
  type CmsRevisionErrorCode,
} from './model'

const { guard, readForm, programFor, analyze, basisOf, json, ADVICE_PREVIEW_CHARS } = cmsImportInternals

export class CmsRevisionRpcError extends Error {
  /** `code` = mã RAISE (CMS_*) hoặc '' khi lỗi transport; `detail` = DETAIL của RAISE (ProductID) nếu có. */
  constructor(public readonly code: string, public readonly detail: string | null = null) { super(code || 'RPC_FAILED') }
}

/** Lỗi PostgREST / Postgres của RPC 131 ⇒ CmsRevisionRpcError (chỉ mã CMS_* + ProductID số; không message DB). r3 (db-reviewer P2-1):
 *  55P03 lock_timeout (preview FOR SHARE / commit FOR UPDATE chờ quá 5 s sau một lượt ghi / công bố dài) ⇒ CMS_SYNC_BUSY ("đang bận, thử
 *  lại") thay vì 500 — cùng tiền lệ importRepo / lockAction. */
export function cmsRevisionRpcErrorFrom(error: { code?: string | null; message?: string | null; details?: string | null } | null): CmsRevisionRpcError {
  if (String(error?.code ?? '') === '55P03') return new CmsRevisionRpcError('CMS_SYNC_BUSY')
  const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(error?.message ?? ''))
  const d = typeof error?.details === 'string' && /^[0-9]{1,19}$/.test(error.details) ? error.details : null
  return new CmsRevisionRpcError(m ? m[0] : '', d)
}

export interface CmsRevisionDeps {
  /** CMS_PROGRAM_ENABLED + CMS_PROGRAM_REVISION_ENABLED + năng lực DB 131. */
  enabled(): Promise<boolean>
  getAccess(): Promise<CmsAdminAccess>
  /** Deps import (repo đọc Product Master / trùng, kiểm K, cách tính) — dùng lại kiểm file. */
  importDeps: CmsImportDeps
  impact(programId: string, desired: CmsRevisionDesiredProduct[]): Promise<CmsRevisionImpactResult>
  /** RPC bằng SESSION người gọi (auth.uid() = super); ném CmsRevisionRpcError. */
  rpcPreview(p: Record<string, unknown>): Promise<unknown>
  /** Tên dược sĩ trong danh sách tác động (service role, sau khi đã kiểm super) — lỗi ⇒ {} (UI hiện mã người dùng rút gọn). */
  loadNames?(userIds: string[]): Promise<Record<string, string>>
  rpcCommit(a: { revisionId: string; expectedConfigVersion: number; payloadDigest: string; idempotencyKey: string; reason: string; ack: Record<string, unknown> }): Promise<unknown>
  now(): Date
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const COMMIT_MAX_BYTES = 16 * 1024

const rfail = (status: number, code: CmsRevisionErrorCode, extra: Record<string, unknown> = {}) =>
  json(status, { ok: false, code, message: CMS_REVISION_ERROR_LABELS[code], ...extra })

function dbFail(e: unknown, fallback: [number, CmsRevisionErrorCode]): Response {
  const code = e instanceof CmsRevisionRpcError ? e.code : ''
  const m = CMS_REVISION_DB_ERRORS[code] ?? fallback
  const detail = e instanceof CmsRevisionRpcError && e.detail && /^[0-9]{1,19}$/.test(e.detail) ? { productId: e.detail } : {}
  return rfail(m[0], m[1], detail)
}

async function gate(deps: CmsRevisionDeps): Promise<{ ok: true; actorId: string; qa: boolean } | { ok: false; res: Response }> {
  let on = false
  try { on = await deps.enabled() } catch { on = false }
  if (!on) return { ok: false, res: rfail(404, 'NOT_FOUND') }
  return guard({ ...deps.importDeps, enabled: true, getAccess: deps.getAccess })
}

export async function handleCmsRevisionPreview(req: Request, deps: CmsRevisionDeps): Promise<Response> {
  const g = await gate(deps)
  if (!g.ok) return g.res
  const f = await readForm(req)
  if (!f.ok) return f.res
  const program = await programFor(deps.importDeps, String(f.form.get('program_id') ?? ''), g.qa)
  if (!program) return rfail(404, 'PROGRAM_NOT_FOUND')
  if (program.status === 'locked') return rfail(409, 'LOCKED')
  if (program.status !== 'draft' && program.status !== 'active') return rfail(409, 'NOT_EDITABLE')
  const b = await basisOf(deps.importDeps, program.id)
  if (!b.ok) return b.res
  const fmtRaw = String(f.form.get('format') ?? 'tiers')
  if (fmtRaw !== 'tiers' && fmtRaw !== 'simple') return rfail(400, 'BAD_REQUEST')
  const format: CmsImportFormat = fmtRaw
  const v2 = deps.importDeps.v2 === true
  if (format === 'simple' && !v2) return cmsImportInternals.fail(400, 'FORMAT_UNAVAILABLE')
  const ackRaw = f.form.get('k_acks')
  const inputs = cmsParseKAckInput(typeof ackRaw === 'string' ? ackRaw : null)
  if (inputs === null || (inputs.length > 0 && !v2)) return cmsImportInternals.fail(400, 'K_ACK_INVALID')
  const at = deps.now().toISOString()
  // Chế độ 'replace' của validator: file là TOÀN BỘ danh mục; SP đang có không bị coi là trùng. Thuộc tính ngoài phạm vi do DB khoá.
  const a = await analyze(f.bytes, program, 'replace', deps.importDeps, {
    format, kCheck: v2, acks: { kind: 'input', inputs, actor: g.actorId, at }, basis: b.basis,
  })
  if (!a.ok) return a.res
  const sha = await sha256Hex(f.bytes)
  const kView = a.k ? {
    asOf: a.k.evidence.ok ? a.k.evidence.asOf : null, available: a.k.evidence.ok, reason: a.k.evidence.ok ? null : a.k.evidence.reason,
    products: a.k.results.map((x) => ({ ...x, ack: x.ack ? { source: x.ack.source, at: x.ack.at } : null })),
  } : undefined
  const analysis = {
    sha256: sha, format, configVersion: program.configVersion, quantityBasis: b.basis ?? null, ignoredFromRow: a.ignoredFromRow, stats: a.v.stats,
    groupsOk: a.v.groupsOk.map(({ adviceText, ...rest }) => ({
      ...rest, advicePreview: adviceText.length > ADVICE_PREVIEW_CHARS ? `${adviceText.slice(0, ADVICE_PREVIEW_CHARS)}…` : adviceText,
    })),
    groupsRejected: a.v.groupsRejected.map((r) => ({ key: r.key, excelRows: r.rows.map((x) => x.excelRow), errors: r.errors })),
    issueSummary: cmsImportIssueSummary(a.v.groupsRejected),
    ...(kView ? { kCheck: kView } : {}),
  }
  // Danh mục mong muốn phải ĐỦ: còn nhóm lỗi (kể cả K chưa xác nhận) / dòng sau ProductID trống bị bỏ ⇒ không lập revision.
  if (a.v.groupsRejected.length > 0 || a.ignoredFromRow !== null || a.v.groupsOk.length === 0) {
    return json(422, { ok: false, code: 'FILE_HAS_ERRORS', message: CMS_REVISION_ERROR_LABELS.FILE_HAS_ERRORS, analysis })
  }
  const payload = cmsImportPayload({ ...a.v, mode: 'replace' })
  let im: CmsRevisionImpactResult
  try {
    im = await deps.impact(program.id, payload.products)
  } catch {
    im = { ok: false, code: 'SNAPSHOT_FAILED' }
  }
  if (!im.ok) return rfail(503, 'SNAPSHOT_FAILED', { analysis })
  if (im.snapshot.configVersion !== program.configVersion) return rfail(409, 'PREVIEW_STALE', { analysis })
  const impact = {
    ...im.impact,
    // Kiểm K của lần preview (nguồn + xác nhận tay gắn actor / giờ server) — vết audit trong revision.
    ...(a.k ? { k_check: { as_of: a.k.evidence.ok ? a.k.evidence.asOf : null, available: a.k.evidence.ok, acks: a.k.acks } } : {}),
  }
  // r3 (PM P1-01): ghim run app ĐÃ dùng để dự toán (UUID hoặc null = chưa có run) — DB so dưới khoá với pointer hiện hành; lệch ⇒
  // PREVIEW_STALE. Không để DB tự lấy pointer mới.
  const expectedRunId = im.snapshot.currentResultRunId ?? null
  let reply
  try {
    const raw = await deps.rpcPreview({
      program_id: program.id, file_sha256: sha, catalog_target: payload.catalog_target, products: payload.products, impact, source: im.source,
      expected_run_id: expectedRunId,
    })
    reply = parseCmsRevisionPreviewReply(raw)
  } catch (e) {
    return dbFail(e, [500, 'PREVIEW_FAILED'])
  }
  if (!reply || reply.programId !== program.id || reply.expectedRunId !== expectedRunId || reply.fromConfigVersion !== program.configVersion) {
    return rfail(500, 'PREVIEW_FAILED')
  }
  let names: Record<string, string> = {}
  if (deps.loadNames && impact.persons.length) {
    try { names = await deps.loadNames(impact.persons.map((p) => p.user_id)) } catch { names = {} }
  }
  return json(200, { ok: true, analysis, revision: reply, impact, source: im.source, names })
}

export async function handleCmsRevisionCommit(req: Request, deps: CmsRevisionDeps): Promise<Response> {
  const g = await gate(deps)
  if (!g.ok) return g.res
  const site = req.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return rfail(403, 'CROSS_SITE')
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return rfail(400, 'BAD_REQUEST')
  const len = Number(req.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(len) && len > COMMIT_MAX_BYTES) return rfail(413, 'PAYLOAD_TOO_LARGE')
  let text: string
  try { text = await req.text() } catch { return rfail(400, 'BAD_REQUEST') }
  if (text.length > COMMIT_MAX_BYTES) return rfail(413, 'PAYLOAD_TOO_LARGE')
  let body: unknown
  try { body = JSON.parse(text) } catch { return rfail(400, 'BAD_REQUEST') }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return rfail(400, 'BAD_REQUEST')
  const o = body as Record<string, unknown>
  const ack = o.ack as Record<string, unknown> | undefined
  if (typeof o.revision_id !== 'string' || !UUID_RE.test(o.revision_id) || typeof o.idempotency_key !== 'string' || !UUID_RE.test(o.idempotency_key)
      || typeof o.expected_config_version !== 'number' || !Number.isSafeInteger(o.expected_config_version) || o.expected_config_version < 1
      || typeof o.payload_digest !== 'string' || !/^[0-9a-f]{64}$/.test(o.payload_digest) || typeof o.reason !== 'string'
      || typeof ack !== 'object' || ack === null || Array.isArray(ack) || !Array.isArray(ack.removed)
      || !ack.removed.every((x) => typeof x === 'string' && /^[0-9]{1,19}$/.test(x)) || ack.removed.length > 2000) {
    return rfail(400, 'BAD_REQUEST')
  }
  const reason = o.reason.trim()
  if (!cmsRevisionReasonOk(reason)) return rfail(422, 'REASON_REQUIRED')
  // Tick phải TƯỜNG MINH true (không mặc định) — DB kiểm lại cùng danh sách SP bị bỏ của diff đã lưu.
  if (ack.whole_period !== true || ack.may_decrease !== true) return rfail(422, 'ACK_REQUIRED')
  try {
    const raw = await deps.rpcCommit({
      revisionId: o.revision_id, expectedConfigVersion: o.expected_config_version, payloadDigest: o.payload_digest,
      idempotencyKey: o.idempotency_key, reason, ack: { whole_period: true, may_decrease: true, removed: [...ack.removed as string[]].sort() },
    })
    const r = parseCmsRevisionCommitReply(raw)
    if (!r) return rfail(500, 'COMMIT_FAILED')
    return json(200, { ok: true, result: r })
  } catch (e) {
    return dbFail(e, [500, 'COMMIT_FAILED'])
  }
}
