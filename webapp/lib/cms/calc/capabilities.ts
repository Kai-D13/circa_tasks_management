// CMS-CALC-RET-2 — năng lực DB (migration 130 `rpc_cms_capabilities`). DB SUY từng "đường" từ catalog (RPC có mặt + EXECUTE đúng vai
// trò, hàm nội bộ, bảng / cột); app chỉ dùng một đường khi DB báo ok VÀ danh sách RPC DB khai = danh sách app biết ở đây, VÀ mọi version
// hợp đồng khớp hằng số app. Lệch / thiếu / lạ ⇒ đường đó tắt (fail-closed). DB trước 130 (PostgREST 404 / 42883) ⇒ người gọi coi như
// `null` = chỉ đường 121–126. Chỉ dùng phía server.

import { CMS_UNIT_KEY_VERSION } from '../unitKey'
import { CMS_SOURCE_PIN_VERSION } from './contractStage'
import { CMS_RETURN_FP_VERSION, CMS_RETURN_FP_VERSION_V2 } from './fp'
import { CMS_CALC_CONTRACT_VERSION, CMS_CALC_CONTRACT_VERSION_V2 } from './policy'
import { CMS_RETURN_STATUS_DICTIONARY_VERSION, CMS_RETURN_STATUS_DICTIONARY_VERSION_V2 } from './returns'
import { CMS_SRC_DIGEST_VERSION } from './srcDigest'

/** RPC app gọi trên từng đường (sắp tên). */
export const CMS_CAPABILITY_RPCS = {
  program_modes: ['rpc_cms_program_save_v2', 'rpc_cms_program_set_returns_policy'],
  contract_run: ['rpc_cms_sales_run_cleanup', 'rpc_cms_sales_run_finish', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_publish',
    'rpc_cms_sales_run_seal_begin', 'rpc_cms_sales_run_seal_step', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_snapshot'],
  readers_v2: ['rpc_cms_result_events_v2', 'rpc_cms_result_excluded_v2', 'rpc_cms_result_header_v2', 'rpc_cms_result_returns_v2',
    'rpc_cms_result_rows_v2'],
  returns_ledger: ['rpc_cms_return_conflicts', 'rpc_cms_return_conflicts_confirm_restored'],
  close_report: ['rpc_cms_frozen_sales_lines', 'rpc_cms_return_close_report', 'rpc_cms_return_close_report_events', 'rpc_cms_return_close_report_save',
    'rpc_cms_return_close_reports'],
  /**
   * Q-237 (132 r1): chốt run contract (preview / chốt / payout RÒNG đóng băng). DB 130 / 131 khai `{ok:false, rpcs:[]}` ⇒ RPC_LIST ⇒ tắt
   * (DB tự chặn CMS_LOCK_CONTRACT_UNSUPPORTED). App chỉ cho chốt run contract khi đường này bật.
   */
  lock_contract: ['rpc_cms_lock_preview', 'rpc_cms_payout', 'rpc_cms_program_lock'],
  /**
   * Q-236 (migration 132): profile full_line_qty_refund_v1 — đổi policy, open hợp đồng v2, báo cáo sau chốt profile. DB 130 / 131 không
   * có đường này ⇒ MISSING ⇒ tắt (app không chọn / không ghi full_line). Khoá version riêng CMS_CAPABILITY_VERSIONS_V2.
   */
  full_line: ['rpc_cms_program_set_returns_policy', 'rpc_cms_return_close_report_save', 'rpc_cms_sales_run_open'],
  /** 132 r1 (PM r0 P1-04): báo cáo ngày 31 bằng PHIÊN super (DB lấy actor = auth.uid()). Thiếu ⇒ không có đường lập tay. */
  manual_report: ['rpc_cms_return_close_report_save_super'],
  /**
   * 132 r2 (Q-238 b): chứng nhận nguồn có version cho chương trình tính nguyên (decision_unit14) — xuất lớp nguồn có thô q / u + RPC
   * chứng nhận nhận bộ v2. Thiếu ⇒ CLI chứng nhận không xuất / không ghi cho cms_unit (chốt thật cms_unit không có basis).
   */
  unit_attest: ['rpc_cms_run_source_export', 'rpc_cms_source_attest'],
} as const satisfies Record<string, readonly string[]>

export type CmsCapabilityPath = keyof typeof CMS_CAPABILITY_RPCS
export const CMS_CAPABILITY_PATHS = Object.keys(CMS_CAPABILITY_RPCS) as CmsCapabilityPath[]

/** Version hợp đồng app ↔ DB phải khớp TUYỆT ĐỐI (một version lệch ⇒ mọi đường tắt). */
export const CMS_CAPABILITY_VERSIONS = {
  calc_contract: CMS_CALC_CONTRACT_VERSION, status_dictionary: CMS_RETURN_STATUS_DICTIONARY_VERSION, fp: CMS_RETURN_FP_VERSION,
  source_pin: CMS_SOURCE_PIN_VERSION, src_digest: CMS_SRC_DIGEST_VERSION, unit_key: CMS_UNIT_KEY_VERSION,
} as const

/** Khoá version của các đường 132 (full_line / lock_contract / manual_report / unit_attest) — lệch ⇒ chỉ các đường đó tắt, 5 đường cũ giữ theo
 * CMS_CAPABILITY_VERSIONS. */
export const CMS_CAPABILITY_VERSIONS_V2 = {
  calc_contract_v2: CMS_CALC_CONTRACT_VERSION_V2, status_dictionary_v2: CMS_RETURN_STATUS_DICTIONARY_VERSION_V2, fp_v2: CMS_RETURN_FP_VERSION_V2,
  close_report_v2: 'cms-close-report-v2',
} as const

export interface CmsCapabilities {
  /** true ⇒ mọi version hợp đồng khớp. */
  versionsOk: boolean
  /** Đường dùng được (fail-closed). */
  paths: Record<CmsCapabilityPath, boolean>
  /** Lý do tắt từng đường (để log / màn chẩn đoán; không chứa dữ liệu). */
  off: Partial<Record<CmsCapabilityPath, 'VERSION' | 'DB_OFF' | 'RPC_LIST' | 'MISSING'>>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** Đường chỉ có từ 132 — cần thêm khoá version v2. */
const V2_PATHS: ReadonlySet<CmsCapabilityPath> = new Set(['full_line', 'lock_contract', 'manual_report', 'unit_attest'])

/** Phân tích kết quả `rpc_cms_capabilities()`. Không ném: dữ liệu lạ ⇒ mọi đường tắt. */
export function parseCmsCapabilities(raw: unknown): CmsCapabilities {
  const paths = Object.fromEntries(CMS_CAPABILITY_PATHS.map((p) => [p, false])) as Record<CmsCapabilityPath, boolean>
  const off: CmsCapabilities['off'] = {}
  const o = isObj(raw) ? raw : {}
  const versionsOk = Object.entries(CMS_CAPABILITY_VERSIONS).every(([k, v]) => o[k] === v)
  const versionsV2Ok = Object.entries(CMS_CAPABILITY_VERSIONS_V2).every(([k, v]) => o[k] === v)
  const dbPaths = isObj(o.paths) ? o.paths : {}
  for (const p of CMS_CAPABILITY_PATHS) {
    if (!versionsOk) { off[p] = 'VERSION'; continue }
    const d = dbPaths[p]
    if (V2_PATHS.has(p) && isObj(d) && !versionsV2Ok) { off[p] = 'VERSION'; continue }
    if (!isObj(d)) { off[p] = 'MISSING'; continue }
    const want: readonly string[] = CMS_CAPABILITY_RPCS[p]
    const got = Array.isArray(d.rpcs) && d.rpcs.every((x) => typeof x === 'string') ? [...(d.rpcs as string[])].sort() : null
    if (got === null || got.length !== want.length || got.some((x, i) => x !== want[i])) { off[p] = 'RPC_LIST'; continue }
    if (d.ok !== true) { off[p] = 'DB_OFF'; continue }
    paths[p] = true
  }
  return { versionsOk, paths, off }
}
