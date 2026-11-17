// F-B (PM spec 17/11 §4) — nhận diện MẪU file import CMS khi parser của loại đã chọn từ chối (NO_SHEET / MISSING_COLUMNS), để báo đúng
// "chọn nhầm loại file". Thuần (chỉ bytes). KHÔNG chọn parser khác, KHÔNG đổi loại file, KHÔNG nhận thêm dòng: kết quả chỉ dùng để
// chọn câu báo lỗi.
//
// Chữ ký lấy từ CHÍNH chuẩn hoá tiêu đề của hai parser (parse.ts cmsImportColumnOf · parseSimple.ts cmsSimpleFieldOf), sau zip guard:
//   · tiers  — sheet IMPORT_CMS có một dòng tiêu đề (≤ 50 dòng đầu) chứa ĐỦ 9 cột hợp đồng và KHÔNG có cột chỉ-mẫu-đơn-giản
//              (product_name / brand_name / giá / CMS proposal / CTKM). Tên sheet IMPORT_CMS một mình KHÔNG đủ.
//   · simple — sheet ĐẦU TIÊN có một dòng tiêu đề chứa ĐỦ 7 cột bắt buộc của mẫu mức cố định và KHÔNG có cột chỉ-mẫu-9-cột
//              (KPI_Target_GMV_VND / Loai_CMS_GMV / Tu_SL_ban / Den_SL_ban / CMS_VND_SP).
//   · cả hai ⇒ 'ambiguous'; không cái nào (tiêu đề hỏng / lẫn / thiếu) ⇒ 'unknown' ⇒ giữ lỗi gốc của loại đã chọn.
import * as XLSX from 'xlsx'
import { cmsZipGuard } from './zipGuard'
import { CMS_IMPORT_COLUMNS, CMS_IMPORT_SHEET, cellOf, cmsImportColumnOf, type CmsImportColumn } from './parse'
import { CMS_SIMPLE_REQUIRED, cmsSimpleFieldOf, type CmsSimpleField } from './parseSimple'

export type CmsDetectedFormat = 'tiers' | 'simple' | 'ambiguous' | 'unknown'

const HEADER_SCAN_ROWS = 50
const SIMPLE_ONLY: ReadonlySet<CmsSimpleField> = new Set(['product_name', 'brand_name', 'price', 'cms', 'promo'])
const TIERS_ONLY: ReadonlySet<CmsImportColumn> = new Set(['KPI_Target_GMV_VND', 'Loai_CMS_GMV', 'Tu_SL_ban', 'Den_SL_ban', 'CMS_VND_SP'])

function headerRows(ws: XLSX.WorkSheet | undefined): string[][] {
  if (!ws || !ws['!ref']) return []
  const range = XLSX.utils.decode_range(ws['!ref'])
  const out: string[][] = []
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1); r++) {
    const row: string[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = cellOf(ws, r, c)
      if (cell && cell.t === 's') row.push(String(cell.v ?? ''))
    }
    if (row.length) out.push(row)
  }
  return out
}

const isTiersHeader = (row: string[]): boolean => {
  const cols = new Set(row.map(cmsImportColumnOf).filter((c): c is CmsImportColumn => c !== null))
  return CMS_IMPORT_COLUMNS.every((c) => cols.has(c)) && !row.some((h) => { const f = cmsSimpleFieldOf(h); return f !== null && SIMPLE_ONLY.has(f) })
}
const isSimpleHeader = (row: string[]): boolean => {
  const fields = new Set(row.map(cmsSimpleFieldOf).filter((f): f is CmsSimpleField => f !== null))
  return CMS_SIMPLE_REQUIRED.every((f) => fields.has(f)) && !row.some((h) => { const c = cmsImportColumnOf(h); return c !== null && TIERS_ONLY.has(c) })
}

export function detectCmsImportFormat(bytes: Uint8Array): CmsDetectedFormat {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return 'unknown'
  if (!cmsZipGuard(bytes).ok) return 'unknown'
  let names: string[]
  let wb: XLSX.WorkBook
  try {
    names = XLSX.read(bytes, { type: 'array', bookSheets: true }).SheetNames ?? []
    if (names.length === 0) return 'unknown'
    const want = [...new Set([names[0], ...(names.includes(CMS_IMPORT_SHEET) ? [CMS_IMPORT_SHEET] : [])])]
    wb = XLSX.read(bytes, { type: 'array', cellFormula: false, cellHTML: false, cellText: false, dense: false, sheets: want, sheetRows: HEADER_SCAN_ROWS })
  } catch {
    return 'unknown'
  }
  const tiers = headerRows(wb.Sheets[CMS_IMPORT_SHEET]).some(isTiersHeader)
  const simple = headerRows(wb.Sheets[names[0]]).some(isSimpleHeader)
  if (tiers && simple) return 'ambiguous'
  return tiers ? 'tiers' : simple ? 'simple' : 'unknown'
}
