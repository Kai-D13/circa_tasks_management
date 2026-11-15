// CMS — cấu hình nguồn BigQuery (SPEC §1.4, §9). Tên bảng/view thật chỉ qua
// env, dạng project.dataset.table; không hardcode nguồn thô, không nội suy giá
// trị khác vào SQL. Trống ⇒ null (cron/bootstrap báo thiếu cấu hình, KHÔNG
// query). Sai định dạng ⇒ throw (cấu hình hỏng phải lộ ngay). Hàm thuần.

import { isSafeBqTableName } from '../care/config'

type Env = Record<string, string | undefined>

function tableFromEnv(env: Env, key: 'CMS_BQ_PRODUCTS_TABLE' | 'CMS_BQ_SALES_TABLE' | 'CMS_BQ_RETURNS_TABLE'): string | null {
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

/**
 * View phiếu trả theo cột chuẩn CMS_RETURN_COLUMNS (CMS-CALC-RET-2 §2.1 — FQN BI chưa giao). Trống ⇒ null: chương trình
 * net_returns_v1 bị held SOURCE_NOT_CONFIGURED (KHÔNG publish net với 0 phiếu trả giả); sales-only không cần.
 */
export function cmsBqReturnsTable(env: Env): string | null {
  return tableFromEnv(env, 'CMS_BQ_RETURNS_TABLE')
}

/**
 * Trần byte (maximumBytesBilled) cho job nguồn của run contract. Trống ⇒ undefined (không đặt — như nguồn bán hiện hành). Sai định
 * dạng (không phải số nguyên dương) ⇒ throw (cấu hình hỏng phải lộ ngay).
 */
export function cmsBqContractMaxBytes(env: Env): number | undefined {
  const raw = env.CMS_BQ_CONTRACT_MAX_BYTES?.trim()
  if (!raw) return undefined
  const n = Number(raw)
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(n)) throw new Error('CMS_BQ_CONTRACT_MAX_BYTES phải là số nguyên dương (byte)')
  return n
}
