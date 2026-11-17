// F-C (PM spec 17/11 §5) — tóm tắt lỗi file import theo (mã lỗi, cột): số ô, số dòng Excel DUY NHẤT, số sản phẩm (nhóm ProductID), tối đa
// 5 dòng ví dụ. Dẫn xuất THUẦN từ chính kết quả validator (groupsRejected) — không có luật kiểm riêng, không đổi stats / payload / digest.
// Không client-only: server gửi kèm phản hồi preview (DTO), UI chỉ trình bày. Thuần, không import `xlsx` (client dùng được kiểu).

export interface CmsImportIssueLike { excelRow: number | null; column: string | null; code: string; message: string; fix: string }
export interface CmsImportRejectedLike { key: string; errors: CmsImportIssueLike[] }

export interface CmsImportIssueSummaryItem {
  code: string
  column: string | null
  /** Câu lỗi / cách sửa của lần gặp đầu (cùng mã + cột ⇒ cùng nghĩa; ví dụ câu có giá trị cụ thể vẫn là một loại). */
  message: string
  fix: string
  /** Số lần gặp (mỗi lần = một ô / một nhóm do validator báo). */
  cellCount: number
  /** Số dòng Excel khác nhau. */
  rowCount: number
  /** Số sản phẩm (nhóm ProductID) bị lỗi này — một SP có nhiều lỗi vẫn tính một lần cho mỗi loại, không cộng thành nhiều SP. */
  productCount: number
  /** Tối đa 5 dòng Excel đầu tiên (tăng dần) để tra nhanh; danh sách đầy đủ ở bảng lỗi / file lỗi. */
  exampleRows: number[]
}

export const CMS_ISSUE_EXAMPLE_ROWS = 5

export function cmsImportIssueSummary(groups: readonly CmsImportRejectedLike[]): CmsImportIssueSummaryItem[] {
  const acc = new Map<string, { item: CmsImportIssueSummaryItem; rows: Set<number>; keys: Set<string> }>()
  for (const g of groups) {
    for (const e of g.errors) {
      const k = `${e.code}\u0000${e.column ?? ''}`
      let a = acc.get(k)
      if (!a) {
        a = { item: { code: e.code, column: e.column, message: e.message, fix: e.fix, cellCount: 0, rowCount: 0, productCount: 0, exampleRows: [] }, rows: new Set(), keys: new Set() }
        acc.set(k, a)
      }
      a.item.cellCount++
      if (e.excelRow !== null) a.rows.add(e.excelRow)
      a.keys.add(g.key)
    }
  }
  return [...acc.values()]
    .map(({ item, rows, keys }) => {
      const sorted = [...rows].sort((x, y) => x - y)
      return { ...item, rowCount: sorted.length, productCount: keys.size, exampleRows: sorted.slice(0, CMS_ISSUE_EXAMPLE_ROWS) }
    })
    .sort((x, y) => (y.productCount - x.productCount) || (y.cellCount - x.cellCount) || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0)
      || ((x.column ?? '') < (y.column ?? '') ? -1 : (x.column ?? '') > (y.column ?? '') ? 1 : 0))
}
