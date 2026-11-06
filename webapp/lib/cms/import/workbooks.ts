// CMS P1-b — sinh workbook: file lỗi (SPEC §4.6) và template 9 cột (SPEC §4.1). Thuần.
//  · File lỗi: TOÀN BỘ dòng của các nhóm bị loại (không tạo thang bậc thiếu khi nạp lại) + cột Loi; sheet IMPORT_CMS
//    để sửa rồi nạp lại trực tiếp; giữ giá trị gốc (số giữ số, chữ giữ chữ).
//  · Template: 9 cột, ProductID SỐ GIẢ (999xxx — không tồn tại trên Product Master ⇒ dòng ví dụ bị loại nếu quên xoá).
//  · CMS-Q-220: bậc cuối luôn để TRỐNG Den_SL_ban (không giới hạn); không dùng số giả 999999 / 2147483647 để biểu diễn vô hạn.

import * as XLSX from 'xlsx'
import { CMS_IMPORT_COLUMNS, CMS_IMPORT_SHEET, type CmsImportRawRow } from './parse'
import type { CmsImportIssue } from './validate'

function toBytes(wb: XLSX.WorkBook): Uint8Array<ArrayBuffer> {
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer)
}

/** Nhóm bị loại ở dạng lưu trong import run (raw cells, không kèm ô đã phân loại). */
export interface CmsRejectedGroupRaw {
  key: string
  rows: readonly Pick<CmsImportRawRow, 'excelRow' | 'raw'>[]
  errors: readonly CmsImportIssue[]
}

export function buildCmsImportErrorXlsx(rejected: readonly CmsRejectedGroupRaw[]): Uint8Array<ArrayBuffer> {
  const aoa: (string | number | null)[][] = [[...CMS_IMPORT_COLUMNS, 'Loi']]
  for (const g of rejected) {
    const first = g.errors[0]
    for (const row of [...g.rows].sort((a, b) => a.excelRow - b.excelRow)) {
      const own = g.errors.filter((e) => e.excelRow === row.excelRow).map((e) => `${e.column ? `[${e.column}] ` : ''}${e.message} — ${e.fix}`)
      const loi = own.length ? own.join('; ')
        : first ? `Cả nhóm ProductID bị loại do lỗi ở dòng ${first.excelRow ?? '?'}: ${first.message}` : 'Cả nhóm ProductID bị loại'
      aoa.push([...CMS_IMPORT_COLUMNS.map((c) => row.raw[c]), loi])
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, CMS_IMPORT_SHEET)
  return toBytes(wb)
}

export const CMS_TEMPLATE_EXAMPLE_IDS = ['999001', '999002', '999003'] as const

export function buildCmsImportTemplateXlsx(): Uint8Array<ArrayBuffer> {
  const [a, b, c] = CMS_TEMPLATE_EXAMPLE_IDS
  const aoa: (string | number | null)[][] = [
    ['CIRCA | FILE IMPORT CMS THEO SẢN PHẨM (mẫu r2 — 9 cột)'],
    ['Dòng ví dụ dùng ProductID GIẢ (999xxx) — XOÁ trước khi nạp. Chỉ upload sau khi kiểm duyệt nội dung tư vấn.'],
    [],
    [...CMS_IMPORT_COLUMNS],
    [Number(a), 10000000, 'GMV_THEO_PRODUCTID', 1, 9, 15000, 'Nội dung tư vấn mẫu — thay bằng tài liệu được duyệt.', 'hộp', 24],
    [Number(a), 10000000, 'GMV_THEO_PRODUCTID', 10, 19, 20000, 'Nội dung tư vấn mẫu — thay bằng tài liệu được duyệt.', 'hộp', 24],
    [Number(a), 10000000, 'GMV_THEO_PRODUCTID', 20, null, 25000, 'Nội dung tư vấn mẫu — thay bằng tài liệu được duyệt.', 'hộp', 24],
    [Number(b), 50000000, 'GMV_TOAN_DANH_MUC', 1, null, 8000, 'Nội dung tư vấn mẫu — thay bằng tài liệu được duyệt.', 'chai', 1],
    [Number(c), null, null, 1, null, 5000, 'Nội dung tư vấn mẫu — thay bằng tài liệu được duyệt.', 'vỉ', 10],
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 22 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 48 }, { wch: 10 }, { wch: 18 }]
  const guide = XLSX.utils.aoa_to_sheet([
    ['TRƯỜNG', 'Ý NGHĨA', 'VÍ DỤ', 'GHI CHÚ'],
    ['ProductID', 'Mã product_id trên POS (số nguyên)', '12345', 'Bắt buộc; không dùng SKU / mã hàng; phải có trên Product Master'],
    ['KPI_Target_GMV_VND', 'Target GMV (VND, số nguyên)', '10000000', 'Để trống nếu không xét target; nhập ô số, không gõ dấu chấm / phẩy'],
    ['Loai_CMS_GMV', 'Cơ sở xét target', 'GMV_THEO_PRODUCTID', 'Hoặc GMV_TOAN_DANH_MUC (mọi dòng danh mục cùng một target); trống khi không target'],
    ['Tu_SL_ban / Den_SL_ban', 'Bậc số lượng (đơn vị CMS) trong kỳ', '1–9, 10–19, từ 20 trở lên', 'Bắt đầu từ 1, liên tục; bậc giữa ghi đủ Đến SL bán'],
    ['Den_SL_ban (bậc cuối)', 'Bậc cuối tính từ mốc này trở lên, không giới hạn số lượng', '(trống)', 'Để trống Đến SL bán. File cũ có số ở bậc cuối sẽ được bỏ giới hạn khi kiểm tra (có cảnh báo)'],
    ['CMS_VND_SP', 'CMS cho mỗi đơn vị CMS ở bậc', '15000', 'Tính lũy tiến: mỗi đơn vị theo bậc nó rơi vào'],
    ['Noi_dung_tu_van', 'Nội dung tư vấn đã kiểm duyệt', 'Thông tin đã duyệt', 'Bắt buộc, tối đa 4.000 ký tự, text thuần'],
    ['unit_CMS', 'Đơn vị hưởng CMS', 'hộp', 'Bắt buộc; nhãn hiển thị'],
    ['base_quantity_CMS', 'Số đơn vị cơ sở = 1 đơn vị CMS', '24', 'Số dương, dấu chấm thập phân, tối đa 9 chữ số sau dấu chấm; KHÔNG mặc định 1'],
    ['THAO TÁC', 'Upload → Kiểm tra → Xác nhận ghi → Kích hoạt', '', 'Dòng lỗi làm loại cả nhóm ProductID; tải file lỗi để sửa'],
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, CMS_IMPORT_SHEET)
  XLSX.utils.book_append_sheet(wb, guide, 'HUONG_DAN')
  return toBytes(wb)
}
