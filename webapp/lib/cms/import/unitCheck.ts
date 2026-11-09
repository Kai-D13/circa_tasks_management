// CMS-UNIT (PM spec 09/11 §2 "Chuẩn hoá tên đơn vị", §4 import) — kiểm unit_CMS của file import cho chương trình cơ sở `cms_unit`.
// Chạy ở MỌI mẫu file (9 cột v1 đang phát hành + mẫu mức cố định v2) — không có đường bypass qua file v1. Hàm thuần.
//  · Ô unit_CMS THÔ có ký tự điều khiển (C0 / DEL / C1, kể cả tab / xuống dòng) ⇒ loại nhóm (UNIT_CMS_CONTROL): không xoá ký tự để
//    tạo ra một đơn vị có vẻ hợp lệ.
//  · Khoá đơn vị (cmsUnitKey — cùng hợp đồng SQL cms__unit_key của 128) rỗng ⇒ loại nhóm (UNIT_CMS_INVALID).
// Bằng chứng "đã bán theo ĐV này" do kiểm K (kCheck.ts) đảm nhiệm với chuẩn hoá cmsUnitKey khi chương trình cms_unit.

import type { CmsImportRawRow } from './parse'
import type { CmsImportGroupRejected, CmsImportIssue, CmsImportValidation } from './validate'
import { cmsUnitKey } from '../unitKey'

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/

const rawUnitText = (r: CmsImportRawRow): string | null => {
  const c = r.cells.unit_CMS
  return c.kind === 'text' ? c.value : c.kind === 'number' ? String(c.value) : null
}

/** Áp kiểm đơn vị cms_unit: nhóm hợp lệ có unit_CMS không dùng làm mẫu so khớp được ⇒ chuyển sang bị loại. Không đổi nhóm hợp lệ còn lại. */
export function cmsApplyUnitBasisCheck(v: CmsImportValidation, rows: readonly CmsImportRawRow[]): CmsImportValidation {
  const moved: CmsImportGroupRejected[] = []
  const groupsOk = v.groupsOk.filter((g) => {
    const gr = rows.filter((r) => g.excelRows.includes(r.excelRow))
    let issue: CmsImportIssue | null = null
    const bad = gr.find((r) => { const t = rawUnitText(r); return t !== null && CONTROL_RE.test(t) })
    if (bad) {
      issue = {
        excelRow: bad.excelRow, column: 'unit_CMS', code: 'UNIT_CMS_CONTROL',
        message: 'unit_CMS có ký tự điều khiển (tab / xuống dòng / ký tự ẩn) — không dùng làm ĐV tính CMS được',
        fix: 'Gõ lại tên đơn vị đúng như trên POS (vd. hộp), không dán kèm ký tự ẩn',
      }
    } else if (cmsUnitKey(g.unitCms) === null) {
      issue = {
        excelRow: g.excelRows[0] ?? null, column: 'unit_CMS', code: 'UNIT_CMS_INVALID',
        message: 'unit_CMS không hợp lệ cho cách tính theo ĐV tính CMS',
        fix: 'Nhập đúng tên đơn vị bán trên POS (vd. hộp, chai)',
      }
    }
    if (!issue) return true
    moved.push({ key: g.productId, rows: gr, errors: [issue] })
    return false
  })
  if (moved.length === 0) return v
  const all = [...v.groupsRejected, ...moved]
  const rowsOk = groupsOk.reduce((s, g) => s + g.excelRows.length, 0)
  return {
    ...v, groupsOk, groupsRejected: all,
    catalogTarget: groupsOk.some((g) => g.gmvBasis === 'catalog') || v.mode === 'append' ? v.catalogTarget : null,
    stats: { ...v.stats, rowsOk, rowsRejected: v.stats.rowsTotal - rowsOk, productsOk: groupsOk.length, productsRejected: all.length, warnings: groupsOk.reduce((s, g) => s + g.warnings.length, 0) },
  }
}
