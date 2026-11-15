// CMS-CALC-RET-2 P5.1 — kiểm danh mục theo cách tính của CHƯƠNG TRÌNH khi nạp file (spec §3.4 / §6.1.3; PM work order P5 §4).
// Thuần. Chương trình "Tính nguyên — đúng đơn vị CMS": mỗi SP phải có unit_CMS có khoá so khớp hợp lệ (cms-unit-key-v2, parity SQL
// cms__unit_key) — DB cũng chặn ở trigger SP (CMS_UNIT_CMS_INVALID), app báo sớm ở preview theo nhóm, không để commit hỏng cả file.
// Cách tính "cộng dồn" không thêm ràng buộc đơn vị (giữ luật hiện hành).

import { cmsUnitKey } from '../unitKey'
import type { CmsQuantityBasis } from '../calc/policy'
import type { CmsImportRawRow } from './parse'
import type { CmsImportGroupRejected, CmsImportIssue, CmsImportValidation } from './validate'

export function cmsApplyBasisUnitCheck(v: CmsImportValidation, rows: readonly CmsImportRawRow[], basis: CmsQuantityBasis | null | undefined): CmsImportValidation {
  if (basis !== 'cms_unit') return v
  const moved: CmsImportGroupRejected[] = []
  const groupsOk = v.groupsOk.filter((g) => {
    if (cmsUnitKey(g.unitCms) !== null) return true
    const issue: CmsImportIssue = {
      excelRow: g.excelRows[0], column: 'unit_CMS', code: 'UNIT_CMS_INVALID_FOR_CMS_UNIT',
      message: 'Đơn vị CMS không dùng được cho cách tính nguyên (trống, ký tự ẩn hoặc ký tự điều khiển)',
      fix: 'Nhập đơn vị CMS đúng như trên đơn bán (ví dụ "Hộp"), không ký tự ẩn',
    }
    moved.push({ key: g.productId, rows: rows.filter((r) => g.excelRows.includes(r.excelRow)), errors: [issue] })
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
