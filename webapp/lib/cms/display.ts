// CMS — định dạng hiển thị (thuần). Tiền là CHUỖI bigint (đọc `::text` từ DB) ⇒ định dạng bằng Intl trên BigInt, không
// qua number (không mất chữ số). Thiếu dữ liệu ⇒ '—', không bao giờ '0₫' giả (UI §5).
import type { TagHue } from '@/components/ds/TagBadge'

const NF = new Intl.NumberFormat('vi-VN')
const INT_RE = /^-?[0-9]+$/

/** "15.000₫" từ chuỗi / bigint số nguyên; null / sai dạng ⇒ "—". */
export function cmsVnd(v: string | bigint | null | undefined): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'bigint') return `${NF.format(v)}₫`
  return INT_RE.test(v) ? `${NF.format(BigInt(v))}₫` : '—'
}

/** Số thập phân dạng chuỗi chuẩn ("24", "0.5", "1000.25") ⇒ "24", "0,5", "1.000,25" (không qua float). */
export function cmsDecimal(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(v)
  if (!m) return '—'
  const int = NF.format(BigInt(m[1]))
  const frac = (m[2] ?? '').replace(/0+$/, '')
  return frac ? `${int},${frac}` : int
}

/** Giá tham khảo (numeric có thể có phần lẻ): "120.000₫", "9,5₫"; thiếu ⇒ "—". */
export function cmsPrice(v: string | null | undefined): string {
  const d = cmsDecimal(v)
  return d === '—' ? d : `${d}₫`
}

/** Khoảng bậc: "1–9", "20+", "5" (một số). */
export function cmsTierRange(from: number, to: number | null): string {
  if (to === null) return `${from}+`
  return from === to ? `${from}` : `${from}–${to}`
}

/** Mức thưởng mỗi đơn vị CMS: "15.000₫/hộp". */
export function cmsAmountPerUnit(amount: string, unit: string): string {
  return `${cmsVnd(amount)}/${unit}`
}

export type CmsGmvBasis = 'product' | 'catalog' | 'none'
export const CMS_GATE_LABEL: Record<CmsGmvBasis, string> = { product: 'Target SP', catalog: 'Theo danh mục', none: 'Theo số lượng' }
/** UI §2: Target SP = blue · Theo danh mục = cam (amber) · Theo số lượng = trung tính. */
export const CMS_GATE_HUE: Record<CmsGmvBasis, TagHue> = { product: 'blue', catalog: 'amber', none: 'gray' }

/** "1 hộp = 24 đơn vị cơ sở" (U5). */
export function cmsBaseQtyLine(unit: string, baseQty: string): string {
  return `1 ${unit} = ${cmsDecimal(baseQty)} đơn vị cơ sở`
}

/** "dd/mm/yyyy" từ "YYYY-MM-DD" (chuỗi ngày thuần — không đổi múi giờ). */
export function cmsDate(iso: string): string {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(iso)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso
}

/** "01/11 – 30/11/2026"; khác năm ⇒ ghi đủ năm hai đầu. */
export function cmsDateRange(start: string, end: string): string {
  if (start.slice(0, 4) !== end.slice(0, 4)) return `${cmsDate(start)} – ${cmsDate(end)}`
  return `${cmsDate(start).slice(0, 5)} – ${cmsDate(end)}`
}

/** "01/11/2026 14:05" theo giờ VN từ timestamptz ISO. */
export function cmsDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const v = new Date(d.getTime() + 7 * 3600_000).toISOString()
  return `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)} ${v.slice(11, 16)}`
}

export function cmsFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}
