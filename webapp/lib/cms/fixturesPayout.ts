// CMS P3a — fixture CHỈ ĐỂ XEM bố cục khối "Chốt kỳ" / "Số đã chốt" (/ui-catalog/cms-v2/detail?p3=…). Dữ liệu giả dựng qua
// CHÍNH parser DTO (parseCmsLockPreview / parseCmsPayout) từ JSON có hình dạng như RPC 123 trả về ⇒ fixture lệch hợp đồng là
// ném lỗi ngay. CMS-UI-1: số chốt = tổng theo dược sĩ của kết quả ENGINE cùng run của CHÍNH chương trình đang xem (kịch bản
// lib/cms/fixtureScenario): Chốt kỳ ⇒ PG8 (QA đã hết kỳ; `pending` ⇒ PG4 — chương trình thật chờ chốt), Số đã chốt ⇒ PG9 (QA đã
// chốt). Dòng chưa gán của `ack` = totals engine của run; `ready` / `blocked` là biến thể trạng thái khối (giả định đã gán hết /
// vượt ngưỡng + run đổi) — ghi rõ, không trình bày như số của run. Không IO; không dùng ở route thật.

import { CMS_FX_PG, CMS_FX_STORE_NAMES, cmsFxProgram } from './fixtureScenario'
import { cmsFxAdminResults } from './fixturesResults'
import { formatCmsDecimal } from './decimal'
import { parseCmsLockPreview, parseCmsPayout, type CmsLockPreviewDto, type CmsPayoutDto } from './payoutView'

export type CmsFxLockScenario = 'ready' | 'ack' | 'blocked' | 'pending' | 'error' | 'qa-readonly'
export type CmsFxPayoutScenario = 'locked' | 'locked-sm' | 'locked-error'
export const CMS_FX_LOCK_SCENARIOS: readonly CmsFxLockScenario[] = ['ready', 'ack', 'blocked', 'pending', 'error', 'qa-readonly']
export const CMS_FX_PAYOUT_SCENARIOS: readonly CmsFxPayoutScenario[] = ['locked', 'locked-sm', 'locked-error']

export function cmsFxParseP3(raw: string | undefined): CmsFxLockScenario | CmsFxPayoutScenario | null {
  return [...CMS_FX_LOCK_SCENARIOS, ...CMS_FX_PAYOUT_SCENARIOS].find((s) => s === raw) ?? null
}
export const cmsFxIsPayoutScenario = (s: string): s is CmsFxPayoutScenario => (CMS_FX_PAYOUT_SCENARIOS as readonly string[]).includes(s)

/** Chương trình của từng kịch bản P3a (đều có trong danh sách A1). */
export function cmsFxP3Program(s: CmsFxLockScenario | CmsFxPayoutScenario): string {
  return cmsFxIsPayoutScenario(s) ? CMS_FX_PG.PG9 : s === 'pending' ? CMS_FX_PG.PG4 : CMS_FX_PG.PG8
}

const QA_POLICY = { label: 'QA_ONLY_ASSUMPTION', ready: true, pending: [], unassigned_max_gmv_bp: 200, unassigned_max_lines: 20, wait_hours: 0, completeness: 'qa_assumption' }
/** Chương trình thật ĐÃ chốt (PG5 — run đóng băng): quy tắc thật đã có tại thời điểm chốt (không nhãn QA). */
const LOCKED_POLICY = { label: null, ready: true, pending: [], unassigned_max_gmv_bp: 200, unassigned_max_lines: 20, wait_hours: 48, completeness: 'source_complete' }
const REAL_POLICY = { label: null, ready: false, pending: ['Q-206', 'Q-213', 'Q-216', 'SOURCE_COMPLETENESS', 'CMS-Q7'], unassigned_max_gmv_bp: null, unassigned_max_lines: null, wait_hours: null, completeness: null }

function perUser(programId: string, viewer: 'super' | 'sm') {
  const r = cmsFxAdminResults('running', viewer, programId)
  if (r.kind !== 'loaded') throw new Error('fx results')
  const by = new Map<string, { storeId: string; amount: bigint; np: number }>()
  for (const x of r.rows.results) {
    const cur = by.get(x.userId) ?? { storeId: x.storeId, amount: BigInt(0), np: 0 }
    cur.amount += BigInt(x.amountVnd)
    if (BigInt(x.amountVnd) > BigInt(0)) cur.np += 1
    by.set(x.userId, cur)
  }
  return [...by.entries()].map(([userId, v]) => ({ userId, ...v, name: r.rows.users.find((u) => u.id === userId)?.fullName ?? null }))
    .sort((a, b) => (a.amount === b.amount ? a.userId.localeCompare(b.userId) : a.amount > b.amount ? -1 : 1))
}
function engineTotals(programId: string) {
  const t = cmsFxProgram(programId)?.out?.totals
  if (!t) throw new Error('fx totals')
  return { candidateLines: t.candidates, candidateGmv: formatCmsDecimal(t.candidateGmvUnits), unassignedLines: t.unassigned, unassignedGmv: formatCmsDecimal(t.unassignedGmvUnits) }
}

/** Preview chốt: ready (0 blocker) · ack (dòng chưa gán của run — cần lý do) · blocked (vượt ngưỡng + run đổi) · pending (chương trình thật: policy chưa chốt). */
export function cmsFxLockPreview(s: CmsFxLockScenario, programId: string = cmsFxP3Program(s), endDate?: string): CmsLockPreviewDto | null {
  if (s === 'error') return null
  const p = cmsFxProgram(programId)
  if (!p?.run) throw new Error('fx program')
  const users = perUser(programId, 'super')
  const amount = users.reduce((a, u) => a + u.amount, BigInt(0))
  const t = engineTotals(programId)
  const unassigned = s === 'ack' ? t.unassignedLines : s === 'blocked' ? Math.max(26, t.unassignedLines * 3) : 0
  const unassignedGmv = s === 'ack' ? t.unassignedGmv : s === 'blocked' ? '18400000' : '0'
  return parseCmsLockPreview({
    program_id: programId, found: true, status: 'active', is_test: p.row.isTest, end_date: endDate ?? p.row.endDate, config_version: p.row.configVersion,
    run_id: p.run.id, run_started_at: '2026-11-15T02:05:00.000000Z', amount_vnd: amount.toString(), results_amount_vnd: amount.toString(),
    staff_rows: users.length, staff_paid: users.filter((u) => u.amount > BigInt(0)).length,
    candidate_lines: t.candidateLines, candidate_gmv: t.candidateGmv, unassigned_lines: unassigned, unassigned_gmv: unassignedGmv,
    unassigned_over: s === 'blocked', needs_ack: s === 'ack' || s === 'blocked',
    policy: p.row.isTest ? QA_POLICY : REAL_POLICY, policy_version: 1,
    mapping_fp_run: 'a'.repeat(32), mapping_fp_now: 'a'.repeat(32),
    source_complete_basis: p.row.isTest ? 'qa_assumption' : null, earliest_lock_at: '2026-11-15T00:00:00.000000Z',
    blockers: s === 'blocked' ? ['CMS_LOCK_RUN_CHANGED', 'CMS_LOCK_UNASSIGNED_OVER'] : p.row.isTest ? [] : ['CMS_LOCK_POLICY_PENDING'],
  })
}

/** Số đã chốt theo vai: super (mọi dược sĩ + email + tổng toàn chương trình) · SM (dược sĩ thuộc phạm vi, tổng trong phạm vi). */
export function cmsFxPayout(s: CmsFxPayoutScenario, programId: string = cmsFxP3Program(s)): CmsPayoutDto | null {
  if (s === 'locked-error') return null
  const p = cmsFxProgram(programId)
  if (!p?.run) throw new Error('fx program')
  const viewer = s === 'locked-sm' ? 'sm' : 'super'
  const users = perUser(programId, viewer)
  const all = perUser(programId, 'super')
  const scope = users.reduce((a, u) => a + u.amount, BigInt(0))
  const total = all.reduce((a, u) => a + u.amount, BigInt(0))
  const isSuper = viewer === 'super'
  const t = engineTotals(programId)
  return parseCmsPayout({
    program_id: programId, run_id: p.run.id, is_test: p.row.isTest, locked_at: '2026-11-03T03:20:00.000000Z', policy_version: 1, viewer,
    ...(isSuper ? { program_total: total.toString() } : {}), scope_total: scope.toString(),
    rows: users.map((u, i) => ({
      user_id: u.userId, store_id: u.storeId, name: u.name, store_name: CMS_FX_STORE_NAMES.get(u.storeId) ?? null,
      amount_vnd: u.amount.toString(), products_with_cms: u.np, ...(isSuper ? { email: `duoc.si.mau.${i + 1}@example.invalid` } : {}),
    })),
    // Khoá chỉ-super nằm ở cấp gốc như rpc_cms_payout trả về.
    ...(isSuper ? {
      locked_by: '00000000-0000-4000-8000-000000000001', staff_rows: all.length, staff_paid: all.filter((u) => u.amount > BigInt(0)).length,
      candidate_lines: t.candidateLines, candidate_gmv: t.candidateGmv, unassigned_lines: t.unassignedLines, unassigned_gmv: t.unassignedGmv,
      ack_reason: `Đã soát ${t.unassignedLines} dòng chưa gán: tài khoản dùng chung, email không khớp, thiếu email, nhà thuốc FS${p.row.isTest ? ' — QA' : ''}`, policy: p.row.isTest ? QA_POLICY : LOCKED_POLICY,
      source_complete_basis: p.row.isTest ? 'qa_assumption' : 'source_complete', source_complete_through: null, run_started_at: '2026-11-02T02:05:00.000000Z',
    } : {}),
  })
}
