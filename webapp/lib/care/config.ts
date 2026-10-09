// CRM-CSKH — đọc cấu hình env dạng THUẦN (nhận `env` làm tham số) để test được
// mọi nhánh. Server code dùng các wrapper `server-only` ở lib/care/flags.ts.
// Khai báo đầy đủ trong webapp/.env.example (mục CRM-CSKH).

type Env = Record<string, string | undefined>

export interface CareFlags {
  /** CARE_ENABLED — UI/route/action CRM. OFF = module vô hình. */
  enabled: boolean
  /** CARE_SYNC_ENABLED — cron đóng kỳ + đồng bộ đơn. Độc lập với `enabled`. */
  syncEnabled: boolean
}

/** Chỉ đúng chuỗi 'true' mới bật (cùng quy ước lib/kpi/flags.ts): '1', 'TRUE', ' true' đều OFF. */
export function careFlagsFromEnv(env: Env): CareFlags {
  return {
    enabled: env.CARE_ENABLED === 'true',
    syncEnabled: env.CARE_SYNC_ENABLED === 'true',
  }
}

// Mặc định TẠM do Dev chọn (dưới trần cứng); Q-63 bỏ dependency số MB trước
// B2. TODO(Q-63): chốt lại sau QA thủ công file Excel thật trước bật cờ (B6).
export const CARE_IMPORT_DEFAULT_MAX_BYTES = 8 * 1024 * 1024
// Trần cứng: khi có proxy.ts, Next chỉ buffer body tới
// `experimental.proxyClientMaxBodySize` (mặc định 10MB — node_modules/next/
// dist/docs/01-app/03-api-reference/05-config/01-next-config-js/
// proxyClientMaxBodySize.md), phần vượt bị cắt và chỉ log cảnh báo. Repo không
// cấu hình giá trị này ⇒ cho phép > 10MB là upload mà route không nhận đủ.
export const CARE_IMPORT_HARD_MAX_BYTES = 10 * 1024 * 1024
const CARE_IMPORT_MIN_BYTES = 64 * 1024

/**
 * CARE_IMPORT_MAX_BYTES: trống ⇒ mặc định 8MB. Giá trị sai/ngoài [64KB, 10MB]
 * ⇒ throw — cấu hình hỏng phải lộ ngay, không âm thầm nới giới hạn upload.
 */
export function careImportMaxBytes(env: Env): number {
  const raw = env.CARE_IMPORT_MAX_BYTES?.trim()
  if (!raw) return CARE_IMPORT_DEFAULT_MAX_BYTES
  if (!/^\d+$/.test(raw)) throw new Error(`CARE_IMPORT_MAX_BYTES không phải số nguyên byte: "${raw}"`)
  const n = Number(raw)
  if (n < CARE_IMPORT_MIN_BYTES || n > CARE_IMPORT_HARD_MAX_BYTES) {
    throw new Error(`CARE_IMPORT_MAX_BYTES=${n} ngoài khoảng [${CARE_IMPORT_MIN_BYTES}, ${CARE_IMPORT_HARD_MAX_BYTES}]`)
  }
  return n
}

// project.dataset.table — chỉ ký tự an toàn để nội suy vào FROM `...` (tên bảng
// không truyền được bằng query parameter của BigQuery). B5b: bỏ `$` (partition decorator).
const BQ_TABLE_RE = /^[a-z][a-z0-9-]{4,29}\.[A-Za-z0-9_]{1,1024}\.[A-Za-z0-9_-]{1,1024}$/

/** Kiểm lại tên object ngay trước khi nội suy vào SQL (lớp phòng thủ thứ hai sau careBqOrdersTable). */
export function isSafeBqTableName(name: string): boolean {
  return BQ_TABLE_RE.test(name)
}

/**
 * CARE_BQ_ORDERS_TABLE: bảng/view N3 (data contract r3.2). Trống ⇒ null (chưa
 * cấu hình — B5 sẽ fail-closed, giữ snapshot). Sai định dạng ⇒ throw.
 * TODO(Q-51/T-10): tên bảng thật chờ BI/operator xác nhận trước B5.
 */
export function careBqOrdersTable(env: Env): string | null {
  const raw = env.CARE_BQ_ORDERS_TABLE?.trim()
  if (!raw) return null
  if (!BQ_TABLE_RE.test(raw)) {
    throw new Error(`CARE_BQ_ORDERS_TABLE phải dạng project.dataset.table (không backtick/khoảng trắng): "${raw}"`)
  }
  return raw
}
