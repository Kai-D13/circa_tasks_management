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
 * CMS-UNIT (PM spec 09/11 §4): writer cơ sở tính `cms_unit` (chỉ đếm dòng bán đúng ĐV tính CMS). Mặc định OFF, chỉ đúng chuỗi
 * 'true' mới bật; chỉ có hiệu lực khi CMS_PROGRAM_ENABLED bật. Cờ KHÔNG tự chuyển cơ sở chương trình cũ. OFF + chương trình cms_unit ⇒
 * lượt tính HOLD UNIT_BASIS_DISABLED: run mở ra bị đóng `held` ngay sau snapshot (không stage / seal / công bố, pointer giữ nguyên,
 * không lùi về luật cũ — super thấy mã ở lịch sử lượt tính); reader vẫn đọc run theo cơ sở của chính run.
 */
export function cmsUnitBasisFromEnv(env: Env): boolean {
  return cmsFlagsFromEnv(env).program && env.CMS_UNIT_BASIS_ENABLED === 'true'
}

export function isCmsUnitBasisEnabled(): boolean {
  return cmsUnitBasisFromEnv(process.env)
}
