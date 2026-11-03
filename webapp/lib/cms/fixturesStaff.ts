// CMS P1-d — dữ liệu GIẢ cho fixture /ui-catalog/cms-v2/{staff,product} (dev-only, UI_CATALOG=1). Dùng lại sản phẩm giả
// của P1-c (lib/cms/fixtures — không sửa file đó); ProductID giả 9xxxxx, ảnh dự phòng (không gọi CDN ngoài).
import { CMS_FX_PRODUCTS, CMS_FX_TODAY } from './fixtures'
import type { CmsProductView, CmsProgramRowView } from './server/catalog'

export { CMS_FX_TODAY }
const day = (n: number) => { const d = new Date(`${CMS_FX_TODAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const prog = (n: number, o: Partial<CmsProgramRowView>): CmsProgramRowView => ({
  id: uid(n), name: `Chương trình mẫu ${n}`, status: 'active', startDate: day(-10), endDate: day(20), scope: 'all', isTest: false,
  catalogTargetGmv: '50000000', configVersion: 2, activatedAt: '2026-11-01T02:00:00Z', createdAt: '2026-10-28T02:00:00Z', ...o,
})

export const CMS_FX_STAFF_PROGRAMS: CmsProgramRowView[] = [
  prog(1, { name: 'CMS Vitamin & khoáng chất mùa lạnh — tăng tư vấn sản phẩm tăng đề kháng cho khách gia đình (đợt 2)', startDate: day(-14), endDate: day(15) }),
  prog(2, { name: 'CMS Men vi sinh', startDate: day(-3), endDate: day(40), catalogTargetGmv: null }),
  prog(3, { name: 'CMS Chăm sóc da tháng 12', startDate: day(16), endDate: day(46), catalogTargetGmv: null }),
]

/** P3a r2 (PM r1 PKG-P1-1): chương trình ĐÃ KẾT THÚC cho fixture — [0] Chờ chốt kỳ (active, hết ngày), [1] Đã chốt (locked).
 *  Tách khỏi CMS_FX_STAFF_PROGRAMS để không đổi các fixture / test P1–P2 sẵn có. */
export const CMS_FX_STAFF_ENDED: CmsProgramRowView[] = [
  prog(4, { name: 'CMS Khẩu trang tháng 10', startDate: day(-40), endDate: day(-2), catalogTargetGmv: null }),
  prog(5, { name: 'CMS Thực phẩm chức năng quý 3', status: 'locked', startDate: day(-70), endDate: day(-35), catalogTargetGmv: null }),
]

export const CMS_FX_LONG_ADVICE = [
  'Hỏi nhu cầu và đối tượng dùng (người lớn, trẻ em, phụ nữ có thai) trước khi tư vấn.',
  'Liều dùng theo hướng dẫn trên nhãn; không dùng quá liều khuyến cáo.',
  'Nhắc khách đọc kỹ hướng dẫn sử dụng trước khi dùng; ngưng dùng và hỏi ý kiến bác sĩ nếu có dấu hiệu bất thường.',
  '',
  'Gợi ý bán kèm: nước muối sinh lý, khẩu trang — chỉ khi khách có nhu cầu.',
  'Nội dung mẫu cho fixture — dòng dài để kiểm tra xuống dòng trong khung trên màn hình 360px mà không cuộn ngang trang.',
].join('\n')

export function cmsFxStaffProducts(programId: string): CmsProductView[] {
  return CMS_FX_PRODUCTS.map((p) => ({ ...p, programId }))
}
