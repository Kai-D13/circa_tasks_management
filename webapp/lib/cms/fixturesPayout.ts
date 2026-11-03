// CMS P3a — fixture CHỈ ĐỂ XEM bố cục khối "Chốt kỳ" / "Số đã chốt" (/ui-catalog/cms-v2/detail?p3=…). Dữ liệu giả dựng qua
// CHÍNH parser DTO (parseCmsLockPreview / parseCmsPayout) từ JSON có hình dạng như RPC 123 trả về ⇒ fixture lệch hợp đồng là
// ném lỗi ngay. Số chốt = tổng theo dược sĩ của kết quả giả cùng run (cmsFxAdminResults) ⇒ khớp A3 trên cùng trang.
// Không IO; không dùng ở route thật.

import { CMS_FX_RUN, CMS_FX_STORE_NAMES, cmsFxAdminResults } from './fixturesResults'
import { parseCmsLockPreview, parseCmsPayout, type CmsLockPreviewDto, type CmsPayoutDto } from './payoutView'

export type CmsFxLockScenario = 'ready' | 'ack' | 'blocked' | 'pending' | 'error' | 'qa-readonly'
export type CmsFxPayoutScenario = 'locked' | 'locked-sm' | 'locked-error'
export const CMS_FX_LOCK_SCENARIOS: readonly CmsFxLockScenario[] = ['ready', 'ack', 'blocked', 'pending', 'error', 'qa-readonly']
export const CMS_FX_PAYOUT_SCENARIOS: readonly CmsFxPayoutScenario[] = ['locked', 'locked-sm', 'locked-error']

export function cmsFxParseP3(raw: string | undefined): CmsFxLockScenario | CmsFxPayoutScenario | null {
  return [...CMS_FX_LOCK_SCENARIOS, ...CMS_FX_PAYOUT_SCENARIOS].find((s) => s === raw) ?? null
}
export const cmsFxIsPayoutScenario = (s: string): s is CmsFxPayoutScenario => (CMS_FX_PAYOUT_SCENARIOS as readonly string[]).includes(s)

const QA_POLICY = { label: 'QA_ONLY_ASSUMPTION', ready: true, pending: [], unassigned_max_gmv_bp: 200, unassigned_max_lines: 20, wait_hours: 0, completeness: 'qa_assumption' }
const REAL_POLICY = { label: null, ready: false, pending: ['Q-206', 'Q-213', 'Q-216', 'SOURCE_COMPLETENESS', 'CMS-Q7'], unassigned_max_gmv_bp: null, unassigned_max_lines: null, wait_hours: null, completeness: null }

function perUser(viewer: 'super' | 'sm') {
  const r = cmsFxAdminResults('running', viewer)
  if (r.kind !== 'loaded') throw new Error('fx results')
  const by = new Map<string, { storeId: string; amount: bigint; np: number }>()
  for (const x of r.rows.results) {
    const cur = by.get(x.userId) ?? { storeId: x.storeId, amount: BigInt(0), np: 0 }
    cur.amount += BigInt(x.amountVnd)
    if (BigInt(x.amountVnd) > BigInt(0)) cur.np += 1
    by.set(x.userId, cur)
  }
  return [...by.entries()].map(([userId, v]) => ({ userId, ...v, name: r.rows.users.find((u) => u.id === userId)?.fullName ?? null }))
}

/** Preview chốt: ready (0 blocker) · ack (còn dòng chưa gán dưới ngưỡng — cần lý do) · blocked (vượt ngưỡng + run đổi) · pending (chương trình thật: policy chưa chốt). */
export function cmsFxLockPreview(s: CmsFxLockScenario, programId: string, endDate: string): CmsLockPreviewDto | null {
  if (s === 'error') return null
  const users = perUser('super')
  const amount = users.reduce((a, u) => a + u.amount, BigInt(0))
  const unassigned = s === 'ready' || s === 'pending' || s === 'qa-readonly' ? 0 : s === 'ack' ? 7 : 26
  return parseCmsLockPreview({
    program_id: programId, found: true, status: 'active', is_test: s !== 'pending', end_date: endDate, config_version: 3,
    run_id: CMS_FX_RUN, run_started_at: '2026-11-15T02:10:00.000000Z', amount_vnd: amount.toString(), results_amount_vnd: amount.toString(),
    staff_rows: users.length, staff_paid: users.filter((u) => u.amount > BigInt(0)).length,
    candidate_lines: 1840, candidate_gmv: '412500000', unassigned_lines: unassigned,
    unassigned_gmv: unassigned === 0 ? '0' : unassigned === 7 ? '1350000' : '18400000',
    unassigned_over: s === 'blocked', needs_ack: s === 'ack' || s === 'blocked',
    policy: s === 'pending' ? REAL_POLICY : QA_POLICY, policy_version: 1,
    mapping_fp_run: 'a'.repeat(32), mapping_fp_now: 'a'.repeat(32),
    source_complete_basis: s === 'pending' ? null : 'qa_assumption', earliest_lock_at: '2026-11-15T00:00:00.000000Z',
    blockers: s === 'blocked' ? ['CMS_LOCK_RUN_CHANGED', 'CMS_LOCK_UNASSIGNED_OVER'] : s === 'pending' ? ['CMS_LOCK_POLICY_PENDING'] : [],
  })
}

/** Số đã chốt theo vai: super (mọi dược sĩ + email + tổng toàn chương trình) · SM (dược sĩ thuộc phạm vi, tổng trong phạm vi). */
export function cmsFxPayout(s: CmsFxPayoutScenario, programId: string): CmsPayoutDto | null {
  if (s === 'locked-error') return null
  const viewer = s === 'locked-sm' ? 'sm' : 'super'
  const users = perUser(viewer)
  const all = perUser('super')
  const scope = users.reduce((a, u) => a + u.amount, BigInt(0))
  const total = all.reduce((a, u) => a + u.amount, BigInt(0))
  const isSuper = viewer === 'super'
  return parseCmsPayout({
    program_id: programId, run_id: CMS_FX_RUN, is_test: true, locked_at: '2026-11-15T03:20:00.000000Z', policy_version: 1, viewer,
    ...(isSuper ? { program_total: total.toString() } : {}), scope_total: scope.toString(),
    rows: users.map((u, i) => ({
      user_id: u.userId, store_id: u.storeId, name: u.name, store_name: CMS_FX_STORE_NAMES.get(u.storeId) ?? null,
      amount_vnd: u.amount.toString(), products_with_cms: u.np, ...(isSuper ? { email: `duoc.si.mau.${i + 1}@example.invalid` } : {}),
    })),
    // Khoá chỉ-super nằm ở cấp gốc như rpc_cms_payout trả về.
    ...(isSuper ? {
      locked_by: '00000000-0000-4000-8000-000000000001', staff_rows: all.length, staff_paid: all.filter((u) => u.amount > BigInt(0)).length,
      candidate_lines: 1840, candidate_gmv: '412500000', unassigned_lines: 7, unassigned_gmv: '1350000',
      ack_reason: 'Đã soát 7 dòng chưa gán: tài khoản dùng chung và email không khớp — QA', policy: QA_POLICY,
      source_complete_basis: 'qa_assumption', source_complete_through: null, run_started_at: '2026-11-15T02:10:00.000000Z',
    } : {}),
  })
}
