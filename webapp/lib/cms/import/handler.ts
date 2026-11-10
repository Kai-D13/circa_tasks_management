// CMS P1-b — lõi Route Handler import (docs/cms/SPEC.md §4.5–§4.7). Không import Next / Supabase: route.ts chỉ nối
// CmsImportDeps thật (cờ, session super admin, repo service role) ⇒ test được ma trận quyền / byte-cap / multipart /
// 409 mà không cần DB.
//
// Thứ tự bắt buộc (mẫu lib/care/import/handler.ts):
//   1. cờ CMS_PROGRAM_ENABLED (OFF ⇒ 404, không lộ chức năng);
//   2. quyền từ SESSION thật: super admin (anonymous 401 · không quyền 403 · lỗi tra quyền 503);
//   3. trần byte TRƯỚC mọi parse (thiếu Content-Length 411, vượt 413, body hụt / thừa 400);
//   4. multipart ⇒ đúng một file .xlsx (415) ⇒ chương trình (namespace QA H9b) ⇒ chế độ theo trạng thái + ngày VN ⇒
//      parse ⇒ tra Product Master / trùng ⇒ validate ⇒ lưu run (preview);
//   5. commit: hash = run, parse + validate LẠI theo cấu hình / nguồn hiện tại; digest khác preview ⇒ 409 (xem preview
//      mới, không tự commit tập khác); RPC kiểm lại trạng thái / ngày / config_version / trùng trong transaction.
// Client KHÔNG quyết định is_test / actor / mode / số đếm. Phản hồi lỗi chỉ có MÃ (+ nhãn), không message DB.
// CMS-UNIT (PM spec 09/11 §4): chương trình cơ sở cms_unit ⇒ MỌI mẫu file (kể cả 9 cột v1, cờ import v2 OFF) chạy kiểm unit_CMS
//   (unitCheck.ts) + kiểm K / bằng chứng "đã bán theo ĐV này" với khoá cmsUnitKey (không có đường bypass qua file v1); digest gắn cơ
//   sở. Cơ sở do DB (chương trình) quyết, client không gửi được; import không đổi cơ sở chương trình.

import { readCappedBody, sha256Hex } from '@/lib/care/import/handler'
import { canonicalProductId } from '@/lib/cms/productId'
import { parseCmsImportXlsx, type CmsParseError } from './parse'
import {
  CMS_TIER_POLICY, canonicalCmsImport, validateCmsImport,
  type CmsImportGroupOk, type CmsImportMode, type CmsImportValidation, type CmsProductMasterLite,
} from './validate'
import { buildCmsImportErrorXlsx, buildCmsSimpleErrorXlsx, type CmsRejectedGroupRaw } from './workbooks'
import { parseCmsSimpleXlsx } from './parseSimple'
import { validateCmsSimpleImport } from './validateSimple'
import {
  cmsApplyKCheck, cmsBindKAcks, cmsKClassify, cmsKTargets, cmsKUnitNorm, cmsParseKAckInput, cmsStoredKAcks,
  type CmsKAck, type CmsKAckInput, type CmsKEvidence, type CmsKResult,
} from './kCheck'
import { cmsApplyUnitBasisCheck } from './unitCheck'
import type { CmsQuantityBasis } from '../unitBasis'

export const CMS_IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024
/** CMS đơn giản S1: loại file do UI chọn TƯỜNG MINH; 'tiers' = IMPORT_CMS 9 cột (mặc định, như cũ), 'simple' = 7 cột mức cố định. */
export type CmsImportFormat = 'tiers' | 'simple'
/** Trần request = file + phần đầu multipart. */
export const CMS_IMPORT_MAX_REQUEST_BYTES = CMS_IMPORT_MAX_FILE_BYTES + 64 * 1024
const ADVICE_PREVIEW_CHARS = 300
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CmsAdminAccess =
  | { kind: 'anonymous' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }
  /** `qa`: người gọi có marker QA còn hạn (H9 / H9b) — quyết định namespace chương trình đọc / tạo được. */
  | { kind: 'ok'; actorId: string; qa: boolean }

export type CmsProgramStatus = 'draft' | 'active' | 'locked'

export interface CmsProgramRow {
  id: string
  status: CmsProgramStatus
  startDate: string
  endDate: string
  isTest: boolean
  configVersion: number
  /** bigint dạng chuỗi (đọc ::text, không qua number JS). */
  catalogTargetGmv: string | null
  /** CMS-UNIT (128): cơ sở tính của chương trình; thiếu (DB trước 128 / fixture cũ) ⇒ pos_base. */
  quantityBasis?: CmsQuantityBasis
}

/** Kiểm K / bằng chứng đơn vị bắt buộc: cờ import v2 HOẶC chương trình cms_unit (mọi mẫu file). */
export function cmsImportKRequired(deps: Pick<CmsImportDeps, 'v2'>, program: Pick<CmsProgramRow, 'quantityBasis'>): boolean {
  return deps.v2 === true || program.quantityBasis === 'cms_unit'
}

/** Phần `result` lưu trong cms_import_runs (raw cells của nhóm bị loại để sinh file lỗi — SPEC §4.6). */
export interface CmsStoredImportResult {
  digest: string
  ignoredFromRow: number | null
  rejected: CmsRejectedGroupRaw[]
  /** CMS-Q-220: chính sách bậc của lần kiểm (preview lập trước chính sách không có field này). */
  tierPolicy?: typeof CMS_TIER_POLICY
  /** Cận cuối hữu hạn đã chuẩn hoá → không giới hạn (audit; file gốc / SHA / raw không đổi). */
  normalizedLastTiers?: { productId: string; excelRow: number; from: number; originalTo: number }[]
  /** CMS đơn giản S1: chỉ có khi file mức cố định — commit parse lại theo CHÍNH giá trị này (không theo client). */
  format?: 'simple'
  /** S2: kết quả kiểm K lúc preview (chỉ khi CMS_IMPORT_V2_ENABLED) — để trình bày / audit; commit kiểm lại. */
  kCheck?: { asOf: string | null; available: boolean; reason: string | null; products: CmsKResult[] }
  /** S2: xác nhận tay đã áp — actor từ phiên super, thời điểm server, nguồn căn cứ; commit đọc lại từ đây (không từ client). */
  kAcks?: CmsKAck[]
}

export interface CmsImportRunRow {
  id: string
  programId: string
  mode: CmsImportMode
  status: 'previewed' | 'committed'
  fileSha256: string
  configVersionAtPreview: number
  result: CmsStoredImportResult
}

export interface CmsImportContextData {
  productMaster: Map<string, CmsProductMasterLite>
  existingProductIds: Set<string>
  conflictProductIds: Set<string>
}

export interface CmsImportPayloadProduct {
  product_id: string
  gmv_basis: CmsImportGroupOk['gmvBasis']
  target_gmv: string | null
  unit_cms: string
  base_quantity_cms: string
  advice_text: string
  name_snapshot: string
  image_url_snapshot: string | null
  price_snapshot: string | null
  tiers: { order: number; from: number; to: number | null; amount: string }[]
}

export interface CmsImportPayload {
  mode: CmsImportMode
  products: CmsImportPayloadProduct[]
  catalog_target: string | null
}

export type CmsImportStats = CmsImportValidation['stats']

/** Repo ném `CmsRepoError(code)` với code = mã RAISE của RPC (CMS_*) hoặc mã nội bộ. */
export class CmsRepoError extends Error {
  constructor(public readonly code: string) { super(code) }
}

export interface CmsImportRepo {
  getProgram(id: string): Promise<CmsProgramRow | null>
  /** Product Master + SP đã có trong chương trình + ProductID trùng chương trình active / locked giao ngày, cùng is_test. */
  loadContext(program: CmsProgramRow, productIds: string[]): Promise<CmsImportContextData>
  savePreview(input: {
    programId: string; mode: CmsImportMode; fileName: string; sha256: string; fileBytes: number; actorId: string
    stats: CmsImportStats; result: CmsStoredImportResult
  }): Promise<string>
  commit(input: { runId: string; sha256: string; digest: string; payload: CmsImportPayload; actorId: string }):
    Promise<{ already: boolean; mode?: CmsImportMode; products?: number }>
  getRun(id: string): Promise<CmsImportRunRow | null>
  /** CMS-UNIT: DB có capability 128 (probe chỉ đọc). Không có ⇒ action không tạo chương trình cms_unit. */
  unitBasisCapable?(): Promise<boolean>
}

export interface CmsImportDeps {
  enabled: boolean
  /** CMS_IMPORT_V2_ENABLED (mặc định OFF): mẫu mức cố định + kiểm K. OFF ⇒ hành vi như trước (chỉ 9 cột, không kiểm K). */
  v2?: boolean
  /** Bằng chứng quy đổi đơn vị (kSource) cho ProductID của file. Chỉ gọi khi v2. */
  kProbe?(productIds: string[]): Promise<CmsKEvidence>
  getAccess(): Promise<CmsAdminAccess>
  repo: CmsImportRepo
  now(): Date
}

export type CmsImportErrorCode =
  | 'NOT_FOUND' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'UNAVAILABLE'
  | 'LENGTH_REQUIRED' | 'PAYLOAD_TOO_LARGE' | 'BODY_INCOMPLETE' | 'MULTIPART_INVALID' | 'FILE_REQUIRED' | 'FILE_TYPE' | 'FILE_TOO_LARGE'
  | 'BAD_REQUEST' | 'PROGRAM_NOT_FOUND' | 'RUN_NOT_FOUND' | 'NOT_EDITABLE' | 'CROSS_SITE'
  | CmsParseError
  | 'SHA_MISMATCH' | 'PREVIEW_STALE' | 'NOTHING_TO_COMMIT' | 'PRODUCT_CONFLICT' | 'PRODUCT_EXISTS' | 'CATALOG_TARGET_CHANGED'
  | 'LOOKUP_FAILED' | 'PREVIEW_FAILED' | 'COMMIT_FAILED' | 'NO_ERRORS' | 'BUSY'
  | 'DUPLICATE_COLUMNS' | 'FORMAT_UNAVAILABLE' | 'K_ACK_INVALID' | 'UNIT_INVALID'

export const CMS_IMPORT_ERROR_LABELS: Record<CmsImportErrorCode, string> = {
  NOT_FOUND: 'Không tìm thấy',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn',
  FORBIDDEN: 'Chỉ super admin được nạp danh mục CMS',
  UNAVAILABLE: 'Không kiểm tra được quyền — thử lại sau',
  LENGTH_REQUIRED: 'Thiếu độ dài request',
  PAYLOAD_TOO_LARGE: 'File vượt 5 MiB',
  BODY_INCOMPLETE: 'Request bị cắt hoặc sai độ dài — tải lại file',
  MULTIPART_INVALID: 'Request không hợp lệ',
  FILE_REQUIRED: 'Chọn đúng một file .xlsx',
  FILE_TYPE: 'Chỉ nhận file .xlsx',
  FILE_TOO_LARGE: 'File vượt 5 MiB',
  BAD_REQUEST: 'Thiếu hoặc sai mã chương trình / lần kiểm tra',
  PROGRAM_NOT_FOUND: 'Không tìm thấy chương trình',
  RUN_NOT_FOUND: 'Không tìm thấy lần kiểm tra file',
  NOT_EDITABLE: 'Chương trình đã chốt — không nạp thêm',
  NOT_XLSX: 'File không phải .xlsx hợp lệ',
  FILE_TOO_COMPLEX: 'File giải nén quá lớn hoặc quá nhiều thành phần — lưu lại từ mẫu 9 cột',
  CROSS_SITE: 'Request không hợp lệ',
  NO_SHEET: 'Không có sheet IMPORT_CMS',
  MISSING_COLUMNS: 'Thiếu cột bắt buộc (mẫu cũ thiếu unit_CMS / base_quantity_CMS?) — tải mẫu mới',
  TOO_MANY_ROWS: 'Vượt 2.000 dòng dữ liệu',
  NO_DATA: 'Không có dòng dữ liệu nào sau dòng tiêu đề',
  SHA_MISMATCH: 'File khác file đã kiểm tra — kiểm tra lại',
  PREVIEW_STALE: 'Cấu hình hoặc dữ liệu nguồn đã thay đổi sau lần kiểm tra — kiểm tra lại file',
  NOTHING_TO_COMMIT: 'Không có sản phẩm hợp lệ để ghi',
  PRODUCT_CONFLICT: 'Có sản phẩm vừa thuộc chương trình khác đang chạy cùng thời gian — kiểm tra lại file',
  PRODUCT_EXISTS: 'Có sản phẩm đã nằm trong chương trình — kiểm tra lại file',
  CATALOG_TARGET_CHANGED: 'Target danh mục không được đổi giữa kỳ — kiểm tra lại file',
  LOOKUP_FAILED: 'Không tra được Product Master — thử lại sau',
  PREVIEW_FAILED: 'Không lưu được kết quả kiểm tra — thử lại sau',
  COMMIT_FAILED: 'Không ghi được danh mục — thử lại sau',
  NO_ERRORS: 'Lần kiểm tra này không có nhóm bị loại',
  BUSY: 'Đang có thao tác khác trên danh mục CMS — thử lại sau ít giây',
  DUPLICATE_COLUMNS: 'Có hai cột cùng ý nghĩa trong dòng tiêu đề — giữ một cột',
  FORMAT_UNAVAILABLE: 'Mẫu mức cố định chưa được bật',
  // r1 (PM 10/11 UNIT-P2-3): DB 128 từ chối ĐV tính CMS không có khoá đơn vị hợp lệ của chương trình cms_unit (0 ghi).
  UNIT_INVALID: 'Có ĐV tính CMS không hợp lệ (trống, ký tự điều khiển hoặc ký tự vô hình) — gõ lại ô unit_CMS rồi kiểm tra lại file',
  K_ACK_INVALID: 'Xác nhận K không hợp lệ — mỗi dòng cần ProductID, đơn vị, K và nguồn căn cứ (3–200 ký tự)',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
const fail = (status: number, code: CmsImportErrorCode, extra: Record<string, unknown> = {}) =>
  json(status, { ok: false, code, message: CMS_IMPORT_ERROR_LABELS[code] ?? null, ...extra })

/** Ngày VN (UTC+7, không DST) dạng YYYY-MM-DD. */
export function cmsVnToday(now: Date): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10)
}

/** SPEC §4.7: nháp / active chưa bắt đầu ⇒ replace; active đã bắt đầu ⇒ append; đã chốt ⇒ null. */
export function cmsImportModeFor(p: Pick<CmsProgramRow, 'status' | 'startDate'>, today: string): CmsImportMode | null {
  if (p.status === 'draft') return 'replace'
  if (p.status === 'active') return today < p.startDate ? 'replace' : 'append'
  return null
}

export function cmsImportPayload(v: Pick<CmsImportValidation, 'mode' | 'groupsOk' | 'catalogTarget'>): CmsImportPayload {
  return {
    mode: v.mode,
    catalog_target: v.groupsOk.some((g) => g.gmvBasis === 'catalog') ? v.catalogTarget : null,
    products: v.groupsOk.map((g) => ({
      product_id: g.productId, gmv_basis: g.gmvBasis, target_gmv: g.targetGmv, unit_cms: g.unitCms,
      base_quantity_cms: g.baseQuantityCms, advice_text: g.adviceText, name_snapshot: g.nameSnapshot,
      image_url_snapshot: g.imageUrlSnapshot, price_snapshot: g.priceSnapshot,
      tiers: g.tiers.map((t) => ({ order: t.order, from: t.from, to: t.to, amount: t.amount })),
    })),
  }
}

const XLSX_MIME = new Set(['', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream', 'application/zip'])

async function guard(deps: CmsImportDeps): Promise<{ ok: true; actorId: string; qa: boolean } | { ok: false; res: Response }> {
  if (!deps.enabled) return { ok: false, res: fail(404, 'NOT_FOUND') }
  const a = await deps.getAccess()
  if (a.kind === 'anonymous') return { ok: false, res: fail(401, 'UNAUTHENTICATED') }
  if (a.kind === 'forbidden') return { ok: false, res: fail(403, 'FORBIDDEN') }
  if (a.kind === 'unavailable') return { ok: false, res: fail(503, 'UNAVAILABLE') }
  return { ok: true, actorId: a.actorId, qa: a.qa }
}

/** Chặn POST từ site khác (bổ sung SameSite=Lax của cookie phiên): trình duyệt gửi Sec-Fetch-Site; chỉ nhận same-origin. */
function crossSite(req: Request): boolean {
  const s = req.headers.get('sec-fetch-site')
  return s !== null && s !== 'same-origin'
}

async function readForm(req: Request) {
  if (crossSite(req)) return { ok: false as const, res: fail(403, 'CROSS_SITE') }
  const body = await readCappedBody(req, CMS_IMPORT_MAX_REQUEST_BYTES)
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
  if (!/\.xlsx$/i.test(file.name) || !XLSX_MIME.has(file.type.toLowerCase())) return { ok: false as const, res: fail(415, 'FILE_TYPE') }
  if (file.size > CMS_IMPORT_MAX_FILE_BYTES) return { ok: false as const, res: fail(413, 'FILE_TOO_LARGE') }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength === 0) return { ok: false as const, res: fail(400, 'FILE_REQUIRED') }
  return { ok: true as const, form, bytes, fileName: file.name }
}

/** Chương trình theo id, áp namespace QA (H9b): chương trình test chỉ hiện với người có marker. */
async function programFor(deps: CmsImportDeps, id: string, qa: boolean): Promise<CmsProgramRow | null> {
  if (!UUID_RE.test(id)) return null
  const p = await deps.repo.getProgram(id)
  return p && (!p.isTest || qa) ? p : null
}

type Analysis =
  | { ok: true; v: CmsImportValidation; digest: string; ignoredFromRow: number | null; supplement: { baseQuantity: boolean; advice: boolean } | null
    k: { evidence: CmsKEvidence; before: CmsKResult[]; results: CmsKResult[]; acks: CmsKAck[] } | null }
  | { ok: false; res: Response }

interface AnalyzeOpts {
  format: CmsImportFormat
  /** S2 bật (cờ v2): kiểm K. */
  kCheck: boolean
  /** Xác nhận tay: preview = ý định từ client (gắn actor / giờ server); commit = bản ĐÃ LƯU trong run. */
  acks: { kind: 'input'; inputs: CmsKAckInput[]; actor: string; at: string } | { kind: 'stored'; acks: CmsKAck[] }
}

async function analyze(bytes: Uint8Array, program: CmsProgramRow, mode: CmsImportMode, deps: CmsImportDeps, o: AnalyzeOpts): Promise<Analysis> {
  const sp = o.format === 'simple' ? parseCmsSimpleXlsx(bytes) : null
  const parsed = sp ?? parseCmsImportXlsx(bytes)
  if (!parsed.ok) {
    const extra: Record<string, unknown> = {}
    if (parsed.missing) extra.missing = parsed.missing
    if ('duplicate' in parsed && parsed.duplicate) extra.duplicate = parsed.duplicate
    return { ok: false, res: fail(422, parsed.error, extra) }
  }
  const ids = new Set<string>()
  for (const r of parsed.rows) {
    const c = r.cells.ProductID
    const id = canonicalProductId(c.kind === 'number' || c.kind === 'text' ? c.value : null)
    if (id.ok) ids.add(id.id)
  }
  let ctx: CmsImportContextData
  try {
    ctx = await deps.repo.loadContext(program, [...ids].sort())
  } catch {
    return { ok: false, res: fail(503, 'LOOKUP_FAILED') }
  }
  const vctx = {
    mode, productMaster: ctx.productMaster, existingProductIds: ctx.existingProductIds,
    conflictProductIds: ctx.conflictProductIds, currentCatalogTarget: program.catalogTargetGmv,
  }
  let v = sp ? validateCmsSimpleImport(parsed.rows, vctx) : validateCmsImport(parsed.rows, vctx)
  const basis: CmsQuantityBasis = program.quantityBasis ?? 'pos_base'
  const norm = cmsKUnitNorm(basis)
  // CMS-UNIT: unit_CMS là mẫu so khớp của engine ⇒ ký tự điều khiển / khoá rỗng ⇒ loại nhóm (mọi mẫu file).
  if (basis === 'cms_unit') v = cmsApplyUnitBasisCheck(v, parsed.rows)
  let k: Extract<Analysis, { ok: true }>['k'] = null
  if (o.kCheck) {
    // S2: kiểm K trên MỌI SP đọc được của file (kể cả nhóm đã bị loại vì thiếu K — để hiện đề xuất). Nguồn lỗi ⇒ KHÔNG KIỂM ĐƯỢC.
    const targets = cmsKTargets(parsed.rows, norm)
    let evidence: CmsKEvidence
    try {
      evidence = targets.length && deps.kProbe ? await deps.kProbe(targets.map((t) => t.productId)) : { ok: false, reason: 'CONFIG' }
    } catch {
      evidence = { ok: false, reason: 'SOURCE_UNKNOWN' }
    }
    const before = cmsKClassify(targets, evidence, [], norm)
    const acks = o.acks.kind === 'stored' ? o.acks.acks : cmsBindKAcks(o.acks.inputs, before, o.acks.actor, o.acks.at)
    const results = acks.length ? cmsKClassify(targets, evidence, acks, norm) : before
    v = cmsApplyKCheck(v, parsed.rows, results)
    k = { evidence, before, results, acks: results.flatMap((x) => (x.ack ? [x.ack] : [])) }
  }
  const digest = await sha256Hex(new TextEncoder().encode(canonicalCmsImport(v, o.format, basis)))
  return { ok: true, v, digest, ignoredFromRow: parsed.ignoredFromRow, supplement: sp && sp.ok ? sp.supplement : null, k }
}

// Raw lưu trong run có trần độ dài từng ô (security review P1-b, P1-2): ô dài hơn trần chắc chắn đã lỗi (tư vấn
// > 4.000 ký tự, cột số / mã / đơn vị > 200 ký tự) nên cắt không làm mất dữ liệu sửa được.
const RAW_MAX_ADVICE = 4100
const RAW_MAX_OTHER = 200
const clip = (v: string | number | null, max: number) => (typeof v === 'string' && v.length > max ? `${v.slice(0, max)}…` : v)
const rejectedRaw = (v: CmsImportValidation): CmsRejectedGroupRaw[] =>
  v.groupsRejected.map((g) => ({
    key: clip(g.key, RAW_MAX_OTHER) as string,
    rows: g.rows.map((r) => ({
      excelRow: r.excelRow,
      raw: Object.fromEntries(Object.entries(r.raw).map(([k, x]) => [k, clip(x, k === 'Noi_dung_tu_van' ? RAW_MAX_ADVICE : RAW_MAX_OTHER)])) as typeof r.raw,
      ...(r.info ? { info: Object.fromEntries(Object.entries(r.info).map(([k, x]) => [k, clip(x, RAW_MAX_OTHER)])) } : {}),
    })),
    errors: g.errors,
  }))

const normalizedLastTiers = (v: CmsImportValidation): NonNullable<CmsStoredImportResult['normalizedLastTiers']> =>
  v.groupsOk.flatMap((g) => {
    if (g.normalizedLastTo === null) return []
    const last = g.tiers[g.tiers.length - 1]
    const row = g.warnings.find((w) => w.code === 'LAST_TIER_UNBOUNDED_NORMALIZED')?.excelRow ?? 0
    return [{ productId: g.productId, excelRow: row, from: last.from, originalTo: g.normalizedLastTo }]
  })

export async function handleCmsImportPreview(req: Request, deps: CmsImportDeps): Promise<Response> {
  const g = await guard(deps)
  if (!g.ok) return g.res
  const f = await readForm(req)
  if (!f.ok) return f.res
  const program = await programFor(deps, String(f.form.get('program_id') ?? ''), g.qa)
  if (!program) return fail(404, 'PROGRAM_NOT_FOUND')
  const mode = cmsImportModeFor(program, cmsVnToday(deps.now()))
  if (!mode) return fail(409, 'NOT_EDITABLE')
  const fmtRaw = String(f.form.get('format') ?? 'tiers')
  if (fmtRaw !== 'tiers' && fmtRaw !== 'simple') return fail(400, 'BAD_REQUEST')
  const format: CmsImportFormat = fmtRaw
  if (format === 'simple' && !deps.v2) return fail(400, 'FORMAT_UNAVAILABLE')
  const kReq = cmsImportKRequired(deps, program)
  const ackRaw = f.form.get('k_acks')
  const inputs = cmsParseKAckInput(typeof ackRaw === 'string' ? ackRaw : null, cmsKUnitNorm(program.quantityBasis))
  if (inputs === null || (inputs.length > 0 && !kReq)) return fail(400, 'K_ACK_INVALID')
  const a = await analyze(f.bytes, program, mode, deps, {
    format, kCheck: kReq, acks: { kind: 'input', inputs, actor: g.actorId, at: deps.now().toISOString() },
  })
  if (!a.ok) return a.res
  const sha = await sha256Hex(f.bytes)
  let runId: string
  try {
    runId = await deps.repo.savePreview({
      programId: program.id, mode, sha256: sha, fileBytes: f.bytes.byteLength, actorId: g.actorId, stats: a.v.stats,
      // Tên kỹ thuật (không lưu tên file người dùng).
      fileName: `cms-import-${format === 'simple' ? 'muc-co-dinh-' : ''}${sha.slice(0, 12)}.xlsx`,
      result: {
        digest: a.digest, ignoredFromRow: a.ignoredFromRow, rejected: rejectedRaw(a.v),
        tierPolicy: CMS_TIER_POLICY, normalizedLastTiers: normalizedLastTiers(a.v),
        ...(format === 'simple' ? { format: 'simple' as const } : {}),
        ...(a.k ? {
          kCheck: { asOf: a.k.evidence.ok ? a.k.evidence.asOf : null, available: a.k.evidence.ok, reason: a.k.evidence.ok ? null : a.k.evidence.reason, products: a.k.results },
          kAcks: a.k.acks,
        } : {}),
      },
    })
  } catch (e) {
    const code = e instanceof CmsRepoError ? e.code : ''
    if (code === 'CMS_PROGRAM_NOT_EDITABLE') return fail(409, 'NOT_EDITABLE')
    if (code === 'CMS_IMPORT_CONFLICT') return fail(409, 'PREVIEW_STALE')
    if (code === 'BUSY') return fail(503, 'BUSY')
    return fail(500, 'PREVIEW_FAILED')
  }
  return json(200, {
    ok: true, runId, sha256: sha, mode, configVersion: program.configVersion, catalogTarget: a.v.catalogTarget, tierPolicy: CMS_TIER_POLICY,
    ignoredFromRow: a.ignoredFromRow, stats: a.v.stats, format, quantityBasis: program.quantityBasis ?? 'pos_base',
    ...(a.supplement ? { supplement: a.supplement } : {}),
    ...(a.k ? { kCheck: {
      asOf: a.k.evidence.ok ? a.k.evidence.asOf : null, available: a.k.evidence.ok, reason: a.k.evidence.ok ? null : a.k.evidence.reason,
      // Phản hồi tối thiểu: xác nhận chỉ trả nguồn + thời điểm (actor lưu trong run, không gửi lại trình duyệt).
      products: a.k.results.map((x) => ({ ...x, ack: x.ack ? { source: x.ack.source, at: x.ack.at } : null })),
    } } : {}),
    groupsOk: a.v.groupsOk.map(({ adviceText, ...rest }) => ({
      ...rest, advicePreview: adviceText.length > ADVICE_PREVIEW_CHARS ? `${adviceText.slice(0, ADVICE_PREVIEW_CHARS)}…` : adviceText,
    })),
    groupsRejected: a.v.groupsRejected.map((r) => ({ key: r.key, excelRows: r.rows.map((x) => x.excelRow), errors: r.errors })),
  })
}

const COMMIT_ERRORS: Record<string, [number, CmsImportErrorCode]> = {
  CMS_IMPORT_CONFLICT: [409, 'PREVIEW_STALE'],
  CMS_PROGRAM_NOT_EDITABLE: [409, 'NOT_EDITABLE'],
  CMS_IMPORT_PRODUCT_CONFLICT: [409, 'PRODUCT_CONFLICT'],
  CMS_IMPORT_PRODUCT_EXISTS: [409, 'PRODUCT_EXISTS'],
  CMS_IMPORT_CATALOG_TARGET_CHANGED: [409, 'CATALOG_TARGET_CHANGED'],
  CMS_IMPORT_RUN_NOT_FOUND: [404, 'RUN_NOT_FOUND'],
  // SP biến khỏi Product Master sau preview (phòng thủ — Product Master không xoá dòng) ⇒ xem preview mới.
  CMS_IMPORT_PRODUCT_UNKNOWN: [409, 'PREVIEW_STALE'],
  // CMS-Q-220 (migration 125): DB từ chối payload có bậc cuối hữu hạn — chỉ xảy ra với preview / bản app trước chính sách (app luôn
  // chuẩn hoá cuối = null) ⇒ kiểm lại file.
  CMS_IMPORT_TIER_LAST_FINITE: [409, 'PREVIEW_STALE'],
  // Guard deferred 125 lúc COMMIT (RPC bản cũ đang chạy dở khi áp 125 — db-reviewer 125 P2-9) ⇒ kiểm lại file.
  CMS_TIER_LAST_FINITE: [409, 'PREVIEW_STALE'],
  // r1 (PM 10/11 UNIT-P2-3, 128): chương trình cms_unit — payload có ĐV tính CMS không hợp lệ (preview bản cũ / gọi RPC trực tiếp).
  CMS_IMPORT_UNIT_INVALID: [409, 'UNIT_INVALID'],
  BUSY: [503, 'BUSY'],
}

export async function handleCmsImportCommit(req: Request, deps: CmsImportDeps): Promise<Response> {
  const g = await guard(deps)
  if (!g.ok) return g.res
  const f = await readForm(req)
  if (!f.ok) return f.res
  const runId = String(f.form.get('run_id') ?? '')
  const clientSha = String(f.form.get('sha256') ?? '')
  if (!UUID_RE.test(runId)) return fail(400, 'BAD_REQUEST')
  const sha = await sha256Hex(f.bytes)
  if (!/^[0-9a-f]{64}$/.test(clientSha) || clientSha !== sha) return fail(409, 'SHA_MISMATCH')
  const run = await deps.repo.getRun(runId)
  const program = run ? await programFor(deps, run.programId, g.qa) : null
  if (!run || !program) return fail(404, 'RUN_NOT_FOUND')
  if (run.fileSha256 !== sha) return fail(409, 'SHA_MISMATCH')
  if (run.status === 'committed') return json(200, { ok: true, result: { already: true } })
  const mode = cmsImportModeFor(program, cmsVnToday(deps.now()))
  if (!mode) return fail(409, 'NOT_EDITABLE')
  if (mode !== run.mode || program.configVersion !== run.configVersionAtPreview) return fail(409, 'PREVIEW_STALE')
  // Loại file + kiểm K theo CHÍNH run đã lưu ở server. Client gửi format khác / cờ v2 đổi giữa preview và commit ⇒ xem preview mới.
  const format: CmsImportFormat = run.result?.format === 'simple' ? 'simple' : 'tiers'
  const clientFormat = f.form.get('format')
  if (clientFormat !== null && clientFormat !== format) return fail(409, 'PREVIEW_STALE')
  const kStored = run.result?.kCheck !== undefined
  if (kStored !== cmsImportKRequired(deps, program) || (format === 'simple' && !deps.v2)) return fail(409, 'PREVIEW_STALE')
  const a = await analyze(f.bytes, program, mode, deps, { format, kCheck: kStored, acks: { kind: 'stored', acks: cmsStoredKAcks(run.result?.kAcks) } })
  if (!a.ok) return a.res
  // Nguồn / trùng / cấu hình đổi sau preview ⇒ kết quả khác ⇒ yêu cầu xem preview mới (SPEC §4.5).
  if (a.digest !== run.result.digest) return fail(409, 'PREVIEW_STALE')
  if (a.v.groupsOk.length === 0) return fail(422, 'NOTHING_TO_COMMIT')
  try {
    const result = await deps.repo.commit({ runId, sha256: sha, digest: a.digest, payload: cmsImportPayload(a.v), actorId: g.actorId })
    return json(200, { ok: true, result })
  } catch (e) {
    const m = e instanceof CmsRepoError ? COMMIT_ERRORS[e.code] : undefined
    return m ? fail(m[0], m[1]) : fail(500, 'COMMIT_FAILED')
  }
}

/** GET file lỗi: toàn bộ dòng của các nhóm bị loại + cột Loi, sinh từ raw cells lưu trong run (SPEC §4.6). */
export async function handleCmsImportErrors(req: Request, deps: CmsImportDeps): Promise<Response> {
  const g = await guard(deps)
  if (!g.ok) return g.res
  const runId = new URL(req.url).searchParams.get('run_id') ?? ''
  if (!UUID_RE.test(runId)) return fail(400, 'BAD_REQUEST')
  const run = await deps.repo.getRun(runId)
  const program = run ? await programFor(deps, run.programId, g.qa) : null
  if (!run || !program) return fail(404, 'RUN_NOT_FOUND')
  const rejected = Array.isArray(run.result?.rejected) ? run.result.rejected : []
  if (rejected.length === 0) return fail(404, 'NO_ERRORS')
  const bytes = run.result?.format === 'simple' ? buildCmsSimpleErrorXlsx(rejected) : buildCmsImportErrorXlsx(rejected)
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cms-import-loi-${runId.slice(0, 8)}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
