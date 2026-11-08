// CMS P1-b — sinh workbook: file lỗi (SPEC §4.6) và template 9 cột (SPEC §4.1). Thuần.
//  · File lỗi: TOÀN BỘ dòng của các nhóm bị loại (không tạo thang bậc thiếu khi nạp lại) + cột Loi; sheet IMPORT_CMS
//    để sửa rồi nạp lại trực tiếp; giữ giá trị gốc (số giữ số, chữ giữ chữ).
//  · Template: 9 cột, ProductID SỐ GIẢ (999xxx — không tồn tại trên Product Master ⇒ dòng ví dụ bị loại nếu quên xoá).
//  · CMS-Q-220: bậc cuối luôn để TRỐNG Den_SL_ban (không giới hạn); không dùng số giả 999999 / 2147483647 để biểu diễn vô hạn.

import * as XLSX from 'xlsx'
import { CMS_IMPORT_COLUMNS, CMS_IMPORT_SHEET, type CmsImportColumn, type CmsImportRawRow } from './parse'
import type { CmsImportIssue } from './validate'
import { CMS_SIMPLE_HEADER, cmsImportColumnLabel, type CmsSimpleField } from './simpleColumns'

function toBytes(wb: XLSX.WorkBook): Uint8Array<ArrayBuffer> {
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer)
}

/** Nhóm bị loại ở dạng lưu trong import run (raw cells, không kèm ô đã phân loại). */
export interface CmsRejectedGroupRaw {
  key: string
  rows: readonly Pick<CmsImportRawRow, 'excelRow' | 'raw' | 'info'>[]
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

/** CMS đơn giản S1 — file lỗi đúng BỐ CỤC mức cố định (7 cột business + 2 cột bổ sung + Loi) để sửa rồi nạp lại bằng mẫu mức cố định. */
export const CMS_SIMPLE_SHEET = 'MUC_CO_DINH'
const SIMPLE_ORDER: CmsSimpleField[] = ['product_id', 'product_name', 'brand_name', 'unit', 'price', 'cms', 'promo', 'base_quantity', 'advice']
const SIMPLE_FROM_RAW: Partial<Record<CmsSimpleField, CmsImportColumn>> = {
  product_id: 'ProductID', unit: 'unit_CMS', cms: 'CMS_VND_SP', base_quantity: 'base_quantity_CMS', advice: 'Noi_dung_tu_van',
}
export function buildCmsSimpleErrorXlsx(rejected: readonly CmsRejectedGroupRaw[]): Uint8Array<ArrayBuffer> {
  const aoa: (string | number | null)[][] = [[...SIMPLE_ORDER.map((f) => CMS_SIMPLE_HEADER[f]), 'Loi']]
  for (const g of rejected) {
    const first = g.errors[0]
    const label = (e: CmsImportIssue) => cmsImportColumnLabel(e.column, 'simple')
    for (const row of [...g.rows].sort((a, b) => a.excelRow - b.excelRow)) {
      const own = g.errors.filter((e) => e.excelRow === row.excelRow).map((e) => `${label(e) ? `[${label(e)}] ` : ''}${e.message} — ${e.fix}`)
      const loi = own.length ? own.join('; ')
        : first ? `Cả sản phẩm bị loại do lỗi ở dòng ${first.excelRow ?? '?'}: ${first.message}` : 'Cả sản phẩm bị loại'
      aoa.push([...SIMPLE_ORDER.map((f) => { const c = SIMPLE_FROM_RAW[f]; return c ? row.raw[c] : row.info?.[f] ?? null }), loi])
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, CMS_SIMPLE_SHEET)
  return toBytes(wb)
}

/** File mẫu mức cố định: 7 cột business + 2 cột bổ sung bắt buộc để ghi (K, tư vấn); ProductID GIẢ 999xxx. */
export function buildCmsSimpleTemplateXlsx(): Uint8Array<ArrayBuffer> {
  const [a, b] = CMS_TEMPLATE_EXAMPLE_IDS
  const advice = 'Nội dung tư vấn mẫu — thay bằng tài liệu được duyệt.'
  const aoa: (string | number | null)[][] = [
    SIMPLE_ORDER.map((f) => (f === 'promo' ? 'CTKM tháng 11' : CMS_SIMPLE_HEADER[f])),
    [Number(a), 'Sản phẩm mẫu A (xoá dòng này)', 'Brand mẫu', 'hộp', 320000, 25000, 0, 30, advice],
    [Number(b), 'Sản phẩm mẫu B (xoá dòng này)', 'Brand mẫu', 'chai', 95000, 18000, 0.1, 1, advice],
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 12 }, { wch: 36 }, { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 48 }]
  const guide = XLSX.utils.aoa_to_sheet([
    ['CỘT', 'Ý NGHĨA', 'GHI CHÚ'],
    ['product_id', 'Mã product_id trên POS (số nguyên)', 'Bắt buộc; mỗi sản phẩm MỘT dòng; phải có trên Product Master'],
    ['product_name · brand_name · Giá bán / item (đ) · CTKM', 'Thông tin tham khảo', 'KHÔNG dùng trong công thức CMS; tên / ảnh / giá hiển thị theo Product Master'],
    ['ĐV tính CMS (1 item)', 'Đơn vị hưởng CMS', 'Bắt buộc (vd. hộp, chai)'],
    ['CMS proposal', 'Mức CMS cố định cho MỖI đơn vị CMS (VND, số nguyên)', 'Bắt buộc; nhập ô số; không target, không bậc'],
    ['base_quantity_CMS', 'Số đơn vị cơ sở = 1 đơn vị CMS (K)', 'Bắt buộc để ghi; KHÔNG mặc định 1; hệ thống đối chiếu với dữ liệu bán khi kiểm tra'],
    ['Noi_dung_tu_van', 'Nội dung tư vấn đã kiểm duyệt', 'Bắt buộc để ghi; tối đa 4.000 ký tự'],
    ['CÁCH TÍNH', 'CMS = floor(tổng lượng cơ sở bán / K) × CMS proposal, theo từng dược sĩ × sản phẩm trong kỳ', ''],
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, CMS_SIMPLE_SHEET)
  XLSX.utils.book_append_sheet(wb, guide, 'HUONG_DAN')
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
