import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { cmsAfterCloseHttpStatus, handleCmsReturnsAfterClose, runCmsReturnsAfterClose, type CmsAfterCloseDeps, type CmsAfterCloseProgram, cmsAfterCloseRotate, cmsAfterCloseRpcCode, cmsAfterCloseRefs } from '../lib/cms/returnsAfterClose'
import { cmsConfirmRpcCode, runCmsConfirmRestored, type CmsConfirmRestoredDeps } from '../lib/cms/returnsConflictAction'
import { CmsReturnsDtoError, parseCmsCloseReportPage, parseCmsCloseReports, parseCmsReturnConflicts } from '../lib/cms/returnsView'
import { buildCmsCloseReportWorkbook } from '../lib/cms/exportCloseReport'
import { createCmsContractFixtureProvider } from './cmsContractFixture'
import type { CmsCloseReportPayload } from '../lib/cms/calc/closeReport'
import type { CmsContractSourceProvider, CmsContractSourceReady } from '../lib/cms/source/contractSource'

// CMS-CALC-RET-2 P5.5 — job báo cáo sau chốt + xác nhận nguồn phục hồi + đọc báo cáo (PM work order 14/11 §P5.5; dev design r2 §6.6 /
// §14.1–14.2). Không DB: deps giả, provider fixture (e2e/cmsContractFixture.ts). DB (130) đã có test riêng ở PGlite / PG15.

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROG = uid(41), RUN = uid(31), ACTOR = uid(7), P1 = '900001'
const ASOF = BigInt(Date.parse('2026-12-03T03:00:00Z')) * BigInt(1000)
const retRow = (o: Record<string, string | null> = {}) => ({
  src_kind: 'R', return_event_id: 'RT1', return_document_id: 'RD1', return_code: 'RT-1', return_status: 'COMPLETED',
  return_recorded_at: '2026-12-01T02:00:00.000000Z', original_order_line_id: '9001', original_order_id: 'O1', product_id: P1,
  return_base_quantity: '10', return_gmv_amount: '100000', original_completed_at: '2026-11-03T02:00:00.000000Z', original_order_type: 'OFFLINE',
  original_order_status: 'COMPLETED', original_seller_email: 'ds1@example.invalid', original_pos_code: 'QAOS01', original_base_quantity: '20',
  original_gmv_amount: '200000', original_quantity_raw: '2', original_uom_raw: 'Hộp', source_updated_at: null, ...o,
})
const prog = (o: Partial<CmsAfterCloseProgram> = {}): CmsAfterCloseProgram => ({ id: PROG, startDate: '2026-11-01', endDate: '2026-11-30', isTest: true, productIds: [P1], ...o })

function deps(o: Partial<CmsAfterCloseDeps> & { returns?: Record<string, string | null>[] } = {}, calls: string[] = [], saves: CmsCloseReportPayload[] = []): CmsAfterCloseDeps {
  const { returns, ...rest } = o
  const provider = createCmsContractFixtureProvider({ returns: returns ?? [retRow()], snapshotId: 'qa-snap-1' })
  return {
    capsOk: async () => { calls.push('caps'); return true },
    listPrograms: async () => { calls.push('list'); return [prog()] },
    payoutRun: async (id) => { calls.push(`payout:${id}`); return { ok: true, runId: RUN, legacy: true } },
    provider: { kind: provider.kind, read: async (s) => { calls.push('read'); return provider.read(s) } },
    save: async (_id, runId, payload) => { calls.push(`save:${runId}`); saves.push(payload); return { ok: true, data: { saved: true, already: false, report_id: uid(90) } } },
    nowMicros: () => ASOF,
    remainingMs: () => 200_000,
    ...rest,
  }
}

test.describe('CMS-CALC-RET-2 P5.5 — job báo cáo sau chốt @desktop', () => {
  test('Bearer sai ⇒ 401; cờ OFF ⇒ 200 DISABLED, không dựng deps; năng lực DB thiếu ⇒ 503, không đọc nguồn', async () => {
    let made = 0
    const mk = () => { made++; return deps() }
    expect((await handleCmsReturnsAfterClose({ authorization: 'Bearer x', cronSecret: 's', returnsEnabled: true, makeDeps: mk })).status).toBe(401)
    const off = await handleCmsReturnsAfterClose({ authorization: 'Bearer s', cronSecret: 's', returnsEnabled: false, makeDeps: mk })
    expect(off).toEqual({ status: 200, body: { status: 'DISABLED', code: 'RETURNS_DISABLED' } })
    expect(made).toBe(0)
    const calls: string[] = []
    const r = await handleCmsReturnsAfterClose({ authorization: 'Bearer s', cronSecret: 's', returnsEnabled: true, makeDeps: () => deps({ capsOk: async () => { calls.push('caps'); return false } }, calls) })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('CAPS_UNAVAILABLE')
    expect(calls).toEqual(['caps'])
    expect((await handleCmsReturnsAfterClose({ authorization: 'Bearer s', cronSecret: 's', returnsEnabled: true, makeDeps: () => { throw new Error('x') } })).status).toBe(503)
  })
  test('thành công: một job nguồn ghim as_of, payload chỉ pin + phiếu thô (không số tiền), lưu đúng run chốt', async () => {
    const calls: string[] = []
    const saves: CmsCloseReportPayload[] = []
    const s = await runCmsReturnsAfterClose(deps({}, calls, saves), { maxPrograms: 5 })
    expect(s.results).toEqual([{ programId: PROG, status: 'saved', code: null, reportId: uid(90), returnsRead: 1 }])
    expect(calls).toEqual(['caps', 'list', `payout:${PROG}`, 'read', `save:${RUN}`])
    expect(Object.keys(saves[0]).sort()).toEqual(['pin', 'returns'])
    expect(saves[0].pin).toMatchObject({ protocol: 'cms-source-pin-v1', provider: 'fixture', snapshot_id: 'qa-snap-1', as_of: '2026-12-03T03:00:00.000000Z',
      scope: { from: '2026-11-01', to: '2026-11-30' }, returns: { rows: 1 } })
    expect(JSON.stringify(saves[0])).not.toMatch(/amount_vnd|recomputed|delta/)
    expect(cmsAfterCloseHttpStatus(s)).toBe(200)
  })
  test('DB trả báo cáo cũ (cùng snapshot) ⇒ already; sổ lệch / conflict mở ⇒ held, không coi là lỗi', async () => {
    const a = await runCmsReturnsAfterClose(deps({ save: async () => ({ ok: true, data: { saved: true, already: true, report_id: uid(91) } }) }), { maxPrograms: 5 })
    expect(a.results[0]).toMatchObject({ status: 'already', reportId: uid(91) })
    const h = await runCmsReturnsAfterClose(deps({ save: async () => ({ ok: true, data: { saved: false, code: 'CMS_REPORT_LEDGER_CONFLICT' } }) }), { maxPrograms: 5 })
    expect(h.results[0]).toMatchObject({ status: 'held', code: 'CMS_REPORT_LEDGER_CONFLICT' })
    expect(cmsAfterCloseHttpStatus(h)).toBe(200)
    const odd = await runCmsReturnsAfterClose(deps({ save: async () => ({ ok: true, data: { saved: 'yes' } }) }), { maxPrograms: 5 })
    expect(odd.results[0]).toMatchObject({ status: 'error', code: 'SAVE_REPLY_INVALID' })
    const err = await runCmsReturnsAfterClose(deps({ save: async () => ({ ok: false, code: 'CMS_REPORT_CONTEXT_MISMATCH' }) }), { maxPrograms: 5 })
    expect(err.results[0]).toMatchObject({ status: 'error', code: 'CMS_REPORT_CONTEXT_MISMATCH' })
    expect(cmsAfterCloseHttpStatus(err)).toBe(500)
  })
  test('nguồn lỗi / pin lệch / phiếu sai dạng ⇒ không gọi save (thiếu nguồn ≠ 0 phiếu)', async () => {
    const fail = (code: 'PERMISSION_DENIED' | 'TIMEOUT'): CmsContractSourceProvider => ({ kind: 'bq', read: async () => ({ ok: false, code }) })
    const cases: [Partial<CmsAfterCloseDeps> & { returns?: Record<string, string | null>[] }, string, string][] = [
      [{ provider: fail('PERMISSION_DENIED'), listPrograms: async () => [prog({ isTest: false })] }, 'held', 'SOURCE_PERMISSION_DENIED'],
      [{ provider: fail('TIMEOUT'), listPrograms: async () => [prog({ isTest: false })] }, 'error', 'SOURCE_TIMEOUT'],
      [{ returns: [retRow({ return_base_quantity: '1.5' })] }, 'held', 'RETURN_ROW_INVALID'],
      [{ returns: [retRow(), retRow()] }, 'held', 'RETURN_SET_INVALID'],
    ]
    for (const [o, status, code] of cases) {
      const calls: string[] = []
      const s = await runCmsReturnsAfterClose(deps(o, calls), { maxPrograms: 5 })
      expect(s.results[0], code).toMatchObject({ status, code })
      expect(calls.some((c) => c.startsWith('save')), code).toBe(false)
    }
    const tamper = (f: (r: CmsContractSourceReady) => CmsContractSourceReady): CmsContractSourceProvider => {
      const p = createCmsContractFixtureProvider({ returns: [retRow()], tamper: f })
      return p
    }
    for (const f of [(r: CmsContractSourceReady) => ({ ...r, asOfMicros: r.asOfMicros - BigInt(1) }), (r: CmsContractSourceReady) => ({ ...r, returnsRaw: null }),
      (r: CmsContractSourceReady) => ({ ...r, jobId: 'j1' })]) {
      const calls: string[] = []
      const s = await runCmsReturnsAfterClose(deps({ provider: tamper(f) }, calls), { maxPrograms: 5 })
      expect(s.results[0]).toMatchObject({ status: 'error', code: 'SOURCE_PIN_MISMATCH' })
      expect(calls.some((c) => c.startsWith('save'))).toBe(false)
    }
  })
  test('fixture trên chương trình thật / chưa chốt / run chốt contract ⇒ không đọc nguồn', async () => {
    const c1: string[] = []
    const a = await runCmsReturnsAfterClose(deps({ listPrograms: async () => [prog({ isTest: false })] }, c1), { maxPrograms: 5 })
    expect(a.results[0]).toMatchObject({ status: 'held', code: 'FIXTURE_REAL_PROGRAM' })
    expect(c1).toEqual(['caps'])
    const c2: string[] = []
    const b = await runCmsReturnsAfterClose(deps({ payoutRun: async () => ({ ok: false, code: 'CMS_REPORT_NOT_LOCKED' }) }, c2), { maxPrograms: 5 })
    expect(b.results[0]).toMatchObject({ status: 'skipped', code: 'CMS_REPORT_NOT_LOCKED' })
    const c3: string[] = []
    const c = await runCmsReturnsAfterClose(deps({ payoutRun: async () => ({ ok: true, runId: RUN, legacy: false }) }, c3), { maxPrograms: 5 })
    expect(c.results[0]).toMatchObject({ status: 'skipped', code: 'CMS_REPORT_CONTRACT_UNSUPPORTED' })
    expect(c3.includes('read')).toBe(false)
    const d = await runCmsReturnsAfterClose(deps({ provider: null }), { maxPrograms: 5 })
    expect(d.results[0]).toMatchObject({ status: 'error', code: 'PROVIDER_MISSING' })
  })
  test('ngân sách: trần số chương trình / hết giờ ⇒ pending (lượt sau), không bỏ dở giữa chương trình', async () => {
    const many = [prog({ id: uid(1) }), prog({ id: uid(2) }), prog({ id: uid(3) })]
    // Vượt trần ⇒ xoay vòng theo ngày UTC (db-reviewer P2-2): bắt đầu ở vị trí (số ngày kể từ epoch) mod 3.
    const start = Math.floor(Date.parse('2026-12-03T03:00:00Z') / 86_400_000) % 3
    const order = [...many.slice(start), ...many.slice(0, start)].map((p) => p.id)
    const s = await runCmsReturnsAfterClose(deps({ listPrograms: async () => many }), { maxPrograms: 2 })
    expect(s.results.map((r) => r.programId)).toEqual(order.slice(0, 2))
    expect(s.pending).toEqual(order.slice(2))
    // Ngày sau ⇒ vị trí bắt đầu dịch 1; ba ngày liên tiếp mỗi chương trình đều có lượt đứng đầu.
    const firsts = [0, 1, 2].map((d) => cmsAfterCloseRotate(many, ASOF + BigInt(d) * BigInt(86_400_000_000), 2)[0].id)
    expect(new Set(firsts).size).toBe(3)
    // Không vượt trần ⇒ giữ nguyên thứ tự.
    expect(cmsAfterCloseRotate(many, ASOF, 3).map((p) => p.id)).toEqual([uid(1), uid(2), uid(3)])
    const t = await runCmsReturnsAfterClose(deps({ listPrograms: async () => many, remainingMs: () => 5_000 }), { maxPrograms: 5 })
    expect(t.results).toEqual([])
    expect(t.pending.length).toBe(3)
    const boom = await runCmsReturnsAfterClose(deps({ listPrograms: async () => many, payoutRun: async (id) => { if (id === uid(2)) throw new Error('x'); return { ok: true, runId: RUN, legacy: true } } }), { maxPrograms: 5 })
    expect(boom.results.map((r) => r.status)).toEqual(['saved', 'error', 'saved'])
    expect(cmsAfterCloseHttpStatus(boom)).toBe(207)
  })
  test('lỗi save: hết lock_timeout (55P03) ⇒ held CMS_LOCK_TIMEOUT; refs DETAIL (≤ 20 ID, lọc ký tự) đi kèm mục để ghi vết', async () => {
    expect(cmsAfterCloseRpcCode({ message: 'canceling statement due to lock timeout', code: '55P03' }, 'SAVE_FAILED')).toBe('CMS_LOCK_TIMEOUT')
    expect(cmsAfterCloseRpcCode({ message: 'CMS_REPORT_CONTEXT_MISMATCH', code: 'P0001' }, 'SAVE_FAILED')).toBe('CMS_REPORT_CONTEXT_MISMATCH')
    expect(cmsAfterCloseRpcCode({ message: 'lỗi lạ <email@x>', code: 'XX000' }, 'SAVE_FAILED')).toBe('SAVE_FAILED')
    expect(cmsAfterCloseRefs('refs: RT1,9001, bad ref,<x>,' + Array.from({ length: 30 }, (_, i) => 'R' + i).join(','))).toEqual(['RT1', '9001', ...Array.from({ length: 18 }, (_, i) => 'R' + i)])
    expect(cmsAfterCloseRefs(null)).toEqual([])
    expect(cmsAfterCloseRefs('khác')).toEqual([])
    const busy = await runCmsReturnsAfterClose(deps({ save: async () => ({ ok: false, code: 'CMS_LOCK_TIMEOUT' }) }), { maxPrograms: 5 })
    expect(busy.results[0]).toMatchObject({ status: 'held', code: 'CMS_LOCK_TIMEOUT' })
    const ctx = await runCmsReturnsAfterClose(deps({ save: async () => ({ ok: false, code: 'CMS_REPORT_CONTEXT_MISMATCH', refs: ['RT1'] }) }), { maxPrograms: 5 })
    expect(ctx.results[0]).toMatchObject({ status: 'error', code: 'CMS_REPORT_CONTEXT_MISMATCH', refs: ['RT1'] })
    const d = fs.readFileSync(path.join(__dirname, '..', 'lib/cms/server/returnsAfterCloseDeps.ts'), 'utf8')
    expect(d).toContain('cmsAfterCloseRefs((error as { details?: unknown }).details)')
    // SP đọc theo từng chương trình, phân trang (không một .in() bị trần 1.000 dòng cắt).
    expect(d).toContain(".eq('program_id', p.id).order('id')")
    expect(d).toContain('.range(from, from + PRODUCT_PAGE - 1)')
    expect(d).not.toContain(".in('program_id'")
    // DETAIL refs của report_save chỉ dựng từ ID kỹ thuật (return_event_id / original_order_line_id qua acc.id) — không order_code / tên /
    // SĐT / email (security-reviewer lượt 2: điều kiện để log refs). Route log kèm chương trình: programId:ref.
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase/migrations/130_cms_calculation_modes_returns.sql'), 'utf8')
    const blocks = [...sql.matchAll(/\), h AS \(([\s\S]*?)\), hc AS \(/g)].map((x) => x[1]).filter((x) => x.includes('AS ref'))
    expect(blocks).toHaveLength(1)
    const refCols = [...blocks[0].matchAll(/SELECT '[A-Z_]+'(?: AS code)?, ([a-z_.]+)/g)].map((x) => x[1])
    expect(refCols.length).toBe(6)
    expect(new Set(refCols)).toEqual(new Set(['e.return_event_id', 'acc.id']))
    expect(sql).toContain('SELECT e.original_order_line_id AS id, max(e.sb) AS sb')
    expect(sql).toContain("DETAIL = 'refs: ' || COALESCE(v_ids, '')")
    const route = fs.readFileSync(path.join(__dirname, '..', 'app/api/cron/cms-returns-after-close/route.ts'), 'utf8')
    expect(route).toContain('(x.refs ?? []).map((ref) => `${x.programId}:${ref}`)')
  })
  test('route / deps thật: Bearer + cờ returns; deps service_role chỉ RPC 130 + cửa sổ ngày; không tạo task Coolify', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'app/api/cron/cms-returns-after-close/route.ts'), 'utf8')
    expect(route).toContain('returnsEnabled: cmsCalcFlagsFromEnv(process.env).returns')
    expect(route).toContain("cronSecret: process.env.CRON_SECRET")
    const d = fs.readFileSync(path.join(__dirname, '..', 'lib/cms/server/returnsAfterCloseDeps.ts'), 'utf8')
    expect(d).toContain("'rpc_cms_return_close_report_save'")
    expect(d).toContain("'rpc_cms_frozen_sales_lines'")
    expect(d).toContain(".eq('status', 'locked').eq('is_test', false)")
    expect(d).not.toMatch(/cms_payouts|cms_payout_staff/)
    expect(fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8')).toContain('CMS_RETURNS_AFTER_CLOSE_MAX_AGE_DAYS=')
  })
})

test.describe('CMS-CALC-RET-2 P5.5 — xác nhận nguồn phục hồi @desktop', () => {
  const HASH = 'a'.repeat(64)
  const ok = { programId: PROG, openSetHash: HASH, proofEvalSeq: 7, reason: '  Đã kiểm với BI: phiếu RT1 khôi phục  ', idem: uid(55) }
  function cdeps(o: Partial<CmsConfirmRestoredDeps> = {}, calls: string[] = [], args: Record<string, unknown>[] = []): CmsConfirmRestoredDeps {
    return {
      enabled: () => true, qaReadonly: () => false,
      access: async () => { calls.push('access'); return { kind: 'ok', actorId: ACTOR, qa: false } },
      program: async () => { calls.push('program'); return { isTest: false } },
      rpc: async (_fn, a) => { calls.push('rpc'); args.push(a); return { data: { confirmed: true, already: false, id: uid(66), conflicts: 3, proof_eval_seq: 7 }, error: null } },
      ...o,
    }
  }
  test('thứ tự cổng: cờ → QA chỉ đọc → super → đầu vào → chương trình → RPC (session)', async () => {
    const c0: string[] = []
    expect(await runCmsConfirmRestored(cdeps({ enabled: () => false }, c0), ok)).toEqual({ ok: false, code: 'RETURNS_DISABLED' })
    expect(await runCmsConfirmRestored(cdeps({ qaReadonly: () => true }, c0), ok)).toEqual({ ok: false, code: 'QA_SERVER_READONLY' })
    expect(c0).toEqual([])
    expect(await runCmsConfirmRestored(cdeps({ access: async () => ({ kind: 'anonymous' }) }), ok)).toEqual({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await runCmsConfirmRestored(cdeps({ access: async () => ({ kind: 'forbidden' }) }), ok)).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await runCmsConfirmRestored(cdeps({ access: async () => { throw new Error('x') } }), ok)).toEqual({ ok: false, code: 'UNAVAILABLE' })
    const bad = [null, {}, { ...ok, programId: 'x' }, { ...ok, openSetHash: 'A'.repeat(64) }, { ...ok, proofEvalSeq: 0 }, { ...ok, proofEvalSeq: 1.5 },
      { ...ok, proofEvalSeq: '7' }, { ...ok, idem: 'k' }, { ...ok, reason: 'ngắn quá' }, { ...ok, reason: 'x'.repeat(1001) }, { ...ok, reason: '😀'.repeat(1001) }, { ...ok, reason: '😀'.repeat(9) }, { ...ok, reason: 'có ký tự\u0007 điều khiển' }]
    for (const b of bad) {
      const c: string[] = []
      expect(await runCmsConfirmRestored(cdeps({}, c), b), JSON.stringify(b)).toEqual({ ok: false, code: 'BAD_INPUT' })
      expect(c.includes('rpc')).toBe(false)
    }
    expect(await runCmsConfirmRestored(cdeps({ program: async () => ({ isTest: true }) }), ok)).toEqual({ ok: false, code: 'NOT_FOUND' })
    expect(await runCmsConfirmRestored(cdeps({ program: async () => null }), ok)).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
  test('độ dài lý do theo code point như SQL char_length: 10 emoji hợp lệ, 1.000 emoji hợp lệ (db-reviewer P2-8)', async () => {
    for (const reason of ['😀'.repeat(10), '😀'.repeat(1000)]) {
      const c: string[] = []
      expect((await runCmsConfirmRestored(cdeps({}, c), { ...ok, reason })).ok, String([...reason].length)).toBe(true)
      expect(c).toContain('rpc')
    }
  })
  test('gửi đúng proof + hash + idem, lý do đã trim; kết quả / already', async () => {
    const args: Record<string, unknown>[] = []
    expect(await runCmsConfirmRestored(cdeps({}, [], args), ok)).toEqual({ ok: true, already: false, restorationId: uid(66), conflicts: 3, proofEvalSeq: 7 })
    expect(args[0]).toEqual({ p_program_id: PROG, p_expected_open_set_hash: HASH, p_proof_eval_seq: 7, p_reason: 'Đã kiểm với BI: phiếu RT1 khôi phục', p_idem: uid(55) })
    const al = await runCmsConfirmRestored(cdeps({ rpc: async () => ({ data: { confirmed: true, already: true, id: uid(66), conflicts: 3, proof_eval_seq: 7 }, error: null }) }), ok)
    expect(al).toMatchObject({ ok: true, already: true })
    expect(await runCmsConfirmRestored(cdeps({ rpc: async () => ({ data: { confirmed: 'yes' }, error: null }) }), ok)).toEqual({ ok: false, code: 'UNKNOWN_OUTCOME' })
    expect(await runCmsConfirmRestored(cdeps({ rpc: async () => { throw new Error('net') } }), ok)).toEqual({ ok: false, code: 'UNKNOWN_OUTCOME' })
  })
  test('map lỗi RPC: stale / proof / không còn conflict / idem / timeout', () => {
    const m = (message: string, code = 'P0001') => cmsConfirmRpcCode({ message, code })
    expect(m('CMS_RETURN_OPEN_SET_STALE')).toBe('STALE')
    expect(['CMS_RETURN_PROOF_NOT_LATEST', 'CMS_RETURN_PROOF_STALE', 'CMS_RETURN_PROOF_NOT_MATCH'].map((x) => m(x))).toEqual(['PROOF_INVALID', 'PROOF_INVALID', 'PROOF_INVALID'])
    expect(m('CMS_RETURN_NO_OPEN_CONFLICT')).toBe('NO_OPEN_CONFLICT')
    expect(m('CMS_IDEM_REUSED')).toBe('IDEM_REUSED')
    expect(m('CMS_RETURN_CONFIRM_FORBIDDEN', '42501')).toBe('FORBIDDEN')
    expect(cmsConfirmRpcCode({ message: 'x', code: '57014' })).toBe('UNKNOWN_OUTCOME')
    expect(cmsConfirmRpcCode({ message: 'x', code: '55P03' })).toBe('BUSY')
    expect(cmsConfirmRpcCode({ message: 'x', code: 'PGRST202' })).toBe('QUERY_FAILED')
  })
  test('nguồn: RPC bằng session client (không service role), không có nhận số mới', () => {
    const load = fs.readFileSync(path.join(__dirname, '..', 'lib/cms/server/returnsLoad.ts'), 'utf8')
    expect(load).not.toContain('supabaseAdmin')
    for (const f of ['lib/cms/returnsConflictAction.ts', 'components/cms/admin/CmsReturnsAdminView.tsx', 'components/cms/admin/CmsConfirmRestoredForm.tsx', 'app/actions/cmsReturns.ts']) {
      // Bỏ dòng chú thích (chú thích được phép NÊU rằng không có ACCEPT_NEW) rồi mới tìm.
      const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      expect(code, f).not.toMatch(/ACCEPT_NEW|accept_new|Nhận số mới|nhận tiền mới/i)
    }
    const page = fs.readFileSync(path.join(__dirname, '..', 'app/(dashboard)/targets/campaigns/cms/[id]/returns/page.tsx'), 'utf8')
    expect(page).toContain('canManageCms(profile?.role, user.email)')
    expect(page).toContain('caps.caps.paths.returns_ledger')
  })
})

test.describe('CMS-CALC-RET-2 P5.5 — DTO + XLSX báo cáo sau chốt @desktop', () => {
  const conflictsRaw = (o: Record<string, unknown> = {}) => ({
    program_id: PROG, returns_policy: 'net_returns_v1', config_version: 3, baselines: 12, ledger_set_hash: 'b'.repeat(64), open_set_hash: 'c'.repeat(64),
    open_count: 1, open_truncated: false,
    latest_eval: { eval_seq: 7, kind: 'run', run_id: RUN, report_attempt: null, verdict: 'OPEN_CONFLICT_MATCH', returns_as_of: '2026-12-03T03:00:00.000000Z',
      evaluated_at: '2026-12-03T03:01:00.000000Z', baselines: 12, mismatched: 0, open_conflicts: 1 },
    proof: { eval_seq: 7, open_set_hash: 'c'.repeat(64) },
    open: [{ conflict_id: 5, return_event_id: 'RT1', prev_conflict_id: null, opened_kind: 'MISSING', opened_eval_seq: 6, opened_at: '2026-12-02T03:01:00.000000Z',
      baseline: { return_document_id: 'RD1', original_order_line_id: '9001', product_id: P1, base_quantity: '10', refund_amount: '100000', recorded_at: '2026-12-01T02:00:00.000000Z',
        accepted_run_id: RUN, accepted_report_id: null, accepted_at: '2026-12-01T03:00:00.000000Z' },
      observations: [{ version: 2, eval_seq: 7, verdict: 'MATCH', observed: { fp: 'x' }, observed_at: '2026-12-03T03:01:00.000000Z' }] }],
    restorations: [], ...o,
  })
  test('conflicts: proof chỉ khi DB trả; sai dạng ⇒ throw', () => {
    const c = parseCmsReturnConflicts(conflictsRaw())
    expect(c.proof).toEqual({ evalSeq: 7, openSetHash: 'c'.repeat(64) })
    expect(c.open[0]).toMatchObject({ conflictId: 5, openedKind: 'MISSING', observations: [{ verdict: 'MATCH' }] })
    expect(parseCmsReturnConflicts(conflictsRaw({ proof: null })).proof).toBeNull()
    for (const bad of [conflictsRaw({ open_set_hash: 'x' }), conflictsRaw({ proof: { eval_seq: 0, open_set_hash: 'c'.repeat(64) } }), conflictsRaw({ open: 'x' }), conflictsRaw({ open_count: -1 })]) {
      expect(() => parseCmsReturnConflicts(bad)).toThrow(CmsReturnsDtoError)
    }
  })
  const reportRaw = (lines: Record<string, unknown>[], o: Record<string, unknown> = {}) => ({
    report: { id: uid(90), program_id: PROG, payout_run_id: RUN, eval_seq: 8, source_pin: {}, returns_as_of: '2026-12-03T03:00:00.000000Z', returns_digest: 'd'.repeat(64),
      frozen_amount: '45000', recomputed_amount: '30000', delta_amount: '-15000', return_events: 1, line_count: lines.length, created_via: 'cron',
      created_at: '2026-12-03T03:02:00.000000Z', not_a_payment_order: true, ...o },
    lines, next_after: null,
  })
  const line = (o: Record<string, unknown> = {}) => ({
    line_no: 1, user_id: uid(1), program_product_id: uid(21), product_id: P1, gmv_basis: 'none', per_unit: '10', frozen_base: '30', frozen_qty: '3', frozen_gmv: '300000',
    frozen_gate_met: true, frozen_amount: '45000', return_base: '10', return_gmv: '100000', return_events: 1, eligible_base: '20', net_gmv: '200000', gate_met: true,
    recomputed_qty: '2', recomputed_amount: '30000', delta: '-15000', full_name: 'DS A', ...o,
  })
  test('báo cáo: bắt buộc not_a_payment_order; danh sách; XLSX đối chiếu tổng + ghi rõ không phải lệnh thu / chi', () => {
    expect(() => parseCmsCloseReportPage(reportRaw([line()], { not_a_payment_order: false }))).toThrow(CmsReturnsDtoError)
    const page = parseCmsCloseReportPage(reportRaw([line()]))
    expect(parseCmsCloseReports({ program_id: PROG, reports: [{ ...reportRaw([]).report, line_count: 1 }] }).reports[0]).toMatchObject({ deltaAmount: '-15000', createdVia: 'cron' })
    const P = { id: PROG, name: 'QA', startDate: '2026-11-01', endDate: '2026-11-30' }
    const b = buildCmsCloseReportWorkbook({ program: P, page, products: [{ id: uid(21), nameSnapshot: 'SP', unitCms: 'hộp' }], exportedAt: new Date('2026-12-03T04:00:00Z') })
    if (!b.ok) throw new Error(b.error)
    const wb = XLSX.read(b.bytes, { type: 'array' })
    const info = new Map(XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Thong tin'], { header: 1 }).map((r) => [String(r[0]), r[1]]))
    expect(String(info.get('Lưu ý'))).toContain('Không phải lệnh thu / chi')
    expect(info.get('Chênh lệch (VND)')).toBe(-15000)
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Theo duoc si'])
    expect(rows[0]).toMatchObject({ 'Dược sĩ': 'DS A', 'SL CMS đã chốt': 3, 'SL CMS tính lại': 2, 'Chênh lệch (VND)': -15000 })
    expect(buildCmsCloseReportWorkbook({ program: P, page: { ...page, lines: [{ ...page.lines[0], delta: '-14999' }] }, products: [], exportedAt: new Date() })).toEqual({ ok: false, error: 'TOTAL_MISMATCH' })
    expect(buildCmsCloseReportWorkbook({ program: P, page: { ...page, lines: [] }, products: [], exportedAt: new Date() })).toEqual({ ok: false, error: 'COUNT_MISMATCH' })
  })
})

test.describe('CMS-CALC-RET-2 P5.6 — mẫu nạp: cách tính ở chương trình, không cột Excel @desktop', () => {
  test('HUONG_DAN hai mẫu có hai cách tính + trả hàng trung tính; sheet dữ liệu không có cột cách tính; file tĩnh = bộ sinh', async () => {
    const { buildCmsImportTemplateXlsx, buildCmsSimpleTemplateXlsx } = await import('../lib/cms/import/workbooks')
    const { cmsIsBasisHeader } = await import('../lib/cms/calc/basisUi')
    for (const [build, file] of [[buildCmsImportTemplateXlsx, 'Circa_Import_CMS.xlsx'], [buildCmsSimpleTemplateXlsx, 'Circa_Import_CMS_muc_co_dinh.xlsx']] as const) {
      const wb = XLSX.read(build(), { type: 'array' })
      const guide = JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets.HUONG_DAN, { header: 1 }))
      expect(guide, file).toContain('Tính lẻ — cộng dồn quy đổi')
      expect(guide, file).toContain('Tính nguyên — đúng đơn vị CMS')
      expect(guide, file).toContain('không nhập trong file')
      expect(guide, file).not.toMatch(/đã trừ trả hàng/i)
      const data = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 })
      for (const row of data) for (const cell of row) if (typeof cell === 'string') expect(cmsIsBasisHeader(cell), `${file}: ${cell}`).toBe(false)
      const stat = XLSX.read(new Uint8Array(fs.readFileSync(path.resolve(__dirname, '..', 'public', 'templates', file))), { type: 'array' })
      expect(JSON.stringify(XLSX.utils.sheet_to_json(stat.Sheets.HUONG_DAN, { header: 1 })), file).toBe(guide)
    }
  })
})
