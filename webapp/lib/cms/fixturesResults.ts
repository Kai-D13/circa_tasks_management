// CMS P2-c (I3) — dữ liệu GIẢ cho fixture kết quả /ui-catalog/cms-v2 (dev-only, UI_CATALOG=1). CMS-UI-1 (PM 04/11 §6.1–6.3): số
// KHÔNG còn gõ tay — mọi dòng kết quả / gate danh mục / dòng lịch sử là đầu ra engine thật trên dòng bán giả của MỘT kịch bản
// (lib/cms/fixtureScenario), dựng qua parser DTO RPC 122 thật. A1 / A3 / D1 / D2 / D3 / chốt kỳ đọc cùng run của cùng chương trình.
// Kịch bản hiển thị: running (đang chạy — dược sĩ A) · top (bậc cao nhất / chạm trần — dược sĩ B) · held (lần cập nhật sau lỗi —
// giữ số cũ) · none (chưa có snapshot) · error · gone · config (danh mục đổi chờ tính lại). Kịch bản HỎNG có tên riêng
// (cmsFxCorruptResults — tiền lệch bậc, để kiểm "chưa đủ dữ liệu giải thích"), không nằm trong danh sách kịch bản hợp lệ.
import {
  CMS_FX_PG, CMS_FX_SM_STORES, CMS_FX_STORE_NAMES, CMS_FX_STORES, CMS_FX_USERS, cmsFxHeader, cmsFxLinesOf, cmsFxProgram,
  cmsFxProgramOfProduct, cmsFxRows, type CmsFxProgram, type CmsFxViewer,
} from './fixtureScenario'
import { CMS_FX_TODAY } from './fixtureScenario'
import type { CmsResultsLoad } from './resultUi'
import type { CmsResultLineDto, CmsResultRowDto } from './resultView'

export { CMS_FX_STORE_NAMES, CMS_FX_STORES, CMS_FX_USERS, CMS_FX_SM_STORES }
const PG1 = cmsFxProgram(CMS_FX_PG.PG1)!
export const CMS_FX_PROGRAM = PG1.row.id
export const CMS_FX_RUN = PG1.run!.id

// reset (CMS đơn giản S0 / mig 125–127): cấu hình đổi đã vô hiệu pointer — chưa có run hiện hành nhưng từng công bố ⇒ config_reset.
export type CmsFxResultScenario = 'running' | 'top' | 'held' | 'none' | 'error' | 'gone' | 'config' | 'reset'
export const CMS_FX_RESULT_SCENARIOS: CmsFxResultScenario[] = ['running', 'top', 'held', 'none', 'error', 'gone', 'config', 'reset']

/** Kết quả của một chương trình theo người xem + kịch bản hiển thị. Chương trình chưa bắt đầu / nháp ⇒ 'upcoming' / 'off'. */
export function cmsFxResultsOf(programId: string, s: CmsFxResultScenario, v: CmsFxViewer): CmsResultsLoad {
  const p = cmsFxProgram(programId)
  if (!p || p.row.status === 'draft') return { kind: 'off' }
  if (p.row.startDate > CMS_FX_TODAY) return { kind: 'upcoming' }
  if (s === 'error' || s === 'gone') return { kind: s }
  if (s === 'none' || !p.run) return { kind: 'loaded', header: cmsFxHeader({ ...p, run: null, out: null } as CmsFxProgram, v), rows: { runId: null, results: [], catalog: [], users: [] } }
  if (s === 'reset') return { kind: 'loaded', header: cmsFxHeader(p, v, { reset: true }), rows: { runId: null, results: [], catalog: [], users: [] } }
  return { kind: 'loaded', header: cmsFxHeader(p, v, { held: s === 'held', configChanged: s === 'config' }), rows: cmsFxRows(p, v) }
}

/** D1 / D2 staff (một dược sĩ): running = A (S1), top = B (bậc cao nhất / chạm trần). */
export function cmsFxStaffResults(s: CmsFxResultScenario, programId: string = PG1.row.id): CmsResultsLoad {
  return cmsFxResultsOf(programId, s, { kind: 'staff', userId: s === 'top' ? CMS_FX_USERS.B : CMS_FX_USERS.A })
}

/** QLCH (U19): staff HIỆN thuộc nhà thuốc 01. */
export function cmsFxStoreResults(s: CmsFxResultScenario, programId: string = PG1.row.id): CmsResultsLoad {
  return cmsFxResultsOf(programId, s, { kind: 'store_manager', storeId: CMS_FX_STORES.S1 })
}

/** A3 / A1: super (toàn bộ + nhóm Chưa gán trong totals) / SM (nhà thuốc 01 + 02). */
export function cmsFxAdminResults(s: CmsFxResultScenario, viewer: 'super' | 'sm' = 'super', programId: string = PG1.row.id): CmsResultsLoad {
  return cmsFxResultsOf(programId, s, viewer === 'super' ? { kind: 'super' } : { kind: 'sm' })
}

/** Kịch bản HỎNG (tên riêng): một dòng SP đầu lệch 1.000₫ so với bậc ⇒ phân bố / giải thích phải fail-closed. */
export function cmsFxCorruptResults(): CmsResultsLoad {
  const l = cmsFxAdminResults('running')
  if (l.kind !== 'loaded') return l
  const first = PG1.products[0].id
  let done = false
  const results = l.rows.results.map((r) => {
    if (done || r.programProductId !== first || !r.gateMet || BigInt(r.amountVnd) === BigInt(0)) return r
    done = true
    return { ...r, amountVnd: String(BigInt(r.amountVnd) + BigInt(1000)) }
  })
  return { ...l, rows: { ...l.rows, results } }
}

/**
 * Dòng lịch sử (engine) của các cặp dược sĩ × SP có trong `rows` (cùng run). seq = thứ tự trên toàn bộ ứng viên của run (như
 * cms_sales_lines — tăng dần, KHÔNG liên tục khi lọc theo người xem). Σ tiền dòng = Σ tiền kết quả của các cặp đó.
 */
export function cmsFxLines(rows: readonly CmsResultRowDto[]): CmsResultLineDto[] {
  if (rows.length === 0) return []
  const p = cmsFxProgramOfProduct(rows[0].programProductId)
  if (!p) return []
  return cmsFxLinesOf(p, new Set(rows.map((r) => `${r.userId}|${r.programProductId}`)))
}

export const cmsFxParseScenario = (v: string | undefined): CmsFxResultScenario | null =>
  (CMS_FX_RESULT_SCENARIOS as string[]).includes(v ?? '') ? (v as CmsFxResultScenario) : null
