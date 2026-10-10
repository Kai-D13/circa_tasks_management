import { carePeriodOf } from '@/lib/care/time'
import { CARE_ERROR_LABELS, CARE_IMPORT_HEADERS, type CareFileErrorCode, type CareImportRow, type CareRowError } from './contract'
import { parseCareImportXlsx } from './parse'
import { validateCareRows } from './validate'
import { buildCarePreview, type CareImportLookups, type CarePreview, type CarePreviewCounts } from './preview'

// CRM-CSKH B2 — lõi Route Handler preview/commit (SPEC B2 §2).
// Không import Next/Supabase: route.ts chỉ nối `CareImportDeps` thật (session,
// cờ, repo service role). Nhờ vậy test được ma trận quyền/byte-cap/multipart/409
// mà không cần DB (migration 114 chưa chạy prod ở B2).
//
// Thứ tự bắt buộc:
//   1. cờ CARE_ENABLED (OFF ⇒ 404, không lộ chức năng)
//   2. quyền từ SESSION thật (anonymous 401 · không quyền 403 · DB chưa sẵn 503)
//   3. byte-cap TRƯỚC mọi parse: thiếu Content-Length 411, vượt 413, body hụt/thừa 400
//   4. multipart → đúng một file .xlsx → parse/validate → lookups (service role,
//      chỉ SAU bước 2) → preview
//   5. commit: hash + kỳ phải khớp preview (409), không lỗi, rồi batch/staging/finalize.
// Client KHÔNG quyết định is_test/actor/kỳ/số đếm: mọi field khác bị bỏ qua.
// Phản hồi lỗi chỉ có MÃ (không message DB — có thể chứa dữ liệu khách).

export type CareImportAccess =
  | { kind: 'anonymous' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }
  | { kind: 'ok'; actorId: string }

export type CareFinalizeResult =
  | ({ status: 'committed'; batch_id: string; idempotent?: boolean } & Partial<CarePreviewCounts> & { kind?: string; customers?: number; stores?: number })
  | { status: 'duplicate'; batch_id: string; duplicate_of: string }
  | { status: 'rejected'; batch_id: string; error_count: number; errors: CareRowError[] }

export interface CareImportRepo {
  loadLookups(input: { externalIds: string[]; period: string; isTest: boolean }): Promise<CareImportLookups>
  createBatch(input: { period: string; fileName: string; sha256: string; rowCount: number; actorId: string; isTest: boolean }): Promise<string>
  stageRows(batchId: string, rows: { row_no: number; payload: Record<string, string> }[]): Promise<void>
  finalize(batchId: string, actorId: string): Promise<CareFinalizeResult>
  /** Xoá batch còn 'staged' (cascade staging) khi request lỗi giữa chừng. */
  discardBatch(batchId: string): Promise<void>
  /** Dọn batch 'staged' bị kẹt > 24h (process chết giữa chừng) — PII không nằm lại tới khi có cron B5. */
  purgeStaleStaging(): Promise<void>
}

export interface CareImportDeps {
  enabled: boolean
  maxBytes: number
  getAccess(): Promise<CareImportAccess>
  repo: CareImportRepo
  now(): Date
  /** Kích thước khối staging (mặc định 2.000 dòng). */
  stageChunk?: number
}

export type CareImportErrorCode =
  | 'NOT_FOUND' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'UNAVAILABLE'
  | 'LENGTH_REQUIRED' | 'PAYLOAD_TOO_LARGE' | 'BODY_INCOMPLETE' | 'MULTIPART_INVALID'
  | 'FILE_REQUIRED' | 'FILE_TYPE' | CareFileErrorCode
  | 'SHA_MISMATCH' | 'PERIOD_CHANGED' | 'HAS_ERRORS' | 'STAGING_FAILED' | 'FINALIZE_FAILED' | 'LOOKUP_FAILED' | 'PREVIEW_FAILED'

/** Repo ném Error(message này) khi finalize báo kỳ batch ≠ tháng hiện tại VN. */
export const CARE_PERIOD_CHANGED = 'care_import_period_changed'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
const fail = (status: number, code: CareImportErrorCode, extra: Record<string, unknown> = {}) =>
  json(status, { ok: false, code, message: (CARE_ERROR_LABELS as Record<string, string>)[code] ?? null, ...extra })

const XLSX_MIME = new Set(['', 'application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])

/** Đọc body có trần byte; không bao giờ đệm quá `max` byte. */
export async function readCappedBody(req: Request, max: number): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; res: Response }> {
  const header = req.headers.get('content-length')
  if (header === null) return { ok: false, res: fail(411, 'LENGTH_REQUIRED') }
  if (!/^\d+$/.test(header)) return { ok: false, res: fail(400, 'BODY_INCOMPLETE') }
  const declared = Number(header)
  if (declared > max) return { ok: false, res: fail(413, 'PAYLOAD_TOO_LARGE', { maxBytes: max }) }
  if (!req.body) return { ok: false, res: fail(400, 'BODY_INCOMPLETE') }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) { await reader.cancel().catch(() => {}); return { ok: false, res: fail(413, 'PAYLOAD_TOO_LARGE', { maxBytes: max }) } }
      if (total > declared) { await reader.cancel().catch(() => {}); return { ok: false, res: fail(400, 'BODY_INCOMPLETE') } }
      chunks.push(value)
    }
  } catch {
    return { ok: false, res: fail(400, 'BODY_INCOMPLETE') }
  }
  // Ít hơn Content-Length ⇒ bị cắt (proxy/cáp) — không parse dữ liệu hụt.
  if (total !== declared) return { ok: false, res: fail(400, 'BODY_INCOMPLETE') }
  const bytes = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength }
  return { ok: true, bytes }
}

async function readForm(req: Request, deps: CareImportDeps) {
  const body = await readCappedBody(req, deps.maxBytes)
  if (!body.ok) return body
  const ct = req.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().startsWith('multipart/form-data')) return { ok: false as const, res: fail(400, 'MULTIPART_INVALID') }
  let form: FormData
  try {
    form = await new Response(body.bytes, { headers: { 'content-type': ct } }).formData()
  } catch {
    return { ok: false as const, res: fail(400, 'MULTIPART_INVALID') }
  }
  const files = [...form.values()].filter((v): v is File => typeof v !== 'string')
  const file = form.get('file')
  if (!file || typeof file === 'string' || files.length !== 1) return { ok: false as const, res: fail(400, 'FILE_REQUIRED') }
  if (!/\.xlsx$/i.test(file.name) || !XLSX_MIME.has(file.type)) return { ok: false as const, res: fail(415, 'FILE_TYPE') }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength === 0) return { ok: false as const, res: fail(400, 'FILE_REQUIRED') }
  return { ok: true as const, form, bytes }
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function guard(deps: CareImportDeps): Promise<{ ok: true; actorId: string } | { ok: false; res: Response }> {
  if (!deps.enabled) return { ok: false, res: fail(404, 'NOT_FOUND') }
  const access = await deps.getAccess()
  if (access.kind === 'anonymous') return { ok: false, res: fail(401, 'UNAUTHENTICATED') }
  if (access.kind === 'forbidden') return { ok: false, res: fail(403, 'FORBIDDEN') }
  if (access.kind === 'unavailable') return { ok: false, res: fail(503, 'UNAVAILABLE') }
  return { ok: true, actorId: access.actorId }
}

type Analysis =
  | { ok: false; res: Response }
  | { ok: true; sha256: string; preview: CarePreview; rows: CareImportRow[] }

async function analyze(bytes: Uint8Array<ArrayBuffer>, deps: CareImportDeps): Promise<Analysis> {
  try {
    return await analyzeUnsafe(bytes, deps)
  } catch {
    // Lỗi không lường trước (thư viện Excel…) ⇒ mã ổn định, không lộ chi tiết.
    return { ok: false, res: fail(500, 'PREVIEW_FAILED') }
  }
}

async function analyzeUnsafe(bytes: Uint8Array<ArrayBuffer>, deps: CareImportDeps): Promise<Analysis> {
  const parsed = parseCareImportXlsx(bytes)
  if (!parsed.ok) return { ok: false, res: fail(422, parsed.fileError) }
  const validated = validateCareRows(parsed.rows)
  const period = carePeriodOf(deps.now())
  let lookups: CareImportLookups
  try {
    lookups = await deps.repo.loadLookups({
      externalIds: validated.customers.map((c) => c.externalId), period, isTest: false,
    })
  } catch {
    return { ok: false, res: fail(503, 'LOOKUP_FAILED') }
  }
  const preview = buildCarePreview({
    rowCount: parsed.rows.length, validated, parseErrors: parsed.errors, lookups, period, isTest: false,
  })
  return { ok: true, sha256: await sha256Hex(bytes), preview, rows: parsed.rows }
}

/** Giới hạn lỗi chi tiết trả về (vẫn kèm tổng). */
export const CARE_PREVIEW_ERROR_LIMIT = 500

export async function handleCarePreview(req: Request, deps: CareImportDeps): Promise<Response> {
  const g = await guard(deps)
  if (!g.ok) return g.res
  const f = await readForm(req, deps)
  if (!f.ok) return f.res
  const a = await analyze(f.bytes, deps)
  if (!a.ok) return a.res
  const { errors, ...rest } = a.preview
  return json(200, {
    ok: true,
    sha256: a.sha256,
    preview: { ...rest, errorCount: errors.length, errors: errors.slice(0, CARE_PREVIEW_ERROR_LIMIT) },
  })
}

export async function handleCareCommit(req: Request, deps: CareImportDeps): Promise<Response> {
  const g = await guard(deps)
  if (!g.ok) return g.res
  const f = await readForm(req, deps)
  if (!f.ok) return f.res
  const clientSha = String(f.form.get('sha256') ?? '')
  const clientPeriod = String(f.form.get('period') ?? '')
  const sha = await sha256Hex(f.bytes)
  if (!/^[0-9a-f]{64}$/.test(clientSha) || clientSha !== sha) return fail(409, 'SHA_MISMATCH')
  if (clientPeriod !== carePeriodOf(deps.now())) return fail(409, 'PERIOD_CHANGED', { period: carePeriodOf(deps.now()) })

  const a = await analyze(f.bytes, deps)
  if (!a.ok) return a.res
  if (a.preview.errors.length > 0) {
    return fail(422, 'HAS_ERRORS', { errorCount: a.preview.errors.length, errors: a.preview.errors.slice(0, CARE_PREVIEW_ERROR_LIMIT) })
  }

  const period = a.preview.period
  // Tên kỹ thuật vô hại (không dùng tên file người dùng — có thể chứa tên người).
  const fileName = `care-import-${period.slice(0, 7)}-${sha.slice(0, 12)}.xlsx`
  // Dọn cơ hội các batch staged bị kẹt (lỗi dọn không chặn import).
  await deps.repo.purgeStaleStaging().catch(() => {})
  let batchId: string
  try {
    batchId = await deps.repo.createBatch({ period, fileName, sha256: sha, rowCount: a.rows.length, actorId: g.actorId, isTest: false })
  } catch {
    return fail(500, 'STAGING_FAILED')
  }
  const chunk = deps.stageChunk ?? 2000
  try {
    for (let i = 0; i < a.rows.length; i += chunk) {
      await deps.repo.stageRows(batchId, a.rows.slice(i, i + chunk).map((r) => ({
        row_no: r.rowNo,
        payload: Object.fromEntries(CARE_IMPORT_HEADERS.map((h) => [h, r[h]])),
      })))
    }
  } catch {
    await deps.repo.discardBatch(batchId).catch(() => {})
    return fail(500, 'STAGING_FAILED')
  }
  let result: CareFinalizeResult
  try {
    result = await deps.repo.finalize(batchId, g.actorId)
  } catch (e) {
    // Finalize RAISE ⇒ transaction rollback, batch còn 'staged' ⇒ dọn ngay.
    await deps.repo.discardBatch(batchId).catch(() => {})
    if (e instanceof Error && e.message === CARE_PERIOD_CHANGED) return fail(409, 'PERIOD_CHANGED')
    return fail(500, 'FINALIZE_FAILED')
  }
  return json(200, { ok: true, result, previewCounts: a.preview.counts })
}

/** GET file mẫu — cùng cổng cờ + quyền như preview/commit. */
export async function handleCareTemplate(deps: Pick<CareImportDeps, 'enabled' | 'getAccess'>, build: () => Uint8Array<ArrayBuffer>): Promise<Response> {
  const g = await guard(deps as CareImportDeps)
  if (!g.ok) return g.res
  return new Response(build(), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="care_import_mau.xlsx"',
      'Cache-Control': 'no-store',
    },
  })
}
