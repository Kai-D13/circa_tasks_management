// CMS-CALC-RET-2 P5.5 — XLSX BÁO CÁO TRẢ HÀNG SAU CHỐT (super). Lõi thuần: chỉ trình bày số DB đã tính trong báo cáo (rpc_cms_return_close_report)
// — không tính lại tiền. Đối chiếu trước khi trả file: Σ dòng frozen / recomputed / delta = header; đủ line_count. Lệch ⇒ không file.
// Báo cáo tham khảo — KHÔNG phải lệnh thu / chi, không đổi số đã chốt (ghi ở sheet Thong tin).
import * as XLSX from 'xlsx'
import { cmsDecCell, cmsIntCell } from './exportResults'
import { CMS_CLOSE_REPORT_NOTE, type CmsCloseReportPage } from './returnsView'

const vnTime = (iso: string): string => {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = new Date(t + 7 * 3600_000).toISOString()
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${d.slice(11, 19)}`
}

export type CmsCloseReportBuild = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; error: 'COUNT_MISMATCH' | 'TOTAL_MISMATCH' }

export function buildCmsCloseReportWorkbook(i: {
  program: { id: string; name: string; startDate: string; endDate: string }
  page: CmsCloseReportPage
  products: { id: string; nameSnapshot: string; unitCms: string }[]
  exportedAt: Date
}): CmsCloseReportBuild {
  const r = i.page.report
  const lines = i.page.lines
  if (lines.length !== r.lineCount) return { ok: false, error: 'COUNT_MISMATCH' }
  const sum = (k: 'frozenAmount' | 'recomputedAmount' | 'delta') => lines.reduce((s, l) => s + BigInt(l[k]), BigInt(0))
  if (sum('frozenAmount') !== BigInt(r.frozenAmount) || sum('recomputedAmount') !== BigInt(r.recomputedAmount) || sum('delta') !== BigInt(r.deltaAmount)
      || lines.reduce((s, l) => s + l.returnEvents, 0) !== r.returnEvents) {
    return { ok: false, error: 'TOTAL_MISMATCH' }
  }
  const prod = new Map(i.products.map((p) => [p.id, p]))
  const wb = XLSX.utils.book_new()
  const add = (name: string, aoa: (string | number | null)[][]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  add('Thong tin', [
    ['Mục', 'Giá trị'],
    ['Loại báo cáo', 'Báo cáo trả hàng SAU CHỐT (tham khảo)'],
    ['Lưu ý', CMS_CLOSE_REPORT_NOTE],
    ['Chương trình', i.program.name],
    ['ID chương trình', i.program.id],
    ['Kỳ', `${i.program.startDate} → ${i.program.endDate}`],
    ['report_id', r.id],
    ['Run đã chốt (payout_run_id)', r.payoutRunId],
    ['Dữ liệu trả đến (VN)', vnTime(r.returnsAsOf)],
    ['Digest phiếu trả', r.returnsDigest],
    ['Lần kiểm sổ', r.evalSeq],
    ['Tạo bởi', r.createdVia === 'cron' ? 'Job định kỳ' : 'Super'],
    ['Tạo lúc (VN)', vnTime(r.createdAt)],
    ['Số phiếu trả áp dụng', r.returnEvents],
    ['CMS đã chốt (VND)', cmsIntCell(r.frozenAmount)],
    ['CMS tính lại khi trừ trả (VND)', cmsIntCell(r.recomputedAmount)],
    ['Chênh lệch (VND)', cmsIntCell(r.deltaAmount)],
    ['Xuất lúc (VN)', vnTime(i.exportedAt.toISOString())],
  ])
  const sheet: (string | number | null)[][] = [['Dược sĩ', 'user_id', 'ProductID', 'Tên sản phẩm', 'Đơn vị CMS', 'K', 'SL cơ sở đã chốt', 'SL CMS đã chốt', 'GMV đã chốt (VND)',
    'Đạt ĐK lúc chốt', 'CMS đã chốt (VND)', 'SL cơ sở trả', 'GMV trả (VND)', 'Phiếu trả', 'SL cơ sở còn lại', 'GMV ròng (VND)', 'Đạt ĐK sau trả',
    'SL CMS tính lại', 'CMS tính lại (VND)', 'Chênh lệch (VND)']]
  for (const l of lines) {
    const p = prod.get(l.programProductId)
    sheet.push([l.fullName ?? '', l.userId, l.productId, p?.nameSnapshot ?? '', p?.unitCms ?? '', cmsDecCell(l.perUnit), cmsDecCell(l.frozenBase), cmsIntCell(l.frozenQty),
      cmsDecCell(l.frozenGmv), l.frozenGateMet ? 'Đạt' : 'Chưa đạt', cmsIntCell(l.frozenAmount), cmsDecCell(l.returnBase), cmsDecCell(l.returnGmv), l.returnEvents,
      cmsDecCell(l.eligibleBase), cmsDecCell(l.netGmv), l.gateMet ? 'Đạt' : 'Chưa đạt', cmsIntCell(l.recomputedQty), cmsIntCell(l.recomputedAmount), cmsIntCell(l.delta)])
  }
  sheet.push(['Tổng', '', '', '', '', '', '', '', '', '', cmsIntCell(r.frozenAmount), '', '', r.returnEvents, '', '', '', '', cmsIntCell(r.recomputedAmount), cmsIntCell(r.deltaAmount)])
  add('Theo duoc si', sheet)
  return { ok: true, bytes: new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer) }
}
