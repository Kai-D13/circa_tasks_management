// CMS đơn giản S2 (PM spec r1 08/11 §5.2) — chẩn đoán dòng nguồn bị loại khi lượt bán HELD (UNCONVERTED_UNITS / ROW_ISSUES), để
// super biết ProductID × đơn vị × trường lỗi mà làm việc với BI. CHỈ bổ sung: không đổi quality / engine / guard held toàn run.
//
// Nguyên tắc:
//  · Ngữ cảnh lấy TRƯỚC khi bỏ dòng lỗi, chỉ 2 thứ: ProductID canonical (hỏng ⇒ null = nhãn cố định, không in giá trị thô) và đơn vị
//    đã chuẩn hoá (NFC + bỏ ký tự điều khiển + trim + lower, cắt 30 ký tự). Không email / mã đơn / người bán / token / message BQ.
//  · `UNCONVERTED_UNITS` = base_quantity thiếu / sai ⇒ KHÔNG tự kết luận "BI thiếu bảng đơn vị"; `ROW_ISSUES` gồm cả timestamp / GMV /
//    ID — mã lỗi giữ đúng trường, UI không gọi tất cả là quy đổi.
//  · Gộp tối đa 20 nhóm ProductID × đơn vị × mã (trường:loại), kèm tổng dòng lỗi + số nhóm bị rút gọn. Mã hoá JSON có version, ≤ 8 KiB
//    (RPC finish giới hạn detail 16 KiB) — vượt thì bỏ nhóm cuối và tăng `truncated`. Đọc lại hỏng ⇒ null (UI bỏ chẩn đoán, hiện mã chuẩn).
import { canonicalProductId } from './productId'
import type { CmsRawRow, CmsRowIssue } from './source/contract'

export const CMS_UNIT_ISSUE_VERSION = 1
export const CMS_UNIT_ISSUE_MAX_GROUPS = 20
export const CMS_UNIT_ISSUE_MAX_BYTES = 8192
const UOM_MAX = 30

/** Trường nguồn được phép xuất hiện trong mã (khác ⇒ OTHER) — cùng tập cột chuẩn dòng đơn. */
const FIELDS = new Set(['order_line_id', 'order_id', 'order_code', 'product_id', 'seller_email', 'pos_code', 'order_type', 'order_status',
  'completed_at', 'quantity_raw', 'uom_raw', 'base_quantity', 'gmv_amount', 'source_updated_at'])
const KINDS = new Set(['MISSING_FIELD', 'BAD_PRODUCT_ID', 'BAD_NUMBER', 'BAD_TIMESTAMP', 'BAD_BOOLEAN', 'BAD_TEXT'])

export interface CmsRowIssueContext {
  /** ProductID canonical; null = thiếu / hỏng (UI hiện nhãn cố định). */
  productId: string | null
  /** Đơn vị nguồn đã chuẩn hoá; null = trống. */
  uom: string | null
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g

/** Chuẩn hoá đơn vị ĐẦY ĐỦ (NFC + bỏ ký tự điều khiển + trim + lower) — dùng để SO KHỚP (kiểm K); không cắt. */
export function cmsNormUnitFull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const t = v.normalize('NFC').replace(CONTROL_RE, ' ').trim().toLowerCase()
  return t === '' ? null : t
}

/** Đơn vị để gộp / HIỂN THỊ trong chẩn đoán: như cmsNormUnitFull, cắt 30 ký tự (không dùng để so khớp K). */
export function cmsNormUnit(v: string | null | undefined): string | null {
  const t = cmsNormUnitFull(v)
  if (t === null) return null
  return t.length > UOM_MAX ? `${t.slice(0, UOM_MAX)}…` : t
}

/** Ngữ cảnh tối thiểu của một dòng nguồn lỗi — gọi TRƯỚC khi bỏ dòng; không giữ dòng thô. */
export function cmsRowIssueContext(raw: CmsRawRow): CmsRowIssueContext {
  const pid = canonicalProductId(typeof raw.product_id === 'string' ? raw.product_id : null)
  return { productId: pid.ok ? pid.id : null, uom: cmsNormUnit(typeof raw.uom_raw === 'string' ? raw.uom_raw : null) }
}

/** Mã lỗi "trường:loại" từ tập cố định (không mang giá trị dòng). */
export function cmsIssueCode(i: CmsRowIssue): string {
  const field = FIELDS.has(i.field) ? i.field : 'OTHER'
  const kind = KINDS.has(i.kind) ? i.kind : 'OTHER'
  return `${field}:${kind}`
}

export interface CmsUnitIssueGroup { productId: string | null; uom: string | null; code: string; rows: number }
export interface CmsUnitIssueSummary {
  v: typeof CMS_UNIT_ISSUE_VERSION
  /** Tổng dòng nguồn bị loại (đếm dòng, không đếm lỗi). */
  rows: number
  groups: CmsUnitIssueGroup[]
  /** Số nhóm không đưa vào (vượt 20 nhóm hoặc vượt 8 KiB). */
  truncated: number
}

/** Gộp theo ProductID × đơn vị × mã. Một dòng nhiều lỗi ⇒ góp vào mỗi nhóm mã của nó một lần; `rows` đếm dòng. */
export function cmsSummarizeRowIssues(items: readonly { ctx: CmsRowIssueContext | null | undefined; issues: readonly CmsRowIssue[] }[]): CmsUnitIssueSummary {
  const m = new Map<string, CmsUnitIssueGroup>()
  for (const it of items) {
    const ctx = it.ctx ?? { productId: null, uom: null }
    for (const code of new Set(it.issues.map(cmsIssueCode))) {
      const k = `${ctx.productId ?? ''}\u0000${ctx.uom ?? ''}\u0000${code}`
      const g = m.get(k)
      if (g) g.rows += 1
      else m.set(k, { productId: ctx.productId, uom: ctx.uom, code, rows: 1 })
    }
  }
  // Thứ tự tất định, không phụ thuộc locale: nhiều dòng trước; ProductID theo số (null cuối); đơn vị / mã theo mã ký tự (null cuối).
  const cmp = (x: string | null, y: string | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1)
  const pid = (x: string | null, y: string | null) => (x !== null && y !== null && x.length !== y.length ? x.length - y.length : cmp(x, y))
  const all = [...m.values()].sort((a, b) => b.rows - a.rows || pid(a.productId, b.productId) || cmp(a.uom, b.uom) || cmp(a.code, b.code))
  const groups = all.slice(0, CMS_UNIT_ISSUE_MAX_GROUPS)
  return { v: CMS_UNIT_ISSUE_VERSION, rows: items.length, groups, truncated: all.length - groups.length }
}

const byteLen = (s: string) => new TextEncoder().encode(s).byteLength

/** JSON ≤ 8 KiB: vượt ⇒ bỏ nhóm cuối (ít dòng nhất) tới khi vừa, cộng vào `truncated`. */
export function cmsEncodeUnitIssueSummary(s: CmsUnitIssueSummary): string {
  const groups = [...s.groups]
  let truncated = s.truncated
  for (;;) {
    const out = JSON.stringify({ v: s.v, rows: s.rows, groups, truncated })
    if (byteLen(out) <= CMS_UNIT_ISSUE_MAX_BYTES || groups.length === 0) return out
    groups.pop()
    truncated += 1
  }
}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const CODE_RE = /^[a-z_]+:[A-Z_]+$|^OTHER:[A-Z_]+$|^[a-z_]+:OTHER$|^OTHER:OTHER$/

/** Đọc lại chẩn đoán đã lưu; sai dạng / sai version / vượt trần ⇒ null (không ném, không làm hỏng trang). */
export function cmsDecodeUnitIssueSummary(v: unknown): CmsUnitIssueSummary | null {
  if (typeof v !== 'string' || v.length === 0 || byteLen(v) > CMS_UNIT_ISSUE_MAX_BYTES) return null
  let x: unknown
  try { x = JSON.parse(v) } catch { return null }
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null
  const o = x as Record<string, unknown>
  if (o.v !== CMS_UNIT_ISSUE_VERSION || !isInt(o.rows) || !isInt(o.truncated) || !Array.isArray(o.groups) || o.groups.length > CMS_UNIT_ISSUE_MAX_GROUPS) return null
  const groups: CmsUnitIssueGroup[] = []
  for (const g of o.groups as unknown[]) {
    if (typeof g !== 'object' || g === null) return null
    const r = g as Record<string, unknown>
    const pidOk = r.productId === null || (typeof r.productId === 'string' && /^[1-9][0-9]{0,18}$/.test(r.productId))
    const uomOk = r.uom === null || (typeof r.uom === 'string' && r.uom.length > 0 && r.uom.length <= UOM_MAX + 1 && r.uom.replace(CONTROL_RE, '') === r.uom)
    if (!pidOk || !uomOk || typeof r.code !== 'string' || !CODE_RE.test(r.code) || !isInt(r.rows) || r.rows === 0) return null
    groups.push({ productId: r.productId as string | null, uom: r.uom as string | null, code: r.code, rows: r.rows })
  }
  return { v: CMS_UNIT_ISSUE_VERSION, rows: o.rows, groups, truncated: o.truncated }
}

/** Nhãn tiếng Việt cho mã (UI super). Base_quantity ⇒ "chưa quy đổi đơn vị", không suy "BI thiếu bảng". */
export function cmsIssueCodeLabel(code: string): string {
  const [field, kind] = code.split(':')
  if (field === 'base_quantity') return kind === 'MISSING_FIELD' ? 'Thiếu lượng quy đổi (base_quantity)' : 'Lượng quy đổi không hợp lệ (base_quantity)'
  if (field === 'product_id') return 'ProductID không hợp lệ'
  if (field === 'completed_at' || field === 'source_updated_at') return `Thời điểm không hợp lệ (${field})`
  if (field === 'gmv_amount') return 'GMV không hợp lệ'
  if (kind === 'MISSING_FIELD') return `Thiếu trường ${field}`
  if (kind === 'BAD_TEXT') return `Trường ${field} quá dài`
  return `Lỗi trường ${field}`
}
