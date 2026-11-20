import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import {
  CMS_LOCK_CODE_LABEL, CmsPayoutDtoError, cmsAttestStateLabel, cmsKnownContractVersion, cmsLockExpectedAttestation, cmsLockReady, parseCmsLockPreview,
  parseCmsPayout,
} from '../lib/cms/payoutView'
import { runCmsLock, runCmsLockPreview, type CmsLockDeps } from '../lib/cms/lockAction'
import { buildCmsPayoutWorkbook } from '../lib/cms/exportPayouts'
import { buildCmsCloseReportWorkbook } from '../lib/cms/exportCloseReport'
import {
  CMS_CLOSE_REPORT_CONTRACT_NOTE, CmsReturnsDtoError, cmsCloseReportIsContract, cmsCloseReportViaLabel, parseCmsCloseReportPage, parseCmsCloseReports,
} from '../lib/cms/returnsView'
import { CMS_MANUAL_REPORT_CODE_LABEL, cmsAfterCloseRpcCode, runCmsReturnsAfterCloseProgram, type CmsAfterCloseDeps } from '../lib/cms/returnsAfterClose'
import { createCmsContractFixtureProvider } from './cmsContractFixture'
import {
  CMS_FX_CONTRACT_PROGRAMS, CMS_FX_CONTRACT_REPORT_ID, CMS_FX_FULL_LINE_PROGRAMS, CMS_FX_PG_FULL_LINE, CMS_FX_STAFF_FULL_LINE, cmsFxContract,
  cmsFxContractCloseReport, cmsFxContractCloseReports, cmsFxContractLines, cmsFxContractPayout, cmsFxContractResultsOf, cmsFxReturnConflicts,
} from '../lib/cms/fixturesContract'

// 132 r1 (Q-237 — PM 18/11 audit r0 §3.1–§3.3, P1-01…P1-04) — phần THUẦN của chốt run contract / báo cáo sau chốt / đường ngày 31:
//   · DTO preview + payout có khối hợp đồng (số chi = RÒNG đã seal) + tổng trả super; legacy / DB trước 132 ⇒ null;
//   · app thiếu đường chốt contract (capability lock_contract) ⇒ preview có blocker, chốt bị từ chối TRƯỚC RPC chốt;
//   · lập tay cần capability manual_report; reader báo cáo có người lập / lý do / phần trả đã trừ lúc chốt;
//   · fixture full_line (PG17 / PG18) dựng qua parser thật; báo cáo run contract: phiếu đã trừ trước chốt không trừ kép;
//   · XLSX: payout contract ghi chính sách / mốc / tổng trả; báo cáo contract có cột đã trừ lúc chốt + lý do; legacy giữ cột cũ.
// DB (seal / lock / report / race / rollback): scripts/qa-cms-132.mjs §8b / §8c / §9 / §12b.

const P = '00000000-0000-4000-8000-0000000000aa', R = '00000000-0000-4000-8000-0000000000bb'
const A = '00000000-0000-4000-8000-0000000000a1', ACTOR = '00000000-0000-4000-8000-000000000001'
const TS = '2026-11-15T00:30:00.000000Z'
const FULL = 'full_line_qty_refund_v1' as const
const CT_FULL = { legacy: false, calc_contract_version: 'cms-calc-ret2-v2', quantity_basis: 'pos_base', quantity_policy_version: 'x', returns_policy: FULL,
  unit_key_version: 'u', status_dictionary_version: 'cms-return-status-v2', returns_as_of: TS }
const previewRaw = (o: Record<string, unknown> = {}) => ({
  program_id: P, found: true, status: 'active', is_test: true, end_date: '2026-11-01', config_version: 3,
  run_id: R, run_started_at: TS, amount_vnd: '3000', results_amount_vnd: '3000', staff_rows: 1, staff_paid: 1,
  candidate_lines: 2, candidate_gmv: '160000', unassigned_lines: 0, unassigned_gmv: '0', unassigned_over: false, needs_ack: false,
  policy: { label: 'QA_ONLY_ASSUMPTION' }, policy_version: 1, mapping_fp_run: 'a'.repeat(32), mapping_fp_now: 'a'.repeat(32),
  source_complete_basis: 'qa_assumption', source_complete_through: null, earliest_lock_at: TS, blockers: [], ...o,
})
const payoutRaw = (viewer: 'super' | 'sm', o: Record<string, unknown> = {}) => ({
  program_id: P, run_id: R, is_test: true, locked_at: TS, policy_version: 1, viewer, ...(viewer === 'super' ? { program_total: '3000' } : {}), scope_total: '3000',
  rows: [{ user_id: A, store_id: A, name: 'Dược sĩ A', store_name: null, amount_vnd: '3000', products_with_cms: 1, ...(viewer === 'super' ? { email: 'a@example.invalid' } : {}) }],
  contract: { calc_contract_version: 'cms-calc-ret2-v2', quantity_basis: 'pos_base', returns_policy: FULL, returns_as_of: TS },
  ...(viewer === 'super' ? {
    locked_by: ACTOR, staff_rows: 1, staff_paid: 1, candidate_lines: 2, candidate_gmv: '160000', unassigned_lines: 0, unassigned_gmv: '0', ack_reason: null,
    policy: { label: 'QA_ONLY_ASSUMPTION' }, source_complete_basis: 'qa_assumption', source_complete_through: null, run_started_at: TS,
    returns: { return_count: 1, return_gmv: '30000', eligible_return_base: '10' },
  } : {}),
  ...o,
})

test.describe('Q-237 r1 · DTO chốt run contract @desktop', () => {
  test('preview: khối hợp đồng run contract; legacy / DB trước 132 ⇒ null; version lạ giữ nguyên để app tự chặn; sai dạng ⇒ lỗi', () => {
    const p = parseCmsLockPreview(previewRaw({ contract: CT_FULL }))
    expect(p.contract).toEqual({ calcContractVersion: 'cms-calc-ret2-v2', quantityBasis: 'pos_base', returnsPolicy: FULL, returnsAsOf: TS })
    expect(parseCmsLockPreview(previewRaw({ contract: null })).contract).toBeNull()
    expect(parseCmsLockPreview(previewRaw()).contract).toBeNull()
    expect(parseCmsLockPreview(previewRaw({ contract: { legacy: true, calc_contract_version: null, quantity_basis: 'pos_base', returns_policy: 'sales_only_v1' } })).contract).toBeNull()
    expect(parseCmsLockPreview(previewRaw({ contract: { ...CT_FULL, calc_contract_version: 'cms-calc-ret2-v9' } })).contract?.calcContractVersion).toBe('cms-calc-ret2-v9')
    expect([cmsKnownContractVersion('cms-calc-ret2-v1'), cmsKnownContractVersion('cms-calc-ret2-v2'), cmsKnownContractVersion('cms-calc-ret2-v9')]).toEqual([true, true, false])
    for (const bad of [{ ...CT_FULL, returns_as_of: null }, { ...CT_FULL, quantity_basis: 'x' }, { ...CT_FULL, returns_policy: 'x' }, 'x']) {
      expect(() => parseCmsLockPreview(previewRaw({ contract: bad })), JSON.stringify(bad)).toThrow(CmsPayoutDtoError)
    }
    for (const k of ['CMS_LOCK_RETURNS_TOO_EARLY', 'CMS_LOCK_LEDGER_DRIFT', 'CMS_LOCK_APP_CONTRACT_UNSUPPORTED', 'CMS_LOCK_CONTRACT_UNSUPPORTED']) expect(CMS_LOCK_CODE_LABEL[k], k).toBeTruthy()
    expect(CMS_LOCK_CODE_LABEL.CMS_LOCK_CONTRACT_UNSUPPORTED).not.toMatch(/chưa hỗ trợ chốt trong đợt này/)
  })

  // r2 (PM 19/11 RET-R2-01 · Q-238 b): thay ca r1 BASIS_UNSUPPORTED — cms_unit dùng bộ decision_unit14; bộ lệch cách tính ⇒ FIELD_SET_BASIS.
  test('r2: chương trình thật cms_unit — chứng nhận decision_unit14 hợp lệ ⇒ gửi id; bộ lệch cách tính / thô q-u lệch ⇒ invalid, không gửi id; nhãn rõ', () => {
    const real = { is_test: false, contract: { ...CT_FULL, quantity_basis: 'cms_unit' }, policy: { label: 'REAL', completeness: 'operator_reconciliation' } }
    const okAtt = { id: A, scope_to: '2026-11-01', field_set: 'decision_unit14', attested_at: TS, as_of: TS, code: null }
    const pv = parseCmsLockPreview(previewRaw({ ...real, source_attestation: okAtt, source_complete_basis: 'operator_reconciliation' }))
    expect(pv.sourceAttestation).toMatchObject({ state: 'valid', id: A })
    expect(cmsLockExpectedAttestation(pv)).toBe(A)
    for (const code of ['FIELD_SET_BASIS', 'UNIT_SRC_ENGINE', 'UNIT_CLASS', 'UNIT_CLASS_HOLD', 'UNIT_SRC_V', 'UNIT_SRC_CLEAN', 'UNIT_CONTRACT']) {
      const p = parseCmsLockPreview(previewRaw({ ...real, source_attestation: { ...okAtt, field_set: 'decision10', code }, source_complete_basis: null,
        blockers: ['CMS_LOCK_ATTEST_INVALID'] }))
      expect(p.sourceAttestation, code).toEqual({ state: 'invalid', id: A, code })
      expect([cmsLockExpectedAttestation(p), cmsLockReady(p)], code).toEqual([null, false])
      expect(cmsAttestStateLabel(code), code).not.toMatch(/^chứng nhận không dùng được \(/)
    }
    expect(cmsAttestStateLabel('FIELD_SET_BASIS')).toMatch(/decision_unit14/)
    expect(cmsAttestStateLabel('CONTRACT_UNSUPPORTED')).not.toMatch(/^chứng nhận không dùng được \(/)
  })

  test('payout: hợp đồng (mọi vai) + tổng trả đã trừ (chỉ super); lệch hợp đồng ↔ tổng trả ⇒ lỗi; legacy ⇒ null', () => {
    const s = parseCmsPayout(payoutRaw('super'))
    expect([s.contract?.returnsPolicy, s.contract?.returnsAsOf, s.super?.returns]).toEqual([FULL, TS, { returnCount: 1, returnGmv: '30000', eligibleReturnBase: '10' }])
    const m = parseCmsPayout(payoutRaw('sm'))
    expect([m.contract?.returnsPolicy, m.super]).toEqual([FULL, null])
    // Run đọc trả mà super không có tổng trả (hoặc ngược lại) ⇒ DTO lỗi (không hiện số ròng thiếu bằng chứng).
    expect(() => parseCmsPayout(payoutRaw('super', { returns: null }))).toThrow(/returns≠contract/)
    expect(() => parseCmsPayout(payoutRaw('super', { contract: null }))).toThrow(/returns≠contract/)
    // Legacy (DB 132 trả contract null, không returns) / DB trước 132 (không khoá) ⇒ null.
    const legacy = parseCmsPayout(payoutRaw('super', { contract: null, returns: null }))
    expect([legacy.contract, legacy.super?.returns]).toEqual([null, null])
    const old = payoutRaw('super')
    delete (old as Record<string, unknown>).contract
    delete (old as Record<string, unknown>).returns
    expect(parseCmsPayout(old).contract).toBeNull()
    // Sales-only contract: hợp đồng có, không mốc trả, không tổng trả.
    const so = parseCmsPayout(payoutRaw('super', { contract: { calc_contract_version: 'cms-calc-ret2-v1', quantity_basis: 'cms_unit', returns_policy: 'sales_only_v1', returns_as_of: null }, returns: null }))
    expect([so.contract?.returnsPolicy, so.super?.returns]).toEqual(['sales_only_v1', null])
  })
})

type Call = { fn: string; args: Record<string, unknown> }
function lockDeps(o: { contract?: unknown; capOk?: boolean | 'throw' | undefined } = {}) {
  const calls: Call[] = []
  const d: CmsLockDeps = {
    lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: ACTOR, qa: true }), program: async () => ({ isTest: true }),
    rpc: async (fn, args) => {
      calls.push({ fn, args })
      return { data: fn === 'rpc_cms_lock_preview' ? previewRaw({ contract: o.contract ?? null })
        : { locked: true, already: false, program_id: P, run_id: R, amount_vnd: '3000', policy_version: 1 }, error: null }
    },
    ...(o.capOk === undefined ? {} : { contractLockOk: async () => { if (o.capOk === 'throw') throw new Error('x'); return o.capOk as boolean } }),
  }
  return { d, calls }
}
const LOCK = { programId: P, expectedRunId: R, expectedPolicyVersion: 1, ackReason: null }

test.describe('Q-237 r1 · action chốt run contract @desktop', () => {
  test('preview: run contract + app thiếu lock_contract (hoặc lỗi đọc capability / version lạ) ⇒ blocker APP_CONTRACT_UNSUPPORTED; run legacy không đổi', async () => {
    const ok = await runCmsLockPreview(lockDeps({ contract: CT_FULL, capOk: true }).d, P)
    expect(ok.ok && [ok.preview.blockers, cmsLockReady(ok.preview)]).toEqual([[], true])
    for (const capOk of [false, 'throw'] as const) {
      const r = await runCmsLockPreview(lockDeps({ contract: CT_FULL, capOk }).d, P)
      expect(r.ok && r.preview.blockers, String(capOk)).toEqual(['CMS_LOCK_APP_CONTRACT_UNSUPPORTED'])
    }
    const v9 = await runCmsLockPreview(lockDeps({ contract: { ...CT_FULL, calc_contract_version: 'cms-calc-ret2-v9' }, capOk: true }).d, P)
    expect(v9.ok && v9.preview.blockers).toEqual(['CMS_LOCK_APP_CONTRACT_UNSUPPORTED'])
    const legacy = await runCmsLockPreview(lockDeps({ contract: null, capOk: false }).d, P)
    expect(legacy.ok && legacy.preview.blockers).toEqual([])
  })

  test('chốt: capability đủ ⇒ KHÔNG đọc thêm preview; thiếu + run contract ⇒ từ chối TRƯỚC RPC chốt; thiếu + run legacy ⇒ chốt được', async () => {
    const a = lockDeps({ contract: CT_FULL, capOk: true })
    expect((await runCmsLock(a.d, LOCK)).ok).toBe(true)
    expect(a.calls.map((c) => c.fn)).toEqual(['rpc_cms_program_lock'])
    const b = lockDeps({ contract: CT_FULL, capOk: false })
    expect(await runCmsLock(b.d, LOCK)).toEqual({ ok: false, code: 'CMS_LOCK_APP_CONTRACT_UNSUPPORTED' })
    expect(b.calls.map((c) => c.fn)).toEqual(['rpc_cms_lock_preview'])
    const c = lockDeps({ contract: null, capOk: false })
    expect((await runCmsLock(c.d, LOCK)).ok).toBe(true)
    expect(c.calls.map((x) => x.fn)).toEqual(['rpc_cms_lock_preview', 'rpc_cms_program_lock'])
    // Deps không khai capability (harness DB / app cũ) ⇒ như trước: DB tự chặn.
    const d = lockDeps({ contract: CT_FULL })
    expect((await runCmsLock(d.d, LOCK)).ok).toBe(true)
    expect(d.calls.map((x) => x.fn)).toEqual(['rpc_cms_program_lock'])
  })

  test('lập tay cần capability manual_report: capsOk nhận cờ manual; thiếu ⇒ held CAPS_UNAVAILABLE trước khi đọc nguồn', async () => {
    const seen: Array<[string, boolean | undefined]> = []
    const read: string[] = []
    const deps: CmsAfterCloseDeps = {
      capsOk: async (profile, manual) => { seen.push([profile, manual]); return !manual },
      listPrograms: async () => [],
      payoutRun: async () => ({ ok: true, runId: R, legacy: false, runPolicy: FULL, reportProfile: null }),
      provider: { kind: 'fixture', read: async () => { read.push('read'); throw new Error('không được đọc') } } as unknown as CmsAfterCloseDeps['provider'],
      save: async () => ({ ok: true, data: {} }),
      nowMicros: () => BigInt(Date.now()) * BigInt(1000),
      remainingMs: () => 200_000,
    }
    const prog = { id: P, startDate: '2026-11-01', endDate: '2026-11-30', isTest: true, productIds: ['948001'] }
    const r = await runCmsReturnsAfterCloseProgram(deps, prog, { expectedPayoutRunId: R, reason: 'Phiếu hoàn tất sau ngày 30', request: ACTOR, profile: null })
    expect([r.status, r.code, read.length]).toEqual(['held', 'CAPS_UNAVAILABLE', 0])
    expect(seen).toEqual([[FULL, true]])
  })

  test('P1-2: statement_timeout (57014, vai PostgREST 8 s) ⇒ CMS_STATEMENT_TIMEOUT, held (0 ghi), nhãn lập tay rõ; 55P03 giữ CMS_LOCK_TIMEOUT', async () => {
    expect(cmsAfterCloseRpcCode({ message: 'canceling statement due to statement timeout', code: '57014' }, 'SAVE_FAILED')).toBe('CMS_STATEMENT_TIMEOUT')
    expect(cmsAfterCloseRpcCode({ message: 'canceling statement due to lock timeout', code: '55P03' }, 'SAVE_FAILED')).toBe('CMS_LOCK_TIMEOUT')
    expect(CMS_MANUAL_REPORT_CODE_LABEL.CMS_STATEMENT_TIMEOUT).toMatch(/không ghi gì/)
    const deps: CmsAfterCloseDeps = {
      capsOk: async () => true,
      listPrograms: async () => [],
      payoutRun: async () => ({ ok: true, runId: R, legacy: false, runPolicy: FULL, reportProfile: null }),
      provider: createCmsContractFixtureProvider({ returns: [], snapshotId: 'qa-snap-timeout' }),
      save: async () => ({ ok: false, code: 'CMS_STATEMENT_TIMEOUT' }),
      nowMicros: () => BigInt(Date.now()) * BigInt(1000),
      remainingMs: () => 200_000,
    }
    const prog = { id: P, startDate: '2026-11-01', endDate: '2026-11-30', isTest: true, productIds: ['948001'] }
    const r = await runCmsReturnsAfterCloseProgram(deps, prog, { expectedPayoutRunId: R, reason: 'Phiếu hoàn tất sau ngày 30', request: ACTOR, profile: null })
    expect([r.status, r.code]).toEqual(['held', 'CMS_STATEMENT_TIMEOUT'])
  })
})

test.describe('Q-237 r1 · reader báo cáo + fixture full_line + XLSX @desktop', () => {
  test('reader: người lập / lý do lập tay; dòng frozen_return_*; lý do ở báo cáo không phải super ⇒ lỗi; DB trước 132 ⇒ null', () => {
    const base = { id: P, payout_run_id: R, eval_seq: 1, returns_as_of: TS, frozen_amount: '3000', recomputed_amount: '0', delta_amount: '-3000',
      return_events: 2, line_count: 1, created_at: TS }
    const s = parseCmsCloseReports({ program_id: P, reports: [{ ...base, created_via: 'super', created_by: ACTOR, created_by_name: 'Super A', manual_reason: 'Đối soát ngày 31 QA' }] }).reports[0]
    expect([s.createdBy, s.createdByName, s.manualReason, cmsCloseReportViaLabel(s)]).toEqual([ACTOR, 'Super A', 'Đối soát ngày 31 QA', 'Lập tay ngày 31 — Super A'])
    const cron = parseCmsCloseReports({ program_id: P, reports: [{ ...base, created_via: 'cron' }] }).reports[0]
    expect([cron.createdBy, cron.manualReason, cmsCloseReportViaLabel(cron)]).toEqual([null, null, 'Tự động (job)'])
    expect(() => parseCmsCloseReports({ program_id: P, reports: [{ ...base, created_via: 'cron', manual_reason: 'x'.repeat(12) }] })).toThrow(CmsReturnsDtoError)
    const line = { line_no: 1, user_id: A, full_name: null, program_product_id: R, product_id: '948001', gmv_basis: 'product', per_unit: '2', frozen_base: '16',
      frozen_qty: '3', frozen_gmv: '160000', frozen_gate_met: true, frozen_amount: '3000', return_base: '10', return_gmv: '50000', return_events: 2,
      eligible_base: '6', net_gmv: '110000', gate_met: false, recomputed_qty: '0', recomputed_amount: '0', delta: '-3000' }
    const report = { ...base, program_id: P, returns_digest: 'a'.repeat(64), created_via: 'cron', not_a_payment_order: true }
    const ct = parseCmsCloseReportPage({ report, lines: [{ ...line, frozen_return_base: '10', frozen_return_gmv: '30000' }], next_after: null })
    expect([ct.lines[0].frozenReturnBase, ct.lines[0].frozenReturnGmv, cmsCloseReportIsContract(ct.lines)]).toEqual(['10', '30000', true])
    const lg = parseCmsCloseReportPage({ report, lines: [line], next_after: null })
    expect([lg.lines[0].frozenReturnBase, cmsCloseReportIsContract(lg.lines)]).toEqual([null, false])
    expect(() => parseCmsCloseReportPage({ report, lines: [{ ...line, frozen_return_base: '10', frozen_return_gmv: null }], next_after: null })).toThrow(CmsReturnsDtoError)
  })

  test('fixture full_line: PG17 / PG18 qua parser thật (hợp đồng v2 / status-v2), danh sách cũ 4 chương trình không đổi; sổ trả fp v2 không lượng', () => {
    expect(CMS_FX_CONTRACT_PROGRAMS).toHaveLength(4)
    expect(CMS_FX_FULL_LINE_PROGRAMS.map((p) => [p.policy, p.basis, p.fx.row.status])).toEqual([[FULL, 'pos_base', 'active'], [FULL, 'cms_unit', 'locked']])
    expect(CMS_FX_STAFF_FULL_LINE).toHaveLength(2)
    for (const id of [CMS_FX_PG_FULL_LINE.PG17, CMS_FX_PG_FULL_LINE.PG18]) {
      const r = cmsFxContractResultsOf(id, 'running', { kind: 'super' })
      expect(r?.kind, id).toBe('loaded')
      if (r?.kind !== 'loaded') continue
      expect([r.header.run?.contract?.calcContractVersion, r.header.run?.contract?.returnsPolicy]).toEqual(['cms-calc-ret2-v2', FULL])
      const lines = cmsFxContractLines(r.rows.results)
      expect(lines?.some((l) => l.kind === 'RETURN'), id).toBe(true)
      const cf = cmsFxReturnConflicts(id, 'proof')
      expect([cf?.returnsPolicy, cf?.open[0]?.baseline.baseQuantity]).toEqual([FULL, null])
    }
    // P1-03: PG17 có HAI phiếu cùng dòng bán 01 — phiếu đầu trừ đủ lượng dòng (lượng ròng của dòng 0, GMV còn dương), phiếu sau lượng 0,
    // GMV trừ đúng tiền hoàn 9.000 (engine thật qua parser dòng v2).
    const p17 = cmsFxContractResultsOf(CMS_FX_PG_FULL_LINE.PG17, 'running', { kind: 'super' })
    const l17 = p17?.kind === 'loaded' ? cmsFxContractLines(p17.rows.results) ?? [] : []
    const rt = l17.filter((l) => l.kind === 'RETURN')
    const same = rt.filter((l) => l.orderLineId === rt.find((x) => x.returnCode === 'PT1701')?.orderLineId)
    expect(same.map((l) => [l.returnCode, Number(l.baseQuantity), Number(l.gmvAmount)])).toEqual([['PT1701', -200, -16000], ['PT1705', 0, -9000]])
  })

  test('PG18 đã chốt run contract: payout = Σ RÒNG; báo cáo lập tay: phiếu đã trừ trước chốt KHÔNG trừ lại (Δ chỉ do phiếu sau chốt)', () => {
    const c = cmsFxContract(CMS_FX_PG_FULL_LINE.PG18)!
    const net = c.out.results.reduce((a, r) => a + r.amountVnd, BigInt(0))
    const pay = cmsFxContractPayout('super')
    expect([pay.programTotal, pay.contract?.returnsPolicy, pay.super?.returns?.returnCount]).toEqual([net.toString(), FULL, 3])
    expect(cmsFxContractPayout('sm').super).toBeNull()
    const list = cmsFxContractCloseReports(c.fx.row.id)!
    expect([list.length, list[0].createdVia, list[0].manualReason !== null, list[0].returnsProfile]).toEqual([1, 'super', true, FULL])
    const page = cmsFxContractCloseReport(c.fx.row.id, CMS_FX_CONTRACT_REPORT_ID)!
    expect(page.report.frozenAmount).toBe(net.toString())
    expect(cmsCloseReportIsContract(page.lines)).toBe(true)
    // Mọi nhóm KHÔNG có phiếu sau chốt: Δ 0 dù đã có phiếu trước chốt (lượng đã trừ = lượng đã trừ lúc chốt).
    const changed = page.lines.filter((l) => l.delta !== '0')
    expect(changed).toHaveLength(1)
    expect([changed[0].productId, changed[0].delta, changed[0].frozenReturnBase]).toEqual(['900201', '-60000', '0'])
    for (const l of page.lines.filter((x) => x.delta === '0' && x.frozenReturnBase !== '0')) expect(l.returnBase, `line ${l.lineNo}`).toBe(l.frozenReturnBase)
    expect(page.report.deltaAmount).toBe('-60000')
  })

  test('XLSX: payout contract có chính sách / mốc / tổng trả; báo cáo contract có cột đã trừ lúc chốt + lý do; payout legacy không thêm dòng', () => {
    const read = (b: Uint8Array) => XLSX.read(b, { type: 'array' })
    const rowsOf = (wb: XLSX.WorkBook, n: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, defval: '' })
    const prog = { id: CMS_FX_PG_FULL_LINE.PG18, name: 'PG18', startDate: '2026-10-06', endDate: '2026-11-05', status: 'locked', isTest: false }
    const pb = buildCmsPayoutWorkbook({ program: prog, payout: cmsFxContractPayout('super'), exportedAt: new Date('2026-11-18T00:00:00Z'), scope: 'super' })
    expect(pb.ok).toBe(true)
    if (!pb.ok) return
    const info = rowsOf(read(pb.bytes), 'Thong tin').map((r) => String(r[0]))
    for (const k of ['Chính sách trả hàng', 'Trả hàng đã trừ tới mốc (VN)', 'Lưu ý trả hàng', 'Phiếu trả đã trừ trong số chốt', 'Tiền hoàn đã trừ khỏi GMV (VND)']) expect(info, k).toContain(k)
    const sm = buildCmsPayoutWorkbook({ program: prog, payout: cmsFxContractPayout('sm'), exportedAt: new Date('2026-11-18T00:00:00Z'), scope: 'sm' })
    expect(sm.ok && rowsOf(read(sm.bytes), 'Thong tin').map((r) => String(r[0]))).not.toContain('Phiếu trả đã trừ trong số chốt')
    const legacyPay = parseCmsPayout(payoutRaw('super', { contract: null, returns: null }))
    const lb = buildCmsPayoutWorkbook({ program: { ...prog, id: P }, payout: legacyPay, exportedAt: new Date('2026-11-18T00:00:00Z'), scope: 'super' })
    expect(lb.ok && rowsOf(read(lb.bytes), 'Thong tin').map((r) => String(r[0]))).not.toContain('Chính sách trả hàng')
    const c = cmsFxContract(CMS_FX_PG_FULL_LINE.PG18)!
    const page = cmsFxContractCloseReport(c.fx.row.id, CMS_FX_CONTRACT_REPORT_ID)!
    const rb = buildCmsCloseReportWorkbook({ program: prog, page, products: c.fx.products.map((p) => ({ id: p.id, nameSnapshot: p.nameSnapshot, unitCms: p.unitCms })),
      exportedAt: new Date('2026-11-18T00:00:00Z') })
    expect(rb.ok).toBe(true)
    if (!rb.ok) return
    const wb = read(rb.bytes)
    const head = rowsOf(wb, 'Theo duoc si')[0].map(String)
    expect(head).toContain('Lượng đã trừ lúc chốt')
    expect(head).toContain('Tiền hoàn đã trừ lúc chốt (VND)')
    const kv = new Map(rowsOf(wb, 'Thong tin').map((r) => [String(r[0]), String(r[1])]))
    expect([kv.get('Số đã chốt'), (kv.get('Lý do lập tay')?.length ?? 0) > 0, kv.get('Tạo bởi')]).toEqual([CMS_CLOSE_REPORT_CONTRACT_NOTE, true, 'Lập tay ngày 31 — Super mẫu'])
  })
})
