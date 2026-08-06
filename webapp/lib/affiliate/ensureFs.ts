// FS-expansion r1 (audit 06/08 P1#3) — CORE thuần (dependency-injected) cho
// luồng auto-create mapping FS của cron pull-affiliate-orders, tách khỏi route
// để test được bằng fake deps (route chỉ còn wiring supabaseAdmin + deadline
// guard). Contract (mig 102 + plan 05/08):
//   · Candidate = mã xuất hiện trong đơn hợp lệ nhưng CHƯA có mapping.
//   · Candidate qua CONTRACT isValidPartnerCode (space/Unicode OK — 'NT THIÊN';
//     control char/rỗng/>64 → invalid_new_codes: KHÔNG gửi vào RPC — mã đó tự
//     rơi unmatched ở resolver → health chặn READY (fail-visible), KHÔNG sập
//     cả run vì một mã hỏng.
//   · DRY-RUN: tuyệt đối không gọi ensure — chỉ báo would_create_fs.
//   · REAL: ensure (insert-if-absent trong DB, không đụng mapping hiện hữu kể
//     cả inactive/OS) → ĐỌC LẠI mappings từ DB rồi mới resolve (không merge
//     in-memory). ensure lỗi → throw nguyên vẹn: route fail run, KHÔNG upsert.
import { isValidPartnerCode, type PartnerMappingRow } from './normalize'

export interface EnsureFsDeps {
  /** Đọc toàn bộ affiliate_partner_mappings (route: supabaseAdmin). Throw khi lỗi. */
  loadMappings: () => Promise<PartnerMappingRow[]>
  /** rpc_ensure_fs_partner_mappings — trả danh sách mã THỰC SỰ tạo. Throw khi lỗi. */
  ensureFsMappings: (codes: string[]) => Promise<string[]>
}

export interface EnsureFsResult {
  /** Mappings dùng để resolve — real run có mã mới đã ĐỌC LẠI từ DB. */
  mappings: PartnerMappingRow[]
  /** Real run: mã RPC xác nhận vừa tạo (run kế phải rỗng — idempotent). */
  newFsCodes: string[]
  /** Dry-run: mã SẼ được tạo nếu chạy thật (không ghi gì). */
  wouldCreateFs: string[]
  /** Mã mới vi phạm contract partner_code — không gửi RPC, tự nằm unmatched. */
  invalidNewCodes: string[]
}

export async function resolveMappingsWithAutoCreate(
  validRows: { partner_code: string }[],
  isDry: boolean,
  deps: EnsureFsDeps,
): Promise<EnsureFsResult> {
  let mappings = await deps.loadMappings()
  const known = new Set(mappings.map((m) => m.partner_code))
  const candidates = [...new Set(validRows.map((r) => r.partner_code))].filter((c) => !known.has(c))
  const validCandidates = candidates.filter((c) => isValidPartnerCode(c))
  const invalidNewCodes = candidates.filter((c) => !isValidPartnerCode(c))

  if (isDry) {
    return { mappings, newFsCodes: [], wouldCreateFs: validCandidates, invalidNewCodes }
  }
  let newFsCodes: string[] = []
  if (validCandidates.length > 0) {
    newFsCodes = await deps.ensureFsMappings(validCandidates)
    mappings = await deps.loadMappings()
  }
  return { mappings, newFsCodes, wouldCreateFs: [], invalidNewCodes }
}
