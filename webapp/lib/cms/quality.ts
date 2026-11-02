// CMS — kiểm chất lượng một snapshot nguồn dòng đơn (SPEC §6). Bất kỳ lý do
// nào ⇒ held: giữ snapshot công bố trước, không công bố số thiếu, không ghi 0
// thay lỗi. Hàm thuần, không I/O.

import type { CmsRowIssue } from './source/contract'

/** Trần dòng / chương trình / lượt; vượt ⇒ held, không lấy một phần. */
export const CMS_SALES_ROW_CAP = 200_000

export type CmsHoldReason =
  | 'INCOMPLETE_PAGES'            // không đọc đủ trang / số dòng đọc ≠ totalRows
  | 'OVER_CAP'                    // vượt CMS_SALES_ROW_CAP
  | 'DUPLICATE_LINE_ID'           // trùng order_line_id trong snapshot
  | 'ROW_ISSUES'                  // sai số / timestamp / thiếu trường / ProductID hỏng
  | 'UNCONVERTED_UNITS'           // thiếu hoặc sai base_quantity ⇒ nhóm "Chưa quy đổi đơn vị"
  | 'EMPTY_AFTER_DATA'            // rỗng bất thường sau snapshot đã có dữ liệu
  | 'UNASSIGNED_OVER_THRESHOLD'   // chưa gán > 20% dòng ứng viên

export interface CmsSnapshotFacts {
  rowsRead: number
  /** totalRows BigQuery báo; null khi adapter không có (fixture). */
  totalRowsReported: number | null
  pagesComplete: boolean
  rowIssues: readonly CmsRowIssue[][]
  lineIds: readonly string[]
  /** Dòng ứng viên: OFFLINE + COMPLETED + trong kỳ + ProductID thuộc chương trình. */
  candidates: number
  /** Ứng viên không map được người bán. */
  unassigned: number
  /** Số dòng của snapshot công bố gần nhất; null = chưa từng công bố. */
  previousPublishedRows: number | null
}

export interface CmsQualityVerdict {
  status: 'ok' | 'held'
  reasons: CmsHoldReason[]
  duplicateLineIds: string[]
  /** Tỷ lệ chưa gán (0–1) để báo cáo; null khi không có ứng viên. */
  unassignedRatio: number | null
}

export function findDuplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) dup.add(id)
    else seen.add(id)
  }
  return [...dup].sort()
}

export function assessSalesSnapshot(f: CmsSnapshotFacts): CmsQualityVerdict {
  const reasons: CmsHoldReason[] = []
  if (!f.pagesComplete || (f.totalRowsReported !== null && f.totalRowsReported !== f.rowsRead)) reasons.push('INCOMPLETE_PAGES')
  if (f.rowsRead > CMS_SALES_ROW_CAP || (f.totalRowsReported ?? 0) > CMS_SALES_ROW_CAP) reasons.push('OVER_CAP')
  const duplicateLineIds = findDuplicates(f.lineIds)
  if (duplicateLineIds.length) reasons.push('DUPLICATE_LINE_ID')
  const flat = f.rowIssues.flat()
  if (flat.some((i) => i.field === 'base_quantity')) reasons.push('UNCONVERTED_UNITS')
  if (flat.some((i) => i.field !== 'base_quantity')) reasons.push('ROW_ISSUES')
  if (f.rowsRead === 0 && (f.previousPublishedRows ?? 0) > 0) reasons.push('EMPTY_AFTER_DATA')
  // > 20% bằng phép nguyên: unassigned / candidates > 1/5 ⇔ 5·unassigned > candidates.
  if (f.candidates > 0 && f.unassigned * 5 > f.candidates) reasons.push('UNASSIGNED_OVER_THRESHOLD')
  return {
    status: reasons.length ? 'held' : 'ok',
    reasons,
    duplicateLineIds,
    unassignedRatio: f.candidates > 0 ? f.unassigned / f.candidates : null,
  }
}
