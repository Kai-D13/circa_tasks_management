// CMS đơn giản S1 (PM spec r1 08/11 §4) — kiểm file đơn giản = CHÍNH validator 9 cột (validateCmsImport) trên dòng đã ánh xạ, cộng
// hai điểm chỉ có nghĩa với bố cục "một dòng / SP": (1) ProductID lặp ⇒ lỗi DUPLICATE_PRODUCT rõ nghĩa (thay lỗi bậc chồng / nhóm
// không thống nhất do hai dòng cùng "bậc 1 từ 1"); (2) tên trong file khác Product Master ⇒ cảnh báo (vẫn nạp; tên / ảnh / giá hiển
// thị luôn lấy theo Master). Không nới bất kỳ luật nào của validator gốc. Thuần.
import type { CmsImportRawRow } from './parse'
import { validateCmsImport, type CmsImportContext, type CmsImportIssue, type CmsImportValidation } from './validate'

const DUP_REPLACES = new Set(['TIER_OVERLAP', 'TIER_GAP', 'TIER_OPEN_NOT_LAST', 'GROUP_INCONSISTENT'])
const canonName = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

export function validateCmsSimpleImport(rows: readonly CmsImportRawRow[], ctx: CmsImportContext): CmsImportValidation {
  const v = validateCmsImport(rows, ctx)
  const groupsRejected = v.groupsRejected.map((g) => {
    if (g.rows.length < 2) return g
    const first = Math.min(...g.rows.map((r) => r.excelRow))
    const dup: CmsImportIssue = {
      excelRow: first, column: 'ProductID', code: 'DUPLICATE_PRODUCT',
      message: `ProductID xuất hiện ${g.rows.length} dòng trong file mức cố định`, fix: 'Mỗi sản phẩm chỉ một dòng — xoá dòng trùng',
    }
    return { ...g, errors: [dup, ...g.errors.filter((e) => !DUP_REPLACES.has(e.code))] }
  })
  const byRow = new Map(rows.map((r) => [r.excelRow, r]))
  const groupsOk = v.groupsOk.map((g) => {
    const fileName = byRow.get(g.excelRows[0])?.info?.product_name
    if (typeof fileName !== 'string' || fileName.trim() === '' || canonName(fileName) === canonName(g.nameSnapshot)) return g
    const w: CmsImportIssue = {
      excelRow: g.excelRows[0], column: 'ProductID', code: 'NAME_DIFFERS_MASTER',
      message: 'Tên trong file khác tên trên Product Master', fix: 'Vẫn nạp; tên / ảnh / giá hiển thị theo Product Master — kiểm lại ProductID',
    }
    return { ...g, warnings: [...g.warnings, w] }
  })
  return { ...v, groupsOk, groupsRejected, stats: { ...v.stats, warnings: groupsOk.reduce((s, g) => s + g.warnings.length, 0) } }
}
