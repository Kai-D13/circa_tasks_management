// CMS P0-a — dữ liệu nguồn GIẢ (không email/đơn/POS thật). Shape theo view
// chuẩn SPEC §1.1/§1.2: mọi giá trị là chuỗi như BigQuery trả; timestamp ISO
// UTC 6 chữ số micro giây (adapter FORMAT_TIMESTAMP). Định danh giả nhất quán:
// ProductID 9xxxxx, đơn TEST-*, email *@cms.example.test, POS POS-T*.

import type { CmsRawRow } from '../lib/cms/source/contract'

export const FX_PRODUCTS: CmsRawRow[] = [
  { product_id: '900001', product_name: 'Sản phẩm giả A 500mg', image_url: 'https://cdn.example.test/thuocsi-live/images/fake-a.jpg', is_active: 'true', source_updated_at: '2026-10-30T01:00:00.000000Z', reference_price: '120000', price_unit: 'hộp' },
  { product_id: '900002', product_name: 'Sản phẩm giả B siro', image_url: null, is_active: 'false', source_updated_at: '2026-10-30T01:00:00.000001Z', reference_price: null, price_unit: null },
  { product_id: '900003', product_name: 'Sản phẩm giả C', image_url: null, is_active: 'true', source_updated_at: '2026-10-30T01:00:00Z', reference_price: '9.5', price_unit: 'viên' },
]

export const fxSale = (o: Partial<Record<string, string | null>>): CmsRawRow => ({
  order_line_id: 'L-0001', order_id: 'O-0001', order_code: 'TEST-0001', product_id: '900001',
  seller_email: 'ds.a@cms.example.test', pos_code: 'POS-T01', order_type: 'OFFLINE', order_status: 'COMPLETED',
  completed_at: '2026-11-05T03:00:00.000000Z', quantity_raw: '1', uom_raw: 'hộp', base_quantity: '24',
  gmv_amount: '120000', source_updated_at: '2026-11-05T03:00:01.000000Z',
  ...o,
})

// Kỳ chương trình giả 05/11–06/11/2026 (VN) ⇒ cửa sổ UTC [04/11 17:00, 06/11 17:00).
export const FX_SALES: CmsRawRow[] = [
  fxSale({ order_line_id: 'L-01', completed_at: '2026-11-04T16:59:59.999999Z' }),               // 23:59:59 VN 04/11 — ngoài kỳ
  fxSale({ order_line_id: 'L-02', completed_at: '2026-11-04T17:00:00.000000Z' }),               // 00:00 VN 05/11 — trong kỳ (biên đầu)
  fxSale({ order_line_id: 'L-03', completed_at: '2026-11-06T16:59:59.999999Z', product_id: '900002' }), // 23:59:59.999999 VN 06/11 — trong kỳ
  fxSale({ order_line_id: 'L-04', completed_at: '2026-11-06T17:00:00.000000Z' }),               // 00:00 VN 07/11 — ngoài kỳ (biên cuối exclusive)
  fxSale({ order_line_id: 'L-05', product_id: '900009' }),                                       // ProductID ngoài chương trình
  fxSale({ order_line_id: 'L-06', order_type: 'ONLINE' }),                                       // đọc được, không phải ứng viên
  fxSale({ order_line_id: 'L-07', order_type: null }),                                           // thiếu order_type ⇒ adapter từ chối dòng
  fxSale({ order_line_id: 'L-08', base_quantity: '1.0000000001' }),                              // > 9 chữ số thập phân ⇒ lỗi quy đổi
]
