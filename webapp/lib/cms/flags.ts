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

export function isCmsQaServer(): boolean {
  return cmsQaServerFromEnv(process.env)
}
