// CMS — cờ tính năng (SPEC §9). Server-only theo nghĩa: chỉ đọc ở server (không NEXT_PUBLIC); hàm
// cmsFlagsFromEnv thuần để test. Mặc định TẤT CẢ OFF; chỉ đúng chuỗi 'true' mới bật.
//   CMS_PROGRAM_ENABLED  — chương trình, danh mục, import, đọc tư vấn, cron Product Master (P1)
//   CMS_EARNINGS_ENABLED — sync / tính / hiển thị số CMS thực tế (P2 — chưa giao)
//   CMS_LOCK_ENABLED     — chốt kỳ và chi trả (P3 — HOLD)

type Env = Record<string, string | undefined>

export interface CmsFlags {
  program: boolean
  earnings: boolean
  lock: boolean
}

export function cmsFlagsFromEnv(env: Env): CmsFlags {
  return {
    program: env.CMS_PROGRAM_ENABLED === 'true',
    earnings: env.CMS_EARNINGS_ENABLED === 'true',
    lock: env.CMS_LOCK_ENABLED === 'true',
  }
}

export function isCmsProgramEnabled(): boolean {
  return cmsFlagsFromEnv(process.env).program
}

/** Số CMS thực tế (sync / tính / hiển thị) chỉ khi CẢ hai cờ program + earnings bật. */
export function isCmsEarningsEnabled(): boolean {
  const f = cmsFlagsFromEnv(process.env)
  return f.program && f.earnings
}

/** Chốt kỳ / chi trả (P3a) chỉ khi CẢ BA cờ program + earnings + lock bật — chốt dựa trên kết quả P2. */
export function cmsLockEnabledFromEnv(env: Env): boolean {
  const f = cmsFlagsFromEnv(env)
  return f.program && f.earnings && f.lock
}

export function isCmsLockEnabled(): boolean {
  return cmsLockEnabledFromEnv(process.env)
}

/**
 * Capture lớp NGUỒN của run bán (migration 124, PM COMP-INT §5.A): mặc định OFF, chỉ đúng chuỗi 'true' mới bật. Cờ CHỈ điều
 * khiển hành vi app — KHÔNG phải chứng cứ DB hỗ trợ: khi ON, lõi đồng bộ còn đòi rpc_cms_sales_run_open trả source_schema = 1
 * (thiếu / lạ ⇒ đóng run lỗi SOURCE_SCHEMA_UNSUPPORTED, không stage / publish). OFF ⇒ không gửi part 'source_lines'.
 */
export function cmsSourceCaptureFromEnv(env: Env): boolean {
  return env.CMS_SOURCE_CAPTURE_ENABLED === 'true'
}

export function isCmsSourceCaptureEnabled(): boolean {
  return cmsSourceCaptureFromEnv(process.env)
}

/**
 * Server QA (PM r1 PKG-P1-2): launcher `scripts/cms-qa-run.mjs` luôn đặt CMS_QA_SERVER=1 cho server localhost của run QA ⇒
 * action chốt từ UI bị từ chối TRƯỚC RPC (chỉ đọc: preview / số đã chốt / XLSX vẫn chạy). Chốt QA chỉ qua công cụ có gate +
 * sổ ý định (`scripts/cms-qa-results.mjs lock`). Chiều an toàn: đặt nhầm trên app thật chỉ làm khoá nút chốt, không mở quyền.
 */
export function cmsQaServerFromEnv(env: Env): boolean {
  return env.CMS_QA_SERVER === '1'
}

/**
 * CMS đơn giản S1 + S2 (PM spec r1 08/11 §4–§5): import mẫu mức cố định (7 cột) + kiểm K theo dữ liệu bán khi import. Mặc định OFF —
 * OFF ⇒ import như trước (chỉ mẫu 9 cột, không kiểm K). Chỉ có hiệu lực khi CMS_PROGRAM_ENABLED bật.
 */
export function cmsImportV2FromEnv(env: Env): boolean {
  return cmsFlagsFromEnv(env).program && env.CMS_IMPORT_V2_ENABLED === 'true'
}

export function isCmsImportV2Enabled(): boolean {
  return cmsImportV2FromEnv(process.env)
}

export function isCmsQaServer(): boolean {
  return cmsQaServerFromEnv(process.env)
}

/**
 * CMS-CALC-RET-2 (thiết kế Dev r2 §2; plan PM 13/11 §1): hai cờ mới, mặc định OFF, chỉ đúng chuỗi 'true'; chỉ hiệu lực khi CẢ
 * CMS_PROGRAM_ENABLED + CMS_EARNINGS_ENABLED bật.
 *   CMS_CALC_MODES_ENABLED — chọn cách tính lượng cho chương trình mới (save_v2) + worker chạy run contract của chương trình cms_unit.
 *   CMS_RETURNS_ENABLED    — pipeline trả hàng: worker chạy run net, chuyển policy, job báo cáo sau chốt.
 * Cờ OFF không đổi dữ liệu: chương trình contract đã có ⇒ worker dừng held (giữ pointer), KHÔNG quay về publish đường legacy.
 */
export interface CmsCalcFlags { modes: boolean; returns: boolean }

export function cmsCalcFlagsFromEnv(env: Env): CmsCalcFlags {
  const f = cmsFlagsFromEnv(env)
  const on = f.program && f.earnings
  return { modes: on && env.CMS_CALC_MODES_ENABLED === 'true', returns: on && env.CMS_RETURNS_ENABLED === 'true' }
}

export function cmsCalcFlags(): CmsCalcFlags {
  return cmsCalcFlagsFromEnv(process.env)
}

/**
 * Trang / link / XLSX "Trả hàng" (đối soát + báo cáo sau chốt) — PM 14/11 phát hành CMS bán hàng trước: CHỈ mở khi pipeline trả bật
 * (CMS_RETURNS_ENABLED cùng program + earnings). Cờ mode bật một mình KHÔNG mở thao tác / trang trả (trả hàng phát hành riêng).
 */
export function cmsReturnsPagesFromEnv(env: Env): boolean {
  return cmsCalcFlagsFromEnv(env).returns
}

/**
 * F-A sửa chương trình đang chạy có version (PM spec 17/11 §1, Q-235): mặc định OFF, chỉ đúng chuỗi 'true' mới bật; cần
 * CMS_PROGRAM_ENABLED. Cờ là rollout APP (ẩn entry + route từ chối 404) — KHÔNG thay quyền DB: RPC 131 tự kiểm super và không đọc
 * được env app, nên cờ OFF không có nghĩa DB cấm super gọi RPC (runbook ghi rõ giới hạn này).
 */
export function cmsProgramRevisionFromEnv(env: Env): boolean {
  return cmsFlagsFromEnv(env).program && env.CMS_PROGRAM_REVISION_ENABLED === 'true'
}

export function isCmsProgramRevisionEnabled(): boolean {
  return cmsProgramRevisionFromEnv(process.env)
}
