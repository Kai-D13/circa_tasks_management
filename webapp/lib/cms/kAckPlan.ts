// UX-KACK-1 (PM 15/11 review đóng đợt §4) — logic THUẦN phía client cho bước xác nhận K tay khi nạp file CMS. Không import server code,
// không đổi luật server: cmsKAckable / cmsBindKAcks / phân loại nguồn / parser giữ nguyên (AC7). Module này chỉ:
//   · giữ nháp ý định theo khoá ProductID + đơn vị + K CỦA LẦN KIỂM HIỆN TẠI (AC6 — bộ dữ liệu khác ⇒ khoá khác ⇒ không tái dùng);
//   · tính "còn ý định chưa gửi" để khoá nút ghi (AC1) và không gửi im lặng một phần ý định thiếu nguồn;
//   · chọn nhiều dòng / áp nguồn chung CHỈ trên dòng thoả cmsKAckable trong tập đang hiển thị (AC5);
//   · tóm tắt N trong file / M sẽ ghi / U không ghi + lý do (AC2 / AC3) từ chính kết quả preview của server.
import { cmsKAckable, type CmsPreviewKResult, type CmsPreviewResult } from './importView'

export interface CmsKAckDraftEntry { checked: boolean; source: string }
/** Nháp ý định xác nhận tay, khoá = cmsKAckKey (ProductID + đơn vị + K của lần kiểm). */
export type CmsKAckDraft = Record<string, CmsKAckDraftEntry>

/** Trần nguồn căn cứ — cùng CMS_K_ACK_SOURCE_MAX (lib/cms/import/kCheck.ts, server); client chỉ chặn sớm, server vẫn tự kiểm. */
export const CMS_K_ACK_SOURCE_MIN = 3
export const CMS_K_ACK_SOURCE_MAX_CLIENT = 200

type KRow = Pick<CmsPreviewKResult, 'productId' | 'unit' | 'k' | 'status' | 'ack'>

export const cmsKAckKey = (x: Pick<CmsPreviewKResult, 'productId' | 'unit' | 'k'>): string => `${x.productId}\u0001${x.unit}\u0001${x.k ?? ''}`

/** Chuẩn hoá nguồn GIỐNG server (cmsParseKAckInput): ký tự điều khiển ⇒ khoảng trắng, gộp khoảng trắng, trim. */
export function cmsKNormSource(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim()
}
export const cmsKSourceOk = (s: string): boolean => {
  const t = cmsKNormSource(s)
  return t.length >= CMS_K_ACK_SOURCE_MIN && t.length <= CMS_K_ACK_SOURCE_MAX_CLIENT
}

const EMPTY: CmsKAckDraftEntry = { checked: false, source: '' }
export const cmsKDraftOf = (drafts: CmsKAckDraft, x: KRow): CmsKAckDraftEntry => drafts[cmsKAckKey(x)] ?? EMPTY

/** Ý định đang chờ gửi: dòng ĐƯỢC xác nhận (cmsKAckable) đã tick. `ready` có nguồn hợp lệ; `incomplete` chưa có. */
export function cmsKPending<T extends KRow>(rows: readonly T[], drafts: CmsKAckDraft): { ready: T[]; incomplete: T[] } {
  const ready: T[] = [], incomplete: T[] = []
  for (const x of rows) {
    if (!cmsKAckable(x)) continue
    const d = cmsKDraftOf(drafts, x)
    if (!d.checked) continue
    if (cmsKSourceOk(d.source)) ready.push(x); else incomplete.push(x)
  }
  return { ready, incomplete }
}

/** Còn ý định chưa được preview nhận lại (AC1) ⇒ khoá ghi. Tick rồi bỏ tick ⇒ không còn ý định. */
export const cmsKDirty = (rows: readonly KRow[], drafts: CmsKAckDraft): boolean => {
  const p = cmsKPending(rows, drafts)
  return p.ready.length + p.incomplete.length > 0
}

/** Gửi lại: chỉ khi KHÔNG có ý định thiếu nguồn (không gửi im lặng một phần) và có ≥ 1 ý định đủ — hoặc nguồn bán chưa đọc được (thử lại). */
export function cmsKCanRecheck(rows: readonly KRow[], drafts: CmsKAckDraft, available: boolean): boolean {
  const p = cmsKPending(rows, drafts)
  if (p.incomplete.length > 0) return false
  return p.ready.length > 0 || !available
}

export interface CmsKAckPayloadItem { product_id: string; unit: string; k: string; source: string }
/**
 * `k_acks` gửi lại cùng CHÍNH file: xác nhận đã được server gắn trong lần kiểm này (giữ nguyên nguồn) + ý định mới đủ nguồn. Mỗi
 * ProductID / đơn vị / K một mục riêng (AC6); actor / thời điểm do server gắn. Server vẫn tự lọc theo cmsBindKAcks.
 */
export function cmsKAckPayload(rows: readonly CmsPreviewKResult[], drafts: CmsKAckDraft): CmsKAckPayloadItem[] {
  const kept = rows.filter((x) => x.ack !== null && x.k !== null).map((x) => ({ product_id: x.productId, unit: x.unit, k: x.k as string, source: x.ack!.source }))
  const added = cmsKPending(rows, drafts).ready.map((x) => ({ product_id: x.productId, unit: x.unit, k: x.k as string, source: cmsKNormSource(cmsKDraftOf(drafts, x).source) }))
  return [...kept, ...added]
}

/**
 * Chọn / bỏ chọn nhiều dòng (AC5): chỉ dòng có trong `visible` VÀ thoả cmsKAckable. Dòng khác giữ nguyên nháp; không tự điền nguồn.
 */
export function cmsKBulkCheck(visible: readonly KRow[], drafts: CmsKAckDraft, checked: boolean): CmsKAckDraft {
  const next = { ...drafts }
  for (const x of visible) {
    if (!cmsKAckable(x)) continue
    const k = cmsKAckKey(x)
    next[k] = { ...(next[k] ?? EMPTY), checked }
  }
  return next
}

/**
 * Áp một nguồn chung (AC5) cho các dòng ĐÃ CHỌN trong `visible` (đã tick + cmsKAckable), ghi đè nguồn đang nhập của các dòng đó.
 * Nguồn không hợp lệ ⇒ trả nguyên nháp (không áp). Dòng chưa chọn / không xác nhận được không bị đụng.
 */
export function cmsKBulkApplySource(visible: readonly KRow[], drafts: CmsKAckDraft, source: string): CmsKAckDraft {
  if (!cmsKSourceOk(source)) return drafts
  const s = cmsKNormSource(source)
  const next = { ...drafts }
  for (const x of visible) {
    if (!cmsKAckable(x)) continue
    const k = cmsKAckKey(x)
    if (next[k]?.checked) next[k] = { checked: true, source: s }
  }
  return next
}

/**
 * KACK-BULK-01 (PM 16/11 §4): dấu vân tay của một lần "xác nhận nguồn chung" = tập khoá ProductID / đơn vị / K ĐÃ CHỌN (sắp xếp,
 * không chỉ số lượng) + nguồn đã chuẩn hoá. Xác nhận chỉ có hiệu lực cho đúng dấu vân tay lúc người dùng tick.
 */
export function cmsKBulkFingerprint(selected: readonly KRow[], source: string): string {
  return `${selected.map(cmsKAckKey).sort().join('\u0002')}\u0003${cmsKNormSource(source)}`
}

/**
 * Đồng bộ xác nhận nguồn chung MỖI LẦN RENDER với dấu vân tay hiện tại: khác ⇒ huỷ hẳn (null). Vì đã huỷ, quay lại đúng tập / nguồn
 * cũ (bỏ hết rồi chọn lại, đổi B rồi về A) KHÔNG phục hồi xác nhận ngầm — người dùng phải tick lại.
 */
export const cmsKBulkConfirmSync = (confirmedFp: string | null, currentFp: string): string | null =>
  confirmedFp !== null && confirmedFp !== currentFp ? null : confirmedFp

/** Điều kiện cấp quyền "Áp nguồn" — dùng CHUNG cho trạng thái nút và handler (so lại dấu vân tay tại thời điểm bấm). */
export function cmsKBulkApplyAllowed(i: { selected: readonly KRow[]; source: string; confirmedFp: string | null; busy: boolean }): boolean {
  if (i.busy || i.selected.length === 0 || !cmsKSourceOk(i.source) || i.confirmedFp === null) return false
  return i.confirmedFp === cmsKBulkFingerprint(i.selected, i.source)
}

/** Dòng đã chọn (để hiện danh sách / số đếm khi chọn nhiều — AC5). */
export const cmsKSelected = <T extends KRow>(visible: readonly T[], drafts: CmsKAckDraft): T[] =>
  visible.filter((x) => cmsKAckable(x) && cmsKDraftOf(drafts, x).checked)

/** Dòng KHÔNG chọn được theo lý do (để nói rõ dòng bị loại khỏi "chọn tất cả" — AC5). */
export function cmsKExcluded(rows: readonly KRow[]): { status: CmsPreviewKResult['status'] | 'ACKED' | 'NO_K'; n: number }[] {
  const by = new Map<CmsPreviewKResult['status'] | 'ACKED' | 'NO_K', number>()
  for (const x of rows) {
    if (cmsKAckable(x)) continue
    const key = x.ack ? 'ACKED' : (x.status === 'NO_EVIDENCE' || x.status === 'UNAVAILABLE') && x.k === null ? 'NO_K' : x.status
    by.set(key, (by.get(key) ?? 0) + 1)
  }
  return [...by].map(([status, n]) => ({ status, n }))
}

/** Sau khi gửi lại thành công: ý định đã gửi nhưng server KHÔNG gắn được (trạng thái K đổi / không còn được xác nhận). */
export function cmsKNotApplied(sent: readonly CmsKAckPayloadItem[], next: CmsPreviewResult): string[] {
  const rows = next.kCheck?.products ?? []
  return sent.filter((s) => !rows.some((x) => x.productId === s.product_id && x.unit === s.unit && x.k === s.k && x.ack !== null)).map((s) => s.product_id)
}

// ── Tóm tắt trước khi ghi (AC2 / AC3) ────────────────────────────────────────────────────────────────────────────────────────
const K_ACKABLE_CODES = new Set(['K_NO_EVIDENCE', 'K_UNAVAILABLE'])

export interface CmsImportPlan {
  /** Nhóm ProductID đọc được trong file (hợp lệ + bị loại). */
  total: number
  write: number
  skip: number
  /** Bị loại CHỈ vì K chưa có bằng chứng / không kiểm được và SP xác nhận tay được ⇒ không cần sửa file. */
  skipKAck: number
  /** Bị loại chỉ vì K nhưng KHÔNG xác nhận tay được (LỆCH / NGUỒN LỖI / NGUỒN XUNG ĐỘT / ĐỀ XUẤT K / không có trong bảng K). */
  skipKBlocked: number
  /** Có lỗi dữ liệu ngoài K ⇒ phải sửa file. */
  skipFile: number
  /** ProductID xác nhận K được nhưng nhóm còn lỗi khác (xác nhận K chưa đủ để ghi). */
  ackableWithOtherErrors: Set<string>
}

export function cmsImportPlan(result: Pick<CmsPreviewResult, 'groupsOk' | 'groupsRejected' | 'kCheck'>): CmsImportPlan {
  // Gom MỌI dòng K theo ProductID (server hiện chỉ sinh ≤ 1 dòng / SP — cmsKTargets — nhưng không dựa vào đó): nhóm chỉ "xác nhận
  // được" khi mọi dòng K của SP đều thoả cmsKAckable (một đơn vị LỆCH ⇒ không).
  const kRows = new Map<string, CmsPreviewKResult[]>()
  for (const x of result.kCheck?.products ?? []) kRows.set(x.productId, [...(kRows.get(x.productId) ?? []), x])
  let skipKAck = 0, skipKBlocked = 0, skipFile = 0
  const ackableWithOtherErrors = new Set<string>()
  for (const g of result.groupsRejected) {
    const kOnly = g.errors.length > 0 && g.errors.every((e) => e.code.startsWith('K_'))
    const xs = kRows.get(g.key) ?? []
    const ackable = xs.length > 0 && xs.every(cmsKAckable)
    if (!kOnly) {
      skipFile++
      if (ackable) ackableWithOtherErrors.add(g.key)
    } else if (ackable && g.errors.every((e) => K_ACKABLE_CODES.has(e.code))) skipKAck++
    else skipKBlocked++
  }
  const write = result.groupsOk.length, skip = result.groupsRejected.length
  return { total: write + skip, write, skip, skipKAck, skipKBlocked, skipFile, ackableWithOtherErrors }
}

/** Cổng nút ghi (AC1 / AC2): bận ⇒ khoá; còn ý định chưa gửi ⇒ khoá; ghi một phần ⇒ phải xác nhận số dòng bị bỏ trước. */
export type CmsCommitBlock = 'NONE' | 'NOTHING' | 'BUSY' | 'DIRTY' | 'PARTIAL_UNCONFIRMED'
export function cmsCommitGate(i: { write: number; skip: number; dirty: boolean; busy: boolean; partialConfirmed: boolean }): CmsCommitBlock {
  if (i.write <= 0) return 'NOTHING'
  if (i.busy) return 'BUSY'
  if (i.dirty) return 'DIRTY'
  if (i.skip > 0 && !i.partialConfirmed) return 'PARTIAL_UNCONFIRMED'
  return 'NONE'
}
