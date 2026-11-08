// CMS đơn giản S1 — nhãn cột file mức cố định, dùng chung server (parser / file lỗi / file mẫu) và client (bảng hướng dẫn, bảng lỗi).
// Thuần, KHÔNG import `xlsx` (client component dùng được, không kéo thư viện đọc Excel vào bundle).

export type CmsSimpleField = 'product_id' | 'product_name' | 'brand_name' | 'unit' | 'price' | 'cms' | 'promo' | 'base_quantity' | 'advice'

/** Nhãn cột hiển thị / file lỗi / file mẫu. */
export const CMS_SIMPLE_HEADER: Record<CmsSimpleField, string> = {
  product_id: 'product_id', product_name: 'product_name', brand_name: 'brand_name', unit: 'ĐV tính CMS (1 item)',
  price: 'Giá bán / item (đ)', cms: 'CMS proposal', promo: 'CTKM', base_quantity: 'base_quantity_CMS', advice: 'Noi_dung_tu_van',
}

/** Cột canonical (9 cột IMPORT_CMS) ⇐ trường file mức cố định — để báo lỗi theo tên cột người dùng thấy. */
export const CMS_SIMPLE_COLUMN_OF: Readonly<Record<string, CmsSimpleField>> = {
  ProductID: 'product_id', CMS_VND_SP: 'cms', unit_CMS: 'unit', base_quantity_CMS: 'base_quantity', Noi_dung_tu_van: 'advice',
}

/** Tên cột người dùng thấy cho một cột canonical theo loại file. */
export function cmsImportColumnLabel(column: string | null, format: 'tiers' | 'simple' | undefined): string | null {
  if (column === null) return null
  if (format === 'simple') { const f = CMS_SIMPLE_COLUMN_OF[column]; return f ? CMS_SIMPLE_HEADER[f] : column }
  return column
}
