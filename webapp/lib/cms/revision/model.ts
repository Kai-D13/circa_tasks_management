// F-A — kiểu + parser phản hồi RPC revision (migration 131) + mã lỗi route / nhãn tiếng Việt. Thuần (dùng cả server và client).
// Parser fail-closed: shape lạ ⇒ null (caller báo lỗi cố định, không hiển thị số đoán).

export const CMS_REVISION_CAPS_VERSION = 'cms-revision-v1'
export const CMS_REVISION_RPCS = [
  'rpc_cms_program_revision', 'rpc_cms_program_revision_archive', 'rpc_cms_program_revision_commit', 'rpc_cms_program_revision_preview',
  'rpc_cms_program_revision_state', 'rpc_cms_program_revisions',
] as const

/** Năng lực DB 131: đúng version + đủ 6 RPC + ok (ACL authenticated / không anon + cột retired_at). Lệch ⇒ false (ẩn tính năng). */
export function parseCmsRevisionCapabilities(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const o = raw as Record<string, unknown>
  if (o.version !== CMS_REVISION_CAPS_VERSION || o.ok !== true || !Array.isArray(o.rpcs)) return false
  const got = new Set(o.rpcs.filter((x): x is string => typeof x === 'string'))
  return CMS_REVISION_RPCS.every((r) => got.has(r))
}

/** Trạng thái năng lực DB 131 (revisionCaps.ts probe). */
export type CmsRevisionCapState = 'absent' | 'ok' | 'mismatch' | 'unavailable'

/** r3 (PM P1-02) — hai cổng tách rời, thuần (test được ma trận):
 *   'write' (preview / commit / trang + nút Sửa): CMS_PROGRAM_ENABLED + CMS_PROGRAM_REVISION_ENABLED + năng lực 131 'ok';
 *   'read'  (lịch sử / lưu trữ / trạng thái che số đã có): CMS_PROGRAM_ENABLED + năng lực 131 'ok' — KHÔNG phụ thuộc cờ ghi.
 *  Năng lực chỉ hỏi (probe) khi cờ cho phép tới bước đó; DB 130 ⇒ 'absent' ⇒ false (caller không gọi RPC / cột 131 nào). */
export async function cmsRevisionGate(kind: 'read' | 'write', env: { program: boolean; revision: boolean }, caps: () => Promise<CmsRevisionCapState>): Promise<boolean> {
  if (!env.program) return false
  if (kind === 'write' && !env.revision) return false
  return (await caps()) === 'ok'
}

export type CmsRevisionAction = 'add' | 'readd' | 'change' | 'keep' | 'remove'
export interface CmsRevisionTier { order: number; from: number; to: number | null; amount: string }
export interface CmsRevisionDiffItem {
  productId: string
  action: CmsRevisionAction
  kBefore: string | null
  kAfter: string | null
  tiersBefore: CmsRevisionTier[] | null
  tiersAfter: CmsRevisionTier[] | null
  adviceChanged: boolean
  unitCms: string | null
  name: string | null
  /** Chỉ SP bỏ: đã có dữ liệu run ⇒ retire logic (giữ identity), không xoá. */
  referenced: boolean | null
}
export interface CmsRevisionDiff {
  add: number
  readd: number
  change: number
  keep: number
  remove: number
  removed: string[]
  productsAfter: number
  items: CmsRevisionDiffItem[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const nn = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ACTIONS: ReadonlySet<string> = new Set(['add', 'readd', 'change', 'keep', 'remove'])

function parseTiers(v: unknown): CmsRevisionTier[] | null | undefined {
  if (v === null || v === undefined) return null
  if (!Array.isArray(v)) return undefined
  const out: CmsRevisionTier[] = []
  for (const t of v) {
    if (!isObj(t) || !nn(t.order) || !nn(t.from) || !(t.to === null || nn(t.to)) || typeof t.amount !== 'string' || !/^[0-9]{1,19}$/.test(t.amount)) return undefined
    out.push({ order: t.order as number, from: t.from as number, to: t.to as number | null, amount: t.amount })
  }
  return out
}

export function parseCmsRevisionDiff(raw: unknown): CmsRevisionDiff | null {
  if (!isObj(raw)) return null
  for (const k of ['add', 'readd', 'change', 'keep', 'remove', 'products_after']) if (!nn(raw[k])) return null
  if (!Array.isArray(raw.removed) || !raw.removed.every((x) => typeof x === 'string')) return null
  const itemsRaw = raw.items === null || raw.items === undefined ? [] : raw.items
  if (!Array.isArray(itemsRaw)) return null
  const items: CmsRevisionDiffItem[] = []
  for (const it of itemsRaw) {
    if (!isObj(it) || typeof it.product_id !== 'string' || typeof it.action !== 'string' || !ACTIONS.has(it.action)) return null
    const tb = parseTiers(it.tiers_before), ta = parseTiers(it.tiers_after)
    if (tb === undefined || ta === undefined) return null
    const s = (v: unknown) => (typeof v === 'string' ? v : null)
    items.push({
      productId: it.product_id, action: it.action as CmsRevisionAction, kBefore: s(it.k_before), kAfter: s(it.k_after),
      tiersBefore: tb, tiersAfter: ta, adviceChanged: it.advice_changed === true, unitCms: s(it.unit_cms), name: s(it.name),
      referenced: typeof it.referenced === 'boolean' ? it.referenced : null,
    })
  }
  return {
    add: raw.add as number, readd: raw.readd as number, change: raw.change as number, keep: raw.keep as number, remove: raw.remove as number,
    removed: raw.removed as string[], productsAfter: raw.products_after as number, items,
  }
}

export interface CmsRevisionPreviewReply {
  revisionId: string
  programId: string
  fromConfigVersion: number
  expectedRunId: string | null
  payloadDigest: string
  expiresAt: string
  impactOk: boolean
  diff: CmsRevisionDiff
}

export function parseCmsRevisionPreviewReply(raw: unknown): CmsRevisionPreviewReply | null {
  if (!isObj(raw)) return null
  if (typeof raw.revision_id !== 'string' || !UUID_RE.test(raw.revision_id) || typeof raw.program_id !== 'string' || !nn(raw.from_config_version)) return null
  if (!(raw.expected_run_id === null || (typeof raw.expected_run_id === 'string' && UUID_RE.test(raw.expected_run_id)))) return null
  if (typeof raw.payload_digest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.payload_digest) || typeof raw.expires_at !== 'string') return null
  const diff = parseCmsRevisionDiff(raw.diff)
  if (!diff) return null
  return {
    revisionId: raw.revision_id, programId: raw.program_id, fromConfigVersion: raw.from_config_version as number,
    expectedRunId: raw.expected_run_id as string | null, payloadDigest: raw.payload_digest, expiresAt: raw.expires_at,
    impactOk: raw.impact_ok === true, diff,
  }
}

export interface CmsRevisionCommitReply {
  already: boolean
  revisionId: string
  fromConfigVersion: number
  toConfigVersion: number
  archiveMode: 'none' | 'copied' | 'reused'
  archiveRows: number
  retired: number
  deleted: number
}

export function parseCmsRevisionCommitReply(raw: unknown): CmsRevisionCommitReply | null {
  if (!isObj(raw)) return null
  if (typeof raw.revision_id !== 'string' || !UUID_RE.test(raw.revision_id) || !nn(raw.from_config_version) || !nn(raw.to_config_version)) return null
  const mode = raw.archive_mode
  if (mode !== 'none' && mode !== 'copied' && mode !== 'reused') return null
  return {
    already: raw.already === true, revisionId: raw.revision_id, fromConfigVersion: raw.from_config_version as number,
    toConfigVersion: raw.to_config_version as number, archiveMode: mode, archiveRows: nn(raw.archive_rows) ? raw.archive_rows as number : 0,
    retired: nn(raw.retired) ? raw.retired as number : 0, deleted: nn(raw.deleted) ? raw.deleted as number : 0,
  }
}

export interface CmsRevisionState { revised: boolean; lastRevisedAt: string | null; masked: boolean }

/** r3 (PM P1-02) — prop link của trang chi tiết (chỉ gọi khi cổng ĐỌC đã mở): nút Sửa CHỈ khi cổng GHI mở + chương trình nháp / đang
 *  chạy; link Lịch sử theo trạng thái (đã có revision) hoặc khi không đọc được trạng thái (trang lịch sử tự báo lỗi, không giả "chưa sửa"). */
export interface CmsRevisionDetailLinks { editHref: string | null; historyHref: string; state: CmsRevisionState | null; stateError: boolean }
export function cmsRevisionDetailLinks(o: { programId: string; status: string; writable: boolean; state: { ok: true; data: CmsRevisionState } | { ok: false } }): CmsRevisionDetailLinks {
  const base = `/targets/campaigns/cms/${o.programId}`
  return {
    editHref: o.writable && (o.status === 'draft' || o.status === 'active') ? `${base}/revision` : null,
    historyHref: `${base}/revisions`,
    state: o.state.ok ? o.state.data : null,
    stateError: !o.state.ok,
  }
}

export function parseCmsRevisionState(raw: unknown): CmsRevisionState | null {
  if (!isObj(raw) || typeof raw.revised !== 'boolean' || typeof raw.masked !== 'boolean') return null
  return { revised: raw.revised, lastRevisedAt: typeof raw.last_revised_at === 'string' ? raw.last_revised_at : null, masked: raw.masked }
}

// ── Mã lỗi route ─────────────────────────────────────────────────────────────

export type CmsRevisionErrorCode =
  | 'NOT_FOUND' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'UNAVAILABLE' | 'CROSS_SITE' | 'BAD_REQUEST' | 'PAYLOAD_TOO_LARGE'
  | 'PROGRAM_NOT_FOUND' | 'NOT_EDITABLE' | 'LOCKED' | 'NET_UNSUPPORTED' | 'BASIS_PENDING' | 'PAYOUT_EXISTS' | 'ATTESTED' | 'LEDGER_EXISTS'
  | 'FILE_HAS_ERRORS' | 'SNAPSHOT_FAILED' | 'PREVIEW_STALE' | 'MAPPING_CHANGED' | 'BAD_PAYLOAD' | 'CATALOG_UNSUPPORTED'
  | 'FIELD_LOCKED' | 'REMOVE_UNSUPPORTED' | 'NO_CHANGE' | 'PRODUCT_UNKNOWN' | 'PRODUCT_CONFLICT' | 'PREVIEW_FAILED'
  | 'REVISION_NOT_FOUND' | 'NOT_OWNER' | 'EXPIRED' | 'IDEMPOTENCY_CONFLICT' | 'IMPACT_INVALID' | 'ACK_REQUIRED' | 'REASON_REQUIRED'
  | 'BUSY' | 'ARCHIVE_FAILED' | 'COMMIT_FAILED'

export const CMS_REVISION_ERROR_LABELS: Record<CmsRevisionErrorCode, string> = {
  NOT_FOUND: 'Không tìm thấy',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết — đăng nhập lại',
  FORBIDDEN: 'Chỉ super admin được sửa chương trình CMS',
  UNAVAILABLE: 'Không kiểm tra được quyền — thử lại',
  CROSS_SITE: 'Yêu cầu không hợp lệ',
  BAD_REQUEST: 'Yêu cầu không hợp lệ',
  PAYLOAD_TOO_LARGE: 'Yêu cầu quá lớn',
  PROGRAM_NOT_FOUND: 'Không tìm thấy chương trình',
  NOT_EDITABLE: 'Chương trình không ở trạng thái sửa được (chỉ nháp / đang chạy chưa chốt)',
  LOCKED: 'Chương trình đã chốt — không sửa được',
  NET_UNSUPPORTED: 'Chương trình tính trả hàng (net) chưa hỗ trợ sửa trong đợt này',
  BASIS_PENDING: 'Chương trình chưa chọn cách tính lượng',
  PAYOUT_EXISTS: 'Đã có dữ liệu chi trả — không sửa được',
  ATTESTED: 'Đã có xác nhận hoàn tất — không sửa được',
  LEDGER_EXISTS: 'Đã có sổ trả hàng / báo cáo sau chốt — không sửa được',
  FILE_HAS_ERRORS: 'File còn lỗi — sửa đủ để danh mục trong file là toàn bộ danh mục mong muốn',
  SNAPSHOT_FAILED: 'Không đọc được cấu hình hiện hành — thử lại',
  PREVIEW_STALE: 'Cấu hình / dữ liệu đã thay đổi — kiểm tra lại file',
  MAPPING_CHANGED: 'Danh sách người bán / cửa hàng vừa thay đổi — kiểm tra lại file',
  BAD_PAYLOAD: 'Danh mục trong file không hợp lệ',
  CATALOG_UNSUPPORTED: 'Không đổi target danh mục / sản phẩm GMV toàn danh mục trong đợt này',
  FIELD_LOCKED: 'File đổi loại GMV / target / đơn vị CMS của sản phẩm đang có — không cho phép',
  REMOVE_UNSUPPORTED: 'Không bỏ được sản phẩm đã có dữ liệu ở chương trình tính theo đơn vị CMS',
  NO_CHANGE: 'File không thay đổi gì so với cấu hình hiện hành',
  PRODUCT_UNKNOWN: 'Có sản phẩm chưa có trong Product Master',
  PRODUCT_CONFLICT: 'Có sản phẩm đang thuộc chương trình khác cùng thời gian',
  PREVIEW_FAILED: 'Không lập được bản xem trước — thử lại',
  REVISION_NOT_FOUND: 'Không tìm thấy bản xem trước',
  NOT_OWNER: 'Bản xem trước do người khác lập — tự kiểm tra lại file',
  EXPIRED: 'Bản xem trước đã hết hạn (15 phút) — kiểm tra lại file',
  IDEMPOTENCY_CONFLICT: 'Yêu cầu ghi trùng không khớp — tải lại trang',
  IMPACT_INVALID: 'Chưa có dự toán tác động hợp lệ — không ghi được',
  ACK_REQUIRED: 'Cần tick đủ xác nhận cho đúng danh sách thay đổi',
  REASON_REQUIRED: 'Cần nhập lý do (10–1.000 ký tự)',
  BUSY: 'Đang có lượt đồng bộ chạy — thử lại sau ít phút',
  ARCHIVE_FAILED: 'Không lưu được bản số trước sửa — không ghi gì; báo Dev',
  COMMIT_FAILED: 'Không ghi được — thử lại',
}

/** Mã RAISE của DB ⇒ [HTTP, mã route]. Không có ⇒ fallback của caller. */
export const CMS_REVISION_DB_ERRORS: Record<string, [number, CmsRevisionErrorCode]> = {
  CMS_REVISION_FORBIDDEN: [403, 'FORBIDDEN'],
  CMS_PROGRAM_NOT_FOUND: [404, 'PROGRAM_NOT_FOUND'],
  CMS_PROGRAM_LOCKED: [409, 'LOCKED'],
  CMS_REVISION_STATUS: [409, 'NOT_EDITABLE'],
  CMS_REVISION_NET_UNSUPPORTED: [409, 'NET_UNSUPPORTED'],
  CMS_REVISION_BASIS_PENDING: [409, 'BASIS_PENDING'],
  CMS_REVISION_PAYOUT_EXISTS: [409, 'PAYOUT_EXISTS'],
  CMS_REVISION_ATTESTED: [409, 'ATTESTED'],
  CMS_REVISION_LEDGER_EXISTS: [409, 'LEDGER_EXISTS'],
  CMS_REVISION_PREVIEW_STALE: [409, 'PREVIEW_STALE'],
  CMS_REVISION_MAPPING_CHANGED: [409, 'MAPPING_CHANGED'],
  CMS_REVISION_BAD_INPUT: [400, 'BAD_REQUEST'],
  CMS_REVISION_BAD_PAYLOAD: [422, 'BAD_PAYLOAD'],
  CMS_REVISION_BAD_TIERS: [422, 'BAD_PAYLOAD'],
  CMS_REVISION_TIER_LAST_FINITE: [422, 'BAD_PAYLOAD'],
  CMS_REVISION_CATALOG_UNSUPPORTED: [422, 'CATALOG_UNSUPPORTED'],
  CMS_REVISION_FIELD_LOCKED: [422, 'FIELD_LOCKED'],
  CMS_REVISION_REMOVE_UNSUPPORTED: [422, 'REMOVE_UNSUPPORTED'],
  CMS_REVISION_NO_CHANGE: [422, 'NO_CHANGE'],
  CMS_REVISION_PRODUCT_UNKNOWN: [409, 'PRODUCT_UNKNOWN'],
  CMS_REVISION_PRODUCT_CONFLICT: [409, 'PRODUCT_CONFLICT'],
  CMS_REVISION_NOT_FOUND: [404, 'REVISION_NOT_FOUND'],
  CMS_REVISION_NOT_OWNER: [403, 'NOT_OWNER'],
  CMS_REVISION_PREVIEW_EXPIRED: [409, 'EXPIRED'],
  CMS_REVISION_IDEMPOTENCY_CONFLICT: [409, 'IDEMPOTENCY_CONFLICT'],
  CMS_REVISION_IMPACT_INVALID: [409, 'IMPACT_INVALID'],
  CMS_REVISION_ACK_REQUIRED: [422, 'ACK_REQUIRED'],
  CMS_REVISION_REASON_REQUIRED: [422, 'REASON_REQUIRED'],
  CMS_SYNC_BUSY: [503, 'BUSY'],
  CMS_REVISION_ARCHIVE_GONE: [409, 'PREVIEW_STALE'],
  CMS_REVISION_HISTORY_GAP: [500, 'ARCHIVE_FAILED'],
  CMS_REVISION_ARCHIVE_MISMATCH: [500, 'ARCHIVE_FAILED'],
}

/** Mã impact (status 'error') ⇒ câu cho super. Không có ⇒ hiển thị mã. */
export const CMS_REVISION_IMPACT_LABELS: Record<string, string> = {
  NET_UNSUPPORTED: 'Chương trình trả hàng (net) chưa hỗ trợ',
  CALC_MODES_DISABLED: 'Cờ tính theo đơn vị CMS đang tắt — không tính được dự toán',
  CONTRACT_PROVIDER_MISSING: 'Chưa cấu hình nguồn bán',
  FIXTURE_REAL_PROGRAM: 'Nguồn giả không dùng cho chương trình thật',
  SOURCE_CONFIG_MISSING: 'Chưa cấu hình nguồn bán',
  PUBLISHED_UNAVAILABLE: 'Không đọc được đủ số đã công bố (run bị dọn / thiếu dòng / tổng lệch) — không dùng số 0 thay thế',
  CONFIG_INVALID: 'Cấu hình sau sửa không tính được',
  DUPLICATE_LINE_ID: 'Nguồn bán có mã dòng trùng',
  RETURNS_NOT_SUPPORTED: 'Nguồn có dòng âm (trả hàng) — đợt này chưa hỗ trợ',
  OVERFLOW: 'Số vượt giới hạn tính',
  UNASSIGNED_OVER_THRESHOLD: 'Quá nhiều dòng chưa gán dược sĩ',
  UNCONVERTED_UNITS: 'Nguồn có dòng chưa quy đổi đơn vị',
  ROW_ISSUES: 'Nguồn có dòng lỗi',
  EMPTY_AFTER_DATA: 'Nguồn trả 0 dòng sau khi đã có dữ liệu',
  INCOMPLETE_PAGES: 'Nguồn đọc thiếu trang',
  OVER_CAP: 'Nguồn vượt trần dòng',
}

export function cmsRevisionImpactLabel(code: string | null): string {
  if (!code) return 'Không tính được dự toán'
  if (CMS_REVISION_IMPACT_LABELS[code]) return CMS_REVISION_IMPACT_LABELS[code]
  if (code.startsWith('SOURCE_')) return `Nguồn bán lỗi (${code.slice(7)})`
  if (code.startsWith('CALC_')) return `Engine dừng (${code.slice(5)})`
  return `Không tính được dự toán (${code})`
}

/** r3 (PM P1-03): nhãn số đã công bố trong dự toán theo trạng thái run pointer — chỉ gọi "Đang công bố" khi run cùng version cấu hình
 *  hiện hành; pointer còn trỏ run của version trước (đã sửa, chưa có run mới) ⇒ "bản công bố trước thay đổi cấu hình" có version;
 *  chưa có run ⇒ không có số (không 0). */
export type CmsRevisionPublishedKind = 'none' | 'current' | 'prior'
export function cmsRevisionPublishedView(t: { published_run_id: string | null; published_current?: boolean | null; published_config_version?: number | null }):
  { kind: CmsRevisionPublishedKind; label: string; column: string } {
  if (!t.published_run_id) return { kind: 'none', label: 'Chưa có lượt công bố nào', column: 'Đã công bố' }
  if (t.published_current !== true) {
    const v = t.published_config_version ? ` v${t.published_config_version}` : ''
    return { kind: 'prior', label: `Bản công bố trước thay đổi cấu hình${v}`, column: `Bản công bố trước${v}` }
  }
  return { kind: 'current', label: 'Đang công bố', column: 'Đang công bố' }
}

/** Lý do: 10–1.000 ký tự sau trim, không ký tự điều khiển (trùng CHECK DB). */
export function cmsRevisionReasonOk(s: string): boolean {
  const t = s.trim()
  // eslint-disable-next-line no-control-regex
  return t.length >= 10 && t.length <= 1000 && !/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(t)
}
