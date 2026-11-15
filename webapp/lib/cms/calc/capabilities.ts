// CMS-CALC-RET-2 — năng lực DB (migration 130 `rpc_cms_capabilities`). DB SUY từng "đường" từ catalog (RPC có mặt + EXECUTE đúng vai
// trò, hàm nội bộ, bảng / cột); app chỉ dùng một đường khi DB báo ok VÀ danh sách RPC DB khai = danh sách app biết ở đây, VÀ mọi version
// hợp đồng khớp hằng số app. Lệch / thiếu / lạ ⇒ đường đó tắt (fail-closed). DB trước 130 (PostgREST 404 / 42883) ⇒ người gọi coi như
// `null` = chỉ đường 121–126. Chỉ dùng phía server.

import { CMS_UNIT_KEY_VERSION } from '../unitKey'
import { CMS_SOURCE_PIN_VERSION } from './contractStage'
import { CMS_RETURN_FP_VERSION } from './fp'
import { CMS_CALC_CONTRACT_VERSION } from './policy'
import { CMS_RETURN_STATUS_DICTIONARY_VERSION } from './returns'
import { CMS_SRC_DIGEST_VERSION } from './srcDigest'

/** RPC app gọi trên từng đường (sắp tên). `lock_contract` = chốt run contract — KHÔNG có trong batch này (luôn tắt). */
export const CMS_CAPABILITY_RPCS = {
  program_modes: ['rpc_cms_program_save_v2', 'rpc_cms_program_set_returns_policy'],
  contract_run: ['rpc_cms_sales_run_cleanup', 'rpc_cms_sales_run_finish', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_publish',
    'rpc_cms_sales_run_seal_begin', 'rpc_cms_sales_run_seal_step', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_snapshot'],
  readers_v2: ['rpc_cms_result_events_v2', 'rpc_cms_result_excluded_v2', 'rpc_cms_result_header_v2', 'rpc_cms_result_returns_v2',
    'rpc_cms_result_rows_v2'],
  returns_ledger: ['rpc_cms_return_conflicts', 'rpc_cms_return_conflicts_confirm_restored'],
  close_report: ['rpc_cms_frozen_sales_lines', 'rpc_cms_return_close_report', 'rpc_cms_return_close_report_events', 'rpc_cms_return_close_report_save',
    'rpc_cms_return_close_reports'],
  lock_contract: [],
} as const satisfies Record<string, readonly string[]>

export type CmsCapabilityPath = keyof typeof CMS_CAPABILITY_RPCS
export const CMS_CAPABILITY_PATHS = Object.keys(CMS_CAPABILITY_RPCS) as CmsCapabilityPath[]

/** Version hợp đồng app ↔ DB phải khớp TUYỆT ĐỐI (một version lệch ⇒ mọi đường tắt). */
export const CMS_CAPABILITY_VERSIONS = {
  calc_contract: CMS_CALC_CONTRACT_VERSION, status_dictionary: CMS_RETURN_STATUS_DICTIONARY_VERSION, fp: CMS_RETURN_FP_VERSION,
  source_pin: CMS_SOURCE_PIN_VERSION, src_digest: CMS_SRC_DIGEST_VERSION, unit_key: CMS_UNIT_KEY_VERSION,
} as const

export interface CmsCapabilities {
  /** true ⇒ mọi version hợp đồng khớp. */
  versionsOk: boolean
  /** Đường dùng được (fail-closed). */
  paths: Record<CmsCapabilityPath, boolean>
  /** Lý do tắt từng đường (để log / màn chẩn đoán; không chứa dữ liệu). */
  off: Partial<Record<CmsCapabilityPath, 'VERSION' | 'DB_OFF' | 'RPC_LIST' | 'MISSING' | 'NOT_IN_BATCH'>>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Phân tích kết quả `rpc_cms_capabilities()`. Không ném: dữ liệu lạ ⇒ mọi đường tắt. */
export function parseCmsCapabilities(raw: unknown): CmsCapabilities {
  const paths = Object.fromEntries(CMS_CAPABILITY_PATHS.map((p) => [p, false])) as Record<CmsCapabilityPath, boolean>
  const off: CmsCapabilities['off'] = {}
  const o = isObj(raw) ? raw : {}
  const versionsOk = Object.entries(CMS_CAPABILITY_VERSIONS).every(([k, v]) => o[k] === v)
  const dbPaths = isObj(o.paths) ? o.paths : {}
  for (const p of CMS_CAPABILITY_PATHS) {
    if (p === 'lock_contract') { off[p] = 'NOT_IN_BATCH'; continue }
    if (!versionsOk) { off[p] = 'VERSION'; continue }
    const d = dbPaths[p]
    if (!isObj(d)) { off[p] = 'MISSING'; continue }
    const want: readonly string[] = CMS_CAPABILITY_RPCS[p]
    const got = Array.isArray(d.rpcs) && d.rpcs.every((x) => typeof x === 'string') ? [...(d.rpcs as string[])].sort() : null
    if (got === null || got.length !== want.length || got.some((x, i) => x !== want[i])) { off[p] = 'RPC_LIST'; continue }
    if (d.ok !== true) { off[p] = 'DB_OFF'; continue }
    paths[p] = true
  }
  return { versionsOk, paths, off }
}
