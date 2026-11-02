// CMS — cấu hình nguồn BigQuery (SPEC §1.4, §9). Tên bảng/view thật chỉ qua
// env, dạng project.dataset.table; không hardcode nguồn thô, không nội suy giá
// trị khác vào SQL. Trống ⇒ null (cron/bootstrap báo thiếu cấu hình, KHÔNG
// query). Sai định dạng ⇒ throw (cấu hình hỏng phải lộ ngay). Hàm thuần.

import { isSafeBqTableName } from '../care/config'

type Env = Record<string, string | undefined>

function tableFromEnv(env: Env, key: 'CMS_BQ_PRODUCTS_TABLE' | 'CMS_BQ_SALES_TABLE'): string | null {
  const raw = env[key]?.trim()
  if (!raw) return null
  if (!isSafeBqTableName(raw)) {
    // Không in giá trị (tên view nội bộ) — chỉ tên biến.
    throw new Error(`${key} phải dạng project.dataset.table (không backtick/khoảng trắng/decorator)`)
  }
  return raw
}

/** View Product Master theo cột chuẩn SPEC §1.1. */
export function cmsBqProductsTable(env: Env): string | null {
  return tableFromEnv(env, 'CMS_BQ_PRODUCTS_TABLE')
}

/** View dòng đơn theo cột chuẩn SPEC §1.2. */
export function cmsBqSalesTable(env: Env): string | null {
  return tableFromEnv(env, 'CMS_BQ_SALES_TABLE')
}
