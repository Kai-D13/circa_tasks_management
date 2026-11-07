import { test, expect } from '@playwright/test'
import { BigQueryError } from '../lib/bigquery/query'
import { cmsSalesCronHttpStatus, handleSyncCmsSales, orderDuePrograms, runCmsSalesCron, type CmsSalesCronDeps } from '../lib/cms/cronSales'
import {
  cmsAdjustmentBlocksRelease, cmsCanPublishResults, CMS_Q206_RETURNS_CONTRACT, CMS_RESULTS_RELEASE_MODE, CMS_RETURNS_NOT_SUPPORTED,
} from '../lib/cms/releaseGate'
import { CMS_STAGE_PARTS, type CmsStagePart } from '../lib/cms/resultStage'
import * as S from '../lib/cms/salesSync'
import type { CmsRawRow } from '../lib/cms/source/contract'
import { createCmsFixtureRunner, type CmsFixtureSource } from './cmsFixtureRunner'
import { fxSale } from './cmsSourceFixture'

// CMS P2-b — lõi đồng bộ bán (lib/cms/salesSync.ts) + cron (lib/cms/cronSales.ts) với deps giả + runner fixture: không DB,
// không BigQuery. Kiểm thứ tự bước, dry-run không ghi, cổng Q-206, held / error từng bước, đóng run lỗi (CLOSE_FAILED),
// publish idempotent / mất phản hồi, NGÂN SÁCH (PM audit 03/11 P1-I2-1: deadline phủ stage / seal từng bước / publish /
// cleanup; elapsed gồm cleanup), cron pending / cảnh báo cleanup, cờ OFF không dựng deps.
// Deps giả cung cấp CẢ giao diện cũ (seal / cleanup một hàm) để chính các ca này chạy được trên bản r2.1 làm bằng chứng
// bắt lỗi (planning/research/dev-tools/cms/r21-deadline-proof.cjs).

const { runCmsSalesSync, runCmsSealSteps, cmsSalesExitCode, cmsRpcCode, CMS_SALES_STOP_RESERVE_MS, CMS_RPC_TIMEOUT_MAX_MS } = S
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROG = uid(1), S1 = uid(11), S2 = uid(12), S3 = uid(13), FS = uid(14)
const A = uid(21), B = uid(22), C = uid(23), QL = uid(24)
const PP = { p1: uid(31), p2: uid(32) }

function snapshot(o: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    program_id: PROG, status: 'active', is_test: true, config_version: 3, start_date: '2026-11-05', end_date: '2026-11-06',
    catalog_target_gmv: null, today_vn: '2026-11-07', current_result_run_id: null, previous_rows_read: null,
    store_ids: [S1, S2],
    products: [
      { id: PP.p1, product_id: '900001', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '24',
        tiers: [{ order: 1, from: 1, to: null, amount: '10000' }] },
      { id: PP.p2, product_id: '900002', gmv_basis: 'product', target_gmv: '100000', base_quantity_cms: '1',
        // CMS-Q-220: bậc cuối không giới hạn (lượng bán SP này ≤ 3 ⇒ tiền như cấu hình cũ 1–5).
        tiers: [{ order: 1, from: 1, to: 5, amount: '5000' }, { order: 2, from: 6, to: null, amount: '6000' }] },
    ],
    sellers: [
      { id: A, email: 'DS.A@cms.example.test', role: 'staff', store_id: S1 },
      { id: B, email: 'ds.b@cms.example.test', role: 'staff', store_id: S2 },
      { id: C, email: 'ds.c@cms.example.test', role: 'staff', store_id: S3 },
      { id: QL, email: 'qlch@cms.example.test', role: 'store_manager', store_id: S1 },
    ],
    stores: [S1, S2, S3].map((id) => ({ id, store_type: 'os', is_active: true })).concat([{ id: FS, store_type: 'fs', is_active: true }]),
    mapping_fp: 'a'.repeat(32),
    ...o,
  }
}

const IN = (n: number, o: Partial<Record<string, string | null>> = {}) => fxSale({
  order_line_id: `L-${String(n).padStart(3, '0')}`, order_id: `O-${n}`, order_code: `TEST-${n}`,
  completed_at: `2026-11-05T0${n % 10}:00:00.00000${n % 10}Z`, ...o,
})
const SALES: CmsRawRow[] = [
  IN(1), IN(2), IN(3, { base_quantity: '12' }),
  IN(4, { product_id: '900002', base_quantity: '1', gmv_amount: '60000' }),
  IN(5, { product_id: '900002', base_quantity: '2', gmv_amount: '50000' }),
  IN(6, { seller_email: 'ds.b@cms.example.test' }),
  IN(7, { seller_email: 'ds.c@cms.example.test' }),    // ngoài phạm vi (store 3)
  IN(8, { order_type: 'ONLINE' }),                    // không ứng viên
]

type Call = { fn: string; args: unknown[] }
type Fake = ReturnType<typeof fakeDeps>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDeps(o: Record<string, any> & { source?: CmsFixtureSource; snap?: Record<string, unknown> } = {}) {
  const calls: Call[] = []
  const log = (fn: string, ...args: unknown[]) => { calls.push({ fn, args }) }
  const clock = { t: 1_000_000 }
  const snap = o.snap ?? snapshot()
  const sealBegin = async (run: string, e: unknown, io?: unknown) => { log('sealBegin', run, io); return { ok: true, steps: 10 } }
  const sealStep = async (run: string, n: number, io?: unknown) => { log('sealStep', run, n, io); return n === 10 ? { sealed: true, step: 10 } : { ok: true, step: n } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    table: 'qa-project.dataset.cms_sales',
    runner: createCmsFixtureRunner(o.source ?? { sales: SALES }),
    loadSnapshot: async (id: string, io?: unknown) => { log('loadSnapshot', id, io); return snap },
    openRun: async (id: string, d: unknown, io?: unknown) => { log('openRun', id, d, io); return { ...snap, run_id: uid(99) } },
    stage: async (run: string, part: string, no: number, rows: unknown[], io?: unknown) => { log('stage', run, part, no, rows.length, io); return rows.length },
    sealBegin, sealStep,
    publish: async (run: string, io?: unknown) => { log('publish', run, io); return { published: true, already: false } },
    finish: async (run: string, st: string, d: unknown, io?: unknown) => { log('finish', run, st, d, io) },
    cleanup: async (id: string, maxRows?: number, io?: unknown) => { log('cleanup', id, maxRows, io); return { purged: 0, deleted: 0, more: false } },
    now: () => (clock.t += 10),
    ...o,
  }
  // Giao diện cũ (r2.1): seal một hàm + cleanup(programId) — chỉ để chạy chứng minh trên bản cũ.
  deps.seal ??= (run: string, e: unknown) => runCmsSealSteps({ begin: () => deps.sealBegin(run, e), step: (n: number) => deps.sealStep(run, n) })
  return { deps: deps as S.CmsSalesSyncDeps & CmsSalesCronDeps, calls, clock, fns: () => calls.map((c) => c.fn) }
}
const WRITE_FNS = ['openRun', 'stage', 'sealBegin', 'sealStep', 'publish', 'finish', 'cleanup']
const finishes = (f: Fake) => f.calls.filter((c) => c.fn === 'finish')

test.describe('CMS P2-b — salesSync @desktop', () => {
  test('cổng tách (PM 06/11 sales-only AC01): kết quả bán SALES_ONLY_V1 mở cho chương trình thật; trả hàng vẫn HOLD (không APPROVED)', () => {
    expect(CMS_RESULTS_RELEASE_MODE).toBe('SALES_ONLY_V1')
    expect(CMS_Q206_RETURNS_CONTRACT).toBe('HOLD')
    expect(cmsCanPublishResults(false)).toBe(true)
    expect(cmsCanPublishResults(true)).toBe(true)
    // Chế độ HOLD (trước 126 / nhánh test) vẫn chặn chương trình thật, QA luôn được.
    expect(cmsCanPublishResults(false, 'HOLD')).toBe(false)
    expect(cmsCanPublishResults(true, 'HOLD')).toBe(true)
    // Dòng điều chỉnh: chặn chương trình thật khi trả hàng chưa APPROVED; QA không chặn.
    expect(cmsAdjustmentBlocksRelease(false)).toBe(true)
    expect(cmsAdjustmentBlocksRelease(true)).toBe(false)
    expect(cmsAdjustmentBlocksRelease(false, 'APPROVED')).toBe(false)
    expect(CMS_RETURNS_NOT_SUPPORTED).toBe('RETURNS_NOT_SUPPORTED_THIS_PHASE')
  })

  test('dry-run: chỉ đọc snapshot + nguồn, 0 lệnh ghi; hash ổn định khi đổi thứ tự nguồn', async () => {
    const a = fakeDeps()
    const r = await runCmsSalesSync(a.deps, PROG, { dryRun: true, source: 'operator' })
    expect([r.status, r.code]).toEqual(['dry_run', null])
    expect(a.fns()).toEqual(['loadSnapshot'])
    expect(a.fns().some((f) => WRITE_FNS.includes(f))).toBe(false)
    expect(r.resultHash).toMatch(/^[0-9a-f]{64}$/)
    expect({ read: r.rowsRead, cand: r.candidates, inc: r.included, oos: r.outOfScope }).toEqual({ read: 8, cand: 7, inc: 6, oos: 1 })
    const b = fakeDeps({ source: { sales: [...SALES].reverse() } })
    const r2 = await runCmsSalesSync(b.deps, PROG, { dryRun: true, source: 'operator' })
    expect([r2.resultHash, r2.amountVnd]).toEqual([r.resultHash, r.amountVnd])
    const c = fakeDeps({ source: { sales: SALES.map((x) => (x.order_line_id === 'L-001' ? { ...x, base_quantity: '25' } : x)) } })
    expect((await runCmsSalesSync(c.deps, PROG, { dryRun: true, source: 'operator' })).resultHash).not.toBe(r.resultHash)
  })

  test('QA (is_test): open → stage theo khối liên tục → seal begin + 10 bước → publish → dọn', async () => {
    const f = fakeDeps()
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'qa', chunkSize: 2 })
    expect([r.status, r.code, r.runId]).toEqual(['published', null, uid(99)])
    const stages = f.calls.filter((c) => c.fn === 'stage').map((c) => [c.args[1], c.args[2]] as [CmsStagePart, number])
    const order = stages.map(([p]) => p).filter((p, i, a) => a.indexOf(p) === i)
    expect(order).toEqual(CMS_STAGE_PARTS.filter((p) => stages.some(([q]) => q === p)))
    for (const part of order) expect(stages.filter(([p]) => p === part).map(([, n]) => n)).toEqual(stages.filter(([p]) => p === part).map((_, i) => i))
    expect(f.calls.filter((c) => c.fn === 'sealStep').map((c) => c.args[1])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(f.fns().slice(-3)).toEqual(['sealStep', 'publish', 'cleanup'])
    expect(f.fns()).not.toContain('finish')
    const expectArg = f.calls.find((c) => c.fn === 'sealBegin')
    expect(expectArg).toBeTruthy()
    expect(r.stagedRows).toBe(f.calls.filter((c) => c.fn === 'stage').reduce((s, c) => s + (c.args[3] as number), 0))
    expect(f.calls.find((c) => c.fn === 'openRun')!.args[1]).toEqual({ source: 'qa' })
    expect(r.cleanup).toEqual({ purged: 0, more: false, calls: 1, stoppedBy: 'done' })
  })

  test('chương trình thật + cổng HOLD (releaseHold — nhánh test): lượt ghi bị chặn TRƯỚC openRun — 0 run, 0 ghi, 0 truy vấn nguồn (PM 03/11 REL-P1-1)', async () => {
    for (const source of ['operator', 'cron', 'qa'] as const) {
      let queries = 0
      const f = fakeDeps({ snap: snapshot({ is_test: false }) })
      const inner = f.deps.runner
      f.deps.runner = async (...a) => { queries++; return inner(...a) }
      const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source, releaseHold: true })
      const want = source === 'qa' ? S.CMS_QA_SOURCE_REAL_PROGRAM : 'RESULTS_RELEASE_GATE'
      expect([r.status, r.code, r.runId, r.isTest, r.stagedRows, r.cleanup]).toEqual(['held', want, null, false, 0, null])
      expect(f.fns()).toEqual(['loadSnapshot'])
      expect(queries).toBe(0)
      expect(cmsSalesExitCode(r)).toBe(1)
    }
    // Dry-run thật vẫn đọc nguồn + engine như cũ (đối soát trước khi mở cổng), không ghi.
    const d = fakeDeps({ snap: snapshot({ is_test: false }) })
    const dr = await runCmsSalesSync(d.deps, PROG, { dryRun: true, source: 'operator' })
    expect([dr.status, dr.code, d.fns()]).toEqual(['dry_run', null, ['loadSnapshot']])
    // Snapshot đọc trước lỗi / chương trình không còn / sai shape / lệch id ⇒ không mở run.
    for (const [loadSnapshot, want] of [
      [async () => { throw new Error('CMS_PROGRAM_NOT_FOUND') }, ['skipped', 'CMS_PROGRAM_NOT_FOUND']],
      [async () => { throw new Error('boom') }, ['error', 'SNAPSHOT_FAILED']],
      [async () => ({ program_id: PROG }), ['error', 'SNAPSHOT_INVALID']],
      [async () => snapshot({ program_id: uid(2) }), ['error', 'SNAPSHOT_INVALID']],
    ] as const) {
      const g = fakeDeps({ loadSnapshot })
      const r = await runCmsSalesSync(g.deps, PROG, { dryRun: false, source: 'operator', releaseHold: true })
      expect([r.status, r.code, r.runId]).toEqual([...want, null])
      expect(g.fns().some((x) => WRITE_FNS.includes(x))).toBe(false)
    }
  })

  test('lớp thứ hai giữ nguyên (cổng HOLD): snapshot của openRun là chương trình thật ⇒ held RESULTS_RELEASE_GATE trước stage, đóng run', async () => {
    const f = fakeDeps({ openRun: async (id: string) => ({ ...snapshot({ is_test: false }), program_id: id, run_id: uid(99) }) })
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'operator', releaseHold: true })
    expect([r.status, r.code, r.stagedRows]).toEqual(['held', 'RESULTS_RELEASE_GATE', 0])
    // openRun bị thay (không ghi log) — dãy gọi: snapshot đọc trước (QA) → [openRun] → finish → cleanup; không stage / publish.
    expect(f.fns()).toEqual(['loadSnapshot', 'finish', 'cleanup'])
    expect((finishes(f)[0].args[2] as Record<string, unknown>).error_code).toBe('RESULTS_RELEASE_GATE')
  })

  test('sales-only AC03: chương trình thật (cron / operator) open → stage → seal 10 bước → publish → dọn; không snapshot đọc trước', async () => {
    for (const source of ['cron', 'operator'] as const) {
      const f = fakeDeps({ snap: snapshot({ is_test: false }) })
      const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source, chunkSize: 3 })
      expect([r.status, r.code, r.isTest, r.runId]).toEqual(['published', null, false, uid(99)])
      expect(f.fns()[0]).toBe('openRun')
      expect(f.fns()).not.toContain('loadSnapshot')
      expect(f.fns()).not.toContain('finish')
      expect(f.fns().slice(-3)).toEqual(['sealStep', 'publish', 'cleanup'])
      expect(f.calls.filter((c) => c.fn === 'sealStep').map((c) => c.args[1])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      // Cùng snapshot QA ⇒ cùng tiền / hash (chương trình thật không tính khác).
      const q = await runCmsSalesSync(fakeDeps().deps, PROG, { dryRun: false, source: 'qa', chunkSize: 3 })
      expect([r.amountVnd, r.resultHash]).toEqual([q.amountVnd, q.resultHash])
    }
    // AC06 replay: chạy lại cùng tập nguồn ⇒ snapshot đầy đủ cùng hash / tiền (tính lại, không cộng dồn vào snapshot cũ).
    const a = await runCmsSalesSync(fakeDeps({ snap: snapshot({ is_test: false }) }).deps, PROG, { dryRun: false, source: 'cron' })
    const b = await runCmsSalesSync(fakeDeps({ snap: snapshot({ is_test: false, previous_rows_read: 8 }) }).deps, PROG, { dryRun: false, source: 'cron' })
    expect([b.status, b.amountVnd, b.resultHash]).toEqual(['published', a.amountVnd, a.resultHash])
  })

  test('sales-only AC05: chương trình thật có dòng ứng viên âm ⇒ held RETURNS_NOT_SUPPORTED_THIS_PHASE, 0 stage / publish, không công bố riêng phần dương', async () => {
    const NEG_INC = IN(9, { base_quantity: '-24', gmv_amount: '-50000' })                                       // ADJUSTMENT (INCLUDED)
    const NEG_UNA = IN(9, { base_quantity: '-1', gmv_amount: '-10000', seller_email: 'khong.co@cms.example.test' }) // ứng viên chưa gán
    const NEG_GMV = IN(9, { gmv_amount: '-1' })                                                                 // chỉ GMV âm
    const NEG_OFF = IN(9, { base_quantity: '-24', order_type: 'ONLINE' })                                       // KHÔNG ứng viên
    for (const [neg, n] of [[NEG_INC, 1], [NEG_UNA, 1], [NEG_GMV, 1]] as const) {
      const f = fakeDeps({ snap: snapshot({ is_test: false }), source: { sales: [...SALES, neg] } })
      const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron' })
      expect([r.status, r.code, r.stagedRows]).toEqual(['held', CMS_RETURNS_NOT_SUPPORTED, 0])
      expect(f.fns()).toEqual(['openRun', 'finish', 'cleanup'])
      const d = finishes(f)[0].args[2] as Record<string, unknown>
      expect([finishes(f)[0].args[1], d.error_code, d.adjustment_lines]).toEqual(['held', CMS_RETURNS_NOT_SUPPORTED, n])
      expect(cmsSalesExitCode(r)).toBe(1)
      // Dry-run operator báo đúng mã (rc 1), không ghi.
      const g = fakeDeps({ snap: snapshot({ is_test: false }), source: { sales: [...SALES, neg] } })
      const dr = await runCmsSalesSync(g.deps, PROG, { dryRun: true, source: 'operator' })
      expect([dr.status, dr.code, g.fns()]).toEqual(['dry_run', CMS_RETURNS_NOT_SUPPORTED, ['loadSnapshot']])
      expect(cmsSalesExitCode(dr)).toBe(1)
    }
    // Dòng âm KHÔNG phải ứng viên (ONLINE) ⇒ phân loại / loại như trước, công bố bình thường.
    const o = fakeDeps({ snap: snapshot({ is_test: false }), source: { sales: [...SALES, NEG_OFF] } })
    expect((await runCmsSalesSync(o.deps, PROG, { dryRun: false, source: 'cron' })).status).toBe('published')
    // QA (is_test): fixture điều chỉnh vẫn công bố được trong namespace test.
    const qa = fakeDeps({ source: { sales: [...SALES, NEG_INC] } })
    expect((await runCmsSalesSync(qa.deps, PROG, { dryRun: false, source: 'qa' })).status).toBe('published')
  })

  test('sales-only AC08: nguồn qa trỏ vào chương trình thật ⇒ held QA_SOURCE_REAL_PROGRAM — trước open 0 run / 0 nguồn; sau open đóng run, 0 stage', async () => {
    let queries = 0
    const f = fakeDeps({ snap: snapshot({ is_test: false }) })
    const inner = f.deps.runner
    f.deps.runner = async (...a) => { queries++; return inner(...a) }
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'qa' })
    expect([r.status, r.code, r.runId, f.fns(), queries]).toEqual(['held', S.CMS_QA_SOURCE_REAL_PROGRAM, null, ['loadSnapshot'], 0])
    // Snapshot đọc trước là QA nhưng run vừa mở là chương trình thật (đổi namespace giữa hai lần đọc) ⇒ đóng run, không đọc nguồn.
    const g = fakeDeps({ openRun: async (id: string) => ({ ...snapshot({ is_test: false }), program_id: id, run_id: uid(99) }) })
    const inner2 = g.deps.runner
    let q2 = 0
    g.deps.runner = async (...a) => { q2++; return inner2(...a) }
    const r2 = await runCmsSalesSync(g.deps, PROG, { dryRun: false, source: 'qa' })
    expect([r2.status, r2.code, r2.stagedRows, q2]).toEqual(['held', S.CMS_QA_SOURCE_REAL_PROGRAM, 0, 0])
    expect(g.fns()).toEqual(['loadSnapshot', 'finish', 'cleanup'])
  })

  test('PM 03/11 QA-P1-1: snapshot đọc trước (nguồn qa) tiêu hết ngân sách ⇒ held DEADLINE, KHÔNG mở run', async () => {
    const f = fakeDeps()
    const loadSnap = f.deps.loadSnapshot
    f.deps.loadSnapshot = async (id, io) => { f.clock.t += 150_000; return loadSnap(id, io) }
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'qa', deadlineAt: f.clock.t + 100_000 })
    expect([r.status, r.code, r.runId]).toEqual(['held', 'DEADLINE', null])
    expect(f.fns()).toEqual(['loadSnapshot'])
  })

  test('open: bận / chưa đủ điều kiện / lỗi; thiếu cấu hình không gọi gì', async () => {
    for (const [msg, status] of [['CMS_SYNC_BUSY', 'busy'], ['CMS_SALES_NOT_STARTED', 'skipped'], ['CMS_PROGRAM_LOCKED', 'skipped'],
      ['CMS_SALES_PROGRAM_NOT_ACTIVE', 'skipped'], ['boom', 'error']] as const) {
      const f = fakeDeps({ openRun: async () => { throw new Error(msg) } })
      const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron' })
      expect([r.status, r.code], msg).toEqual([status, msg === 'boom' ? 'OPEN_FAILED' : msg])
      expect(f.fns()).not.toContain('finish')
    }
    const n = fakeDeps({ table: null })
    expect((await runCmsSalesSync(n.deps, PROG, { dryRun: false, source: 'cron' })).status).toBe('config_missing')
    expect(n.calls).toEqual([])
  })

  const heldCase = async (name: string, o: Parameters<typeof fakeDeps>[0], status: 'held' | 'error', code: string) => {
    const f = fakeDeps(o)
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron' })
    expect([r.status, r.code], name).toEqual([status, code])
    expect(f.fns(), name).not.toContain('stage')
    expect(f.fns(), name).not.toContain('publish')
    expect(finishes(f).length, name).toBe(1)
    expect([finishes(f)[0].args[1], (finishes(f)[0].args[2] as Record<string, unknown>).error_code], name).toEqual([status, code])
    expect(f.fns().at(-1), name).toBe('cleanup')
    return r
  }

  test('nguồn / chất lượng: held hoặc error, đóng run một lần, không stage, giữ pointer', async () => {
    await heldCase('nguồn lỗi', { source: { fail: new BigQueryError('http', 'x', 503) } }, 'error', 'SOURCE_SOURCE_ERROR')
    await heldCase('vượt trần', { source: { fail: new BigQueryError('row_limit', 'x') } }, 'held', 'SOURCE_OVER_CAP')
    await heldCase('thiếu trang', { source: { sales: SALES, totalRowsDelta: 3 } }, 'held', 'SOURCE_INCOMPLETE_PAGES')
    await heldCase('thiếu cột', { source: { sales: SALES, dropFields: ['base_quantity'] } }, 'error', 'SOURCE_SCHEMA_MISMATCH')
    await heldCase('chưa quy đổi', { source: { sales: [...SALES, IN(9, { base_quantity: '1.0000000001' })] } }, 'held', 'UNCONVERTED_UNITS')
    await heldCase('trùng order_line_id', { source: { sales: [...SALES, IN(1)] } }, 'held', 'DUPLICATE_LINE_ID')
    const r = await heldCase('chưa gán > 20 %', { source: { sales: [...SALES, IN(10, { seller_email: 'la@x.test' }), IN(11, { seller_email: 'qlch@cms.example.test' })] } }, 'held', 'UNASSIGNED_OVER_THRESHOLD')
    expect(r.unassigned).toBe(2)
    await heldCase('rỗng sau khi đã có dữ liệu', { source: { sales: [] }, snap: snapshot({ previous_rows_read: 12 }) }, 'held', 'EMPTY_AFTER_DATA')
    await heldCase('snapshot hỏng (còn run_id ⇒ vẫn đóng run)', { openRun: async () => ({ run_id: uid(98), program_id: PROG }) }, 'error', 'SNAPSHOT_INVALID')
    await heldCase('snapshot của chương trình khác', { openRun: async () => ({ ...snapshot({ program_id: uid(2) }), run_id: uid(98) }) }, 'error', 'SNAPSHOT_INVALID')
    await heldCase('cấu hình bậc hở', { snap: snapshot({ products: [{ id: PP.p1, product_id: '900001', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '24', tiers: [{ order: 1, from: 2, to: null, amount: '1' }] }] }) }, 'error', 'CONFIG_INVALID')
  })

  test('chưa từng có dữ liệu + nguồn rỗng ⇒ publish snapshot rỗng hợp lệ (không held)', async () => {
    const r = await runCmsSalesSync(fakeDeps({ source: { sales: [] } }).deps, PROG, { dryRun: false, source: 'qa' })
    expect([r.status, r.amountVnd]).toEqual(['published', '0'])
  })

  test('stage / seal / publish lỗi: mã đúng, đóng run đúng một lần (seal / publish tự đóng thì không đóng lại)', async () => {
    const s1 = fakeDeps({ stage: async () => { throw new Error('CMS_STAGE_BAD_ROW') } })
    const r1 = await runCmsSalesSync(s1.deps, PROG, { dryRun: false, source: 'qa' })
    expect([r1.status, r1.code, finishes(s1).length]).toEqual(['error', 'CMS_STAGE_BAD_ROW', 1])
    const s2 = fakeDeps({ stage: async (_r: string, _p: string, _n: number, rows: unknown[]) => rows.length - 1 })
    expect((await runCmsSalesSync(s2.deps, PROG, { dryRun: false, source: 'qa' })).code).toBe('STAGE_COUNT_MISMATCH')
    const s3 = fakeDeps({ sealStep: async (_r: string, n: number) => (n === 10 ? { sealed: false, status: 'error', code: 'SEAL_TOTAL' } : { ok: true }) })
    const r3 = await runCmsSalesSync(s3.deps, PROG, { dryRun: false, source: 'qa' })
    expect([r3.status, r3.code, finishes(s3).length, s3.fns().includes('publish')]).toEqual(['error', 'SEAL_TOTAL', 0, false])
    const s4 = fakeDeps({ sealBegin: async () => ({ sealed: false, status: 'held', code: 'MAPPING_CHANGED' }) })
    const r4 = await runCmsSalesSync(s4.deps, PROG, { dryRun: false, source: 'qa' })
    expect([r4.status, r4.code, finishes(s4).length]).toEqual(['held', 'MAPPING_CHANGED', 0])
    const s5 = fakeDeps({ sealBegin: async () => { throw new Error('CMS_SEAL_BAD_EXPECT') } })
    const r5 = await runCmsSalesSync(s5.deps, PROG, { dryRun: false, source: 'qa' })
    expect([r5.status, r5.code, finishes(s5).length]).toEqual(['error', 'CMS_SEAL_BAD_EXPECT', 1])
    const s6 = fakeDeps({ sealStep: async () => ({ ok: true }) })     // không bao giờ sealed ⇒ SEAL_INCOMPLETE, app đóng run
    const r6 = await runCmsSalesSync(s6.deps, PROG, { dryRun: false, source: 'qa' })
    expect([r6.status, r6.code, finishes(s6).length]).toEqual(['error', 'SEAL_INCOMPLETE', 1])
    const p3 = fakeDeps({ publish: async () => ({ published: false, code: 'CONFIG_CHANGED' }) })
    const rp3 = await runCmsSalesSync(p3.deps, PROG, { dryRun: false, source: 'qa' })
    expect([rp3.status, rp3.code, finishes(p3).length, p3.fns().at(-1)]).toEqual(['held', 'CONFIG_CHANGED', 0, 'cleanup'])
    const c1 = fakeDeps({ cleanup: async () => { throw new Error('x') } })
    const rc = await runCmsSalesSync(c1.deps, PROG, { dryRun: false, source: 'qa' })
    expect([rc.status, rc.cleanup?.stoppedBy, rc.cleanup?.more]).toEqual(['published', 'failed', true])
  })

  test('publish đã gửi nhưng mất phản hồi: gọi lại một lần; vẫn không rõ ⇒ PUBLISH_UNKNOWN, KHÔNG đóng run / không held', async () => {
    let n = 0
    const p1 = fakeDeps({ publish: async () => { if (n++ === 0) throw new Error('timeout'); return { published: true, already: true } } })
    const rp1 = await runCmsSalesSync(p1.deps, PROG, { dryRun: false, source: 'qa' })
    expect([rp1.status, n, finishes(p1).length]).toEqual(['published', 2, 0])
    const p2 = fakeDeps({ publish: async () => { throw new Error('timeout') } })
    const rp2 = await runCmsSalesSync(p2.deps, PROG, { dryRun: false, source: 'qa' })
    expect([rp2.status, rp2.code, finishes(p2).length]).toEqual(['error', 'PUBLISH_UNKNOWN', 0])
  })

  test('đóng run thất bại ⇒ CLOSE_FAILED + cause, không báo thành công giả', async () => {
    const f = fakeDeps({ source: { fail: new BigQueryError('http', 'x', 500) }, finish: async () => { throw new Error('x') } })
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron' })
    expect([r.status, r.code, r.cause]).toEqual(['error', 'CLOSE_FAILED', { status: 'error', code: 'SOURCE_SOURCE_ERROR' }])
    expect(cmsSalesExitCode(r)).toBe(1)
  })

  test('seal tách bước: begin lỗi / bước lỗi dừng ngay; đủ 10 bước ⇒ sealed; canContinue false ⇒ DEADLINE (app đóng run)', async () => {
    const calls: string[] = []
    const mk = (failAt: number | null, beginFail = false, stopAt: number | null = null) => ({
      begin: async () => { calls.push('b'); return beginFail ? { sealed: false, status: 'error', code: 'SEAL_COUNT_MISMATCH' } : { ok: true } },
      step: async (k: number) => { calls.push(`s${k}`); if (k === failAt) return { sealed: false, status: 'error', code: 'SEAL_GATE' }; return k === 10 ? { sealed: true } : { ok: true } },
      canContinue: () => stopAt === null || !calls.includes(`s${stopAt}`),
    })
    expect(await runCmsSealSteps(mk(null))).toEqual({ sealed: true, closed: false })
    expect(calls).toEqual(['b', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'])
    calls.length = 0
    expect(await runCmsSealSteps(mk(8))).toEqual({ sealed: false, status: 'error', code: 'SEAL_GATE', closed: true })
    calls.length = 0
    expect(await runCmsSealSteps(mk(null, true))).toEqual({ sealed: false, status: 'error', code: 'SEAL_COUNT_MISMATCH', closed: true })
    calls.length = 0
    expect(await runCmsSealSteps(mk(null, false, 4))).toEqual({ sealed: false, status: 'held', code: 'DEADLINE', closed: false })
    expect(calls.at(-1)).toBe('s4')
    expect((await runCmsSealSteps({ begin: async () => ({ ok: true }), step: async () => ({ ok: true }) })).code).toBe('SEAL_INCOMPLETE')
  })

  test('mã thoát script + trích mã RPC', () => {
    expect(cmsSalesExitCode({ status: 'published', code: null })).toBe(0)
    expect(cmsSalesExitCode({ status: 'dry_run', code: null })).toBe(0)
    expect(cmsSalesExitCode({ status: 'dry_run', code: 'UNCONVERTED_UNITS' })).toBe(1)
    expect(cmsSalesExitCode({ status: 'held', code: 'RESULTS_RELEASE_GATE' })).toBe(1)
    expect(cmsSalesExitCode({ status: 'config_missing', code: 'CONFIG_MISSING' })).toBe(2)
    expect(cmsRpcCode(new Error('ERROR: CMS_SYNC_BUSY (P0001)'), 'X')).toBe('CMS_SYNC_BUSY')
    expect(cmsRpcCode(new Error('password=abc'), 'X')).toBe('X')
  })
})

// ── Ngân sách (PM audit 03/11 P1-I2-1) — mỗi ca ĐỎ trên bản r2.1 (chứng minh: dev-tools/cms/r21-deadline-proof.cjs) ──
test.describe('CMS P2-b — ngân sách deadline @desktop', () => {
  const T0 = 1_000_000
  const DEADLINE = T0 + 60_000
  const WORK_UNTIL = DEADLINE - CMS_SALES_STOP_RESERVE_MS
  // Đồng hồ tĩnh (không tự tăng) — mỗi ca tự đẩy giờ ở đúng bước.
  const fixed = (o: Record<string, unknown> = {}) => { const f = fakeDeps(o); f.clock.t = T0; f.deps.now = () => f.clock.t; return f }

  test('khối stage CUỐI làm hết ngân sách ⇒ KHÔNG seal / publish; held DEADLINE (đóng run bằng phần dự phòng)', async () => {
    const f = fixed()
    const stage = f.deps.stage
    f.deps.stage = async (run, part, no, rows, io) => { const n = await stage(run, part, no, rows, io); if (part === 'result_lines') f.clock.t = WORK_UNTIL + 1; return n }
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([r.status, r.code]).toEqual(['held', 'DEADLINE'])
    expect(f.fns().filter((x) => x === 'sealBegin' || x === 'sealStep' || x === 'seal' || x === 'publish')).toEqual([])
    expect(finishes(f).length).toBe(1)
  })

  test('hết ngân sách GIỮA các bước seal ⇒ dừng trước bước kế, held DEADLINE', async () => {
    const f = fixed()
    const step = f.deps.sealStep
    f.deps.sealStep = async (run, n, io) => { const r = await step(run, n, io); if (n === 3) f.clock.t = WORK_UNTIL; return r }
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([r.status, r.code]).toEqual(['held', 'DEADLINE'])
    expect(f.calls.filter((c) => c.fn === 'sealStep').map((c) => c.args[1])).toEqual([1, 2, 3])
    expect(f.fns()).not.toContain('publish')
    expect(finishes(f).length).toBe(1)
  })

  test('hết ngân sách sau seal, TRƯỚC publish ⇒ không publish, held DEADLINE', async () => {
    const f = fixed()
    const step = f.deps.sealStep
    f.deps.sealStep = async (run, n, io) => { const r = await step(run, n, io); if (n === 10) f.clock.t = WORK_UNTIL + 5; return r }
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([r.status, r.code, f.fns().includes('publish'), finishes(f).length]).toEqual(['held', 'DEADLINE', false, 1])
  })

  test('cleanup chậm: dừng khi hết hạn cứng, báo more + budget (không chạy tiếp lô sau hạn)', async () => {
    const f = fixed({ cleanup: async () => { f.clock.t += 20_000; return { purged: 0, deleted: 50_000, more: true } } })
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect(r.status).toBe('published')
    expect(r.cleanup!.more).toBe(true)
    expect(r.cleanup!.stoppedBy).toBe('budget')
    expect(r.cleanup!.calls).toBeLessThanOrEqual(3)
    expect(f.clock.t).toBeLessThan(DEADLINE + 20_000)
  })

  test('cleanup nhanh nhưng còn việc mãi ⇒ dừng ở số lần tối đa (không vô hạn), báo more', async () => {
    const f = fixed({ cleanup: async () => ({ purged: 1, deleted: 10, more: true }) })
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([r.cleanup!.stoppedBy, r.cleanup!.calls, r.cleanup!.more]).toEqual(['max_calls', S.CMS_CLEANUP_MAX_CALLS, true])
  })

  test('elapsedMs GỒM cleanup', async () => {
    const f = fixed({ cleanup: async () => { f.clock.t += 1000; return { purged: 1, deleted: 5, more: false } } })
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'qa', deadlineAt: DEADLINE })
    // Đồng hồ tĩnh: chỉ cleanup đẩy giờ ⇒ elapsed đúng bằng phần cleanup (r2.1: 0).
    expect(r.elapsedMs).toBe(1000)
  })

  test('timeout RPC = min(60 s, ngân sách còn lại); đóng run dùng phần dự phòng', async () => {
    const f = fixed()
    f.clock.t = WORK_UNTIL - 12_000
    const stage = f.deps.stage
    f.deps.stage = async (run, part, no, rows, io) => { const n = await stage(run, part, no, rows, io); f.clock.t = WORK_UNTIL + 1; return n }
    await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    const st = f.calls.find((c) => c.fn === 'stage')!.args[4] as S.CmsIo
    const fin = finishes(f)[0].args[3] as S.CmsIo
    expect(st.timeoutMs).toBeLessThanOrEqual(12_000)
    expect(fin.timeoutMs).toBeLessThanOrEqual(CMS_SALES_STOP_RESERVE_MS)
    expect(fin.timeoutMs).toBeGreaterThan(0)
    const g = fakeDeps()
    await runCmsSalesSync(g.deps, PROG, { dryRun: false, source: 'qa' })
    expect((g.calls.find((c) => c.fn === 'stage')!.args[4] as S.CmsIo).timeoutMs).toBe(CMS_RPC_TIMEOUT_MAX_MS)
  })

  test('hết ngân sách ngay từ đầu ⇒ không mở run', async () => {
    const f = fixed()
    f.clock.t = WORK_UNTIL
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([r.status, r.code, f.calls.length]).toEqual(['held', 'DEADLINE', 0])
  })
})

// ── r2.2 soát nội bộ (pm-auditor L1…L6) — tách khỏi nhóm "ngân sách deadline" để bằng chứng r2.1 (9/9 đỏ) giữ nguyên ──
test.describe('CMS P2-b — r2.2 publish / cửa sổ bắt đầu / phân loại huỷ @desktop', () => {
  const T0 = 1_000_000
  const DEADLINE = T0 + 60_000
  const WORK_UNTIL = DEADLINE - CMS_SALES_STOP_RESERVE_MS
  const { CMS_RPC_START_MIN_MS, CMS_RPC_TIMEOUT_MIN_MS } = S
  const fixed = (o: Record<string, unknown> = {}) => { const f = fakeDeps(o); f.clock.t = T0; f.deps.now = () => f.clock.t; return f }
  const pubs = (f: Fake) => f.calls.filter((c) => c.fn === 'publish')

  // publish giả ghi lại io của từng lần gọi (pubs đếm qua log chung).
  const pubFake = (f: () => Fake, impl: (n: number) => unknown) => {
    let n = 0
    return async (run: string, io: S.CmsIo) => { f().calls.push({ fn: 'publish', args: [run, io] }); return impl(n++) }
  }

  test('L1: publish nhận mã CMS_* = từ chối xác định ⇒ báo đúng mã, KHÔNG gọi lại; run còn running ⇒ đóng error', async () => {
    const a: Fake = fixed()
    a.deps.publish = pubFake(() => a, () => { throw new Error('CMS_RESULT_NOT_SEALED') }) as S.CmsSalesSyncDeps['publish']
    const ra = await runCmsSalesSync(a.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([ra.status, ra.code, pubs(a).length, finishes(a).length, finishes(a)[0]?.args[1]]).toEqual(['error', 'CMS_RESULT_NOT_SEALED', 1, 1, 'error'])
    // Run không còn running (đã đóng ở nơi khác) ⇒ không đóng lần hai.
    const b: Fake = fixed()
    b.deps.publish = pubFake(() => b, () => { throw new Error('CMS_SYNC_RUN_NOT_RUNNING') }) as S.CmsSalesSyncDeps['publish']
    const rb = await runCmsSalesSync(b.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([rb.status, rb.code, pubs(b).length, finishes(b).length]).toEqual(['error', 'CMS_SYNC_RUN_NOT_RUNNING', 1, 0])
  })

  test('L1: lần đầu không nhận được phản hồi rồi lần gọi lại nhận mã CMS_* ⇒ chắc chắn chưa công bố, báo mã, không đóng run', async () => {
    let n = 0
    const f = fixed({ publish: async () => { if (n++ === 0) throw new Error('PUBLISH_FAILED'); throw new Error('CMS_SYNC_RUN_NOT_RUNNING') } })
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([r.status, r.code, n, finishes(f).length]).toEqual(['error', 'CMS_SYNC_RUN_NOT_RUNNING', 2, 0])
  })

  test('L5: publish bắt đầu trước mốc làm việc, không nhận được phản hồi sau mốc ⇒ gọi lại bằng phần dự phòng; sau hạn cứng ⇒ timeout tối thiểu, không đóng run', async () => {
    const f: Fake = fixed()
    f.deps.publish = pubFake(() => f, (n) => {
      if (n === 0) { f.clock.t = WORK_UNTIL + 2_000; throw new Error('PUBLISH_FAILED') }
      return { published: true, already: true }
    }) as S.CmsSalesSyncDeps['publish']
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    const [first, second] = pubs(f).map((c) => (c.args[1] as S.CmsIo).timeoutMs)
    expect([r.status, pubs(f).length, finishes(f).length]).toEqual(['published', 2, 0])
    expect(first).toBeGreaterThanOrEqual(CMS_RPC_START_MIN_MS)
    expect(second).toBe(DEADLINE - (WORK_UNTIL + 2_000))
    const g: Fake = fixed()
    g.deps.publish = pubFake(() => g, () => { g.clock.t = DEADLINE + 5_000; throw new Error('PUBLISH_FAILED') }) as S.CmsSalesSyncDeps['publish']
    const rg = await runCmsSalesSync(g.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([rg.status, rg.code, pubs(g).length, finishes(g).length]).toEqual(['error', 'PUBLISH_UNKNOWN', 2, 0])
    expect((pubs(g)[1].args[1] as S.CmsIo).timeoutMs).toBe(CMS_RPC_TIMEOUT_MIN_MS)
  })

  test('cửa sổ bắt đầu: còn < CMS_RPC_START_MIN_MS trước mốc làm việc ⇒ không bắt đầu khối / bước seal / publish mới', async () => {
    const f = fixed()
    const open = f.deps.openRun
    f.deps.openRun = async (id, d, io) => { const s = await open(id, d, io); f.clock.t = WORK_UNTIL - CMS_RPC_START_MIN_MS + 1; return s }
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([r.status, r.code, f.fns().includes('stage'), finishes(f).length]).toEqual(['held', 'DEADLINE', false, 1])
    // Đủ cửa sổ ⇒ timeout của RPC làm việc không dưới cửa sổ (không tự huỷ RPC hợp lệ).
    const g = fixed()
    const open2 = g.deps.openRun
    g.deps.openRun = async (id, d, io) => { const s = await open2(id, d, io); g.clock.t = WORK_UNTIL - CMS_RPC_START_MIN_MS; return s }
    await runCmsSalesSync(g.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect((g.calls.find((c) => c.fn === 'stage')!.args[4] as S.CmsIo).timeoutMs).toBe(CMS_RPC_START_MIN_MS)
  })

  test('L2: RPC bị huỷ (không mã) khi ngân sách đã hết ⇒ held DEADLINE; có mã CMS_* ⇒ error đúng mã', async () => {
    const st = fixed({ stage: async () => { st.clock.t = WORK_UNTIL + 1; throw new Error('STAGE_FAILED') } })
    const rs = await runCmsSalesSync(st.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([rs.status, rs.code, finishes(st)[0]?.args[1]]).toEqual(['held', 'DEADLINE', 'held'])
    const sc = fixed({ stage: async () => { sc.clock.t = WORK_UNTIL + 1; throw new Error('CMS_STAGE_CHUNK_CONFLICT') } })
    const rc = await runCmsSalesSync(sc.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([rc.status, rc.code]).toEqual(['error', 'CMS_STAGE_CHUNK_CONFLICT'])
    const se = fixed({ sealStep: async (_r: string, n: number) => { if (n === 4) { se.clock.t = WORK_UNTIL + 1; throw new Error('SEAL_FAILED') } return { ok: true, step: n } } })
    const re = await runCmsSalesSync(se.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([re.status, re.code, se.fns().includes('publish'), finishes(se).length]).toEqual(['held', 'DEADLINE', false, 1])
    // Còn ngân sách mà RPC lỗi không mã ⇒ vẫn là lỗi (không che lỗi thật bằng DEADLINE).
    const sx = fixed({ stage: async () => { throw new Error('STAGE_FAILED') } })
    const rx = await runCmsSalesSync(sx.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([rx.status, rx.code]).toEqual(['error', 'STAGE_FAILED'])
  })

  test('L3: cleanup chỉ bắt đầu lô khi còn ≥ cửa sổ trước hạn cứng', async () => {
    const f = fixed()
    const pub = f.deps.publish
    f.deps.publish = async (run, io) => { const p = await pub(run, io); f.clock.t = DEADLINE - CMS_RPC_START_MIN_MS + 1; return p }
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: 'cron', deadlineAt: DEADLINE })
    expect([r.status, r.cleanup, f.fns().includes('cleanup')]).toEqual(['published', { purged: 0, more: true, calls: 0, stoppedBy: 'budget' }, false])
  })
})

test.describe('CMS P2-b — cron sync-cms-sales @desktop', () => {
  const cronDeps = (programs: Array<{ id: string; lastPublishedAt: string | null }>, o: Record<string, unknown> = {}) => {
    const f = fakeDeps()
    const order: string[] = []
    const open = f.deps.openRun
    const load = f.deps.loadSnapshot
    const deps = Object.assign(f.deps, {
      openRun: async (id: string, d: S.CmsSalesRunDetail, io: S.CmsIo) => { order.push(id); return open(id, d, io).then((s) => ({ ...(s as object), program_id: id })) },
      // RPC snapshot thật trả đúng chương trình được hỏi (bước đọc trước openRun khi Q-206 HOLD kiểm id).
      loadSnapshot: async (id: string, io: S.CmsIo) => ({ ...(await load(id, io) as object), program_id: id }),
      listDuePrograms: async () => programs,
      ...o,
    }) as CmsSalesCronDeps
    return { deps, order, f }
  }

  test('cờ OFF / sai secret: không dựng deps, không query', async () => {
    let built = 0
    const make = () => { built++; return cronDeps([]).deps }
    for (const [p, e] of [[false, false], [true, false], [false, true]] as const) {
      const r = await handleSyncCmsSales({ authorization: 'Bearer s', cronSecret: 's', programEnabled: p, earningsEnabled: e, makeDeps: make })
      expect([r.status, r.body.code]).toEqual([503, 'FLAG_OFF'])
    }
    expect((await handleSyncCmsSales({ authorization: 'Bearer x', cronSecret: 's', programEnabled: true, earningsEnabled: true, makeDeps: make })).status).toBe(401)
    expect(built).toBe(0)
    const nt = await handleSyncCmsSales({ authorization: 'Bearer s', cronSecret: 's', programEnabled: true, earningsEnabled: true,
      makeDeps: () => ({ ...cronDeps([]).deps, table: null }) })
    expect([nt.status, nt.body.code]).toEqual([503, 'CONFIG_MISSING'])
    const bad = await handleSyncCmsSales({ authorization: 'Bearer s', cronSecret: 's', programEnabled: true, earningsEnabled: true,
      makeDeps: () => { throw new Error('bad table') } })
    expect([bad.status, bad.body.code]).toEqual([503, 'CONFIG_INVALID'])
  })

  test('thứ tự: chưa từng công bố trước, rồi lần công bố cũ nhất', () => {
    const o = orderDuePrograms([
      { id: 'c', lastPublishedAt: '2026-11-02T01:00:00Z' }, { id: 'a', lastPublishedAt: null },
      { id: 'b', lastPublishedAt: '2026-11-01T01:00:00Z' }, { id: 'a0', lastPublishedAt: null },
    ])
    expect(o.map((x) => x.id)).toEqual(['a', 'a0', 'b', 'c'])
  })

  test('một chương trình lỗi không chặn chương trình khác; HTTP theo kết quả; cổng đóng ⇒ bỏ qua hết', async () => {
    const P1 = uid(1), P2 = uid(2), P3 = uid(3)
    const c = cronDeps([{ id: P1, lastPublishedAt: null }, { id: P2, lastPublishedAt: null }, { id: P3, lastPublishedAt: null }])
    const open = c.deps.openRun
    c.deps.openRun = async (id, d, io) => { if (id === P2) throw new Error('CMS_SYNC_BUSY'); return open(id, d, io) }
    const s = await runCmsSalesCron(c.deps, { releaseOpen: true })
    expect(s.results.map((r) => r.status)).toEqual(['published', 'busy', 'published'])
    expect(cmsSalesCronHttpStatus(s)).toBe(207)
    expect(JSON.stringify(s)).not.toMatch(/amount|email/i)
    const e = cronDeps([{ id: P1, lastPublishedAt: null }], { stage: async () => { throw new Error('x') } })
    expect(cmsSalesCronHttpStatus(await runCmsSalesCron(e.deps, { releaseOpen: true }))).toBe(500)
    // Cổng kết quả đóng (nhánh test releaseOpen false) ⇒ bỏ qua hết TRƯỚC khi mở run, 0 ghi.
    const before = c.order.length
    const hold = await runCmsSalesCron(c.deps, { releaseOpen: false })
    expect([hold.results.every((x) => x.status === 'skipped' && x.code === 'RESULTS_RELEASE_GATE'), hold.results.length, c.order.length]).toEqual([true, 3, before])
    // Handler route không truyền releaseOpen ⇒ theo hằng releaseGate (SALES_ONLY_V1): tính + công bố CMS tạm tính.
    const h = await handleSyncCmsSales({ authorization: 'Bearer s', cronSecret: 's', programEnabled: true, earningsEnabled: true, makeDeps: () => c.deps })
    const hr = h.body.results as Array<{ status: string; code: string }>
    expect([h.status, hr.map((x) => x.status)]).toEqual([207, ['published', 'busy', 'published']])
    expect(c.order.length).toBeGreaterThan(before)
    const l = cronDeps([], { listDuePrograms: async () => { throw new Error('x') } })
    const lr = await handleSyncCmsSales({ authorization: 'Bearer s', cronSecret: 's', programEnabled: true, earningsEnabled: true, makeDeps: () => l.deps })
    expect([lr.status, lr.body.code]).toEqual([500, 'LIST_FAILED'])
  })

  test('hết ngân sách ⇒ chương trình còn lại pending (207) theo ngân sách THẬT (gồm cleanup của chương trình trước)', async () => {
    const ids = [uid(1), uid(2), uid(3)]
    const c = cronDeps(ids.map((id) => ({ id, lastPublishedAt: null })))
    let t = 0
    c.deps.now = () => t
    c.deps.cleanup = async () => { t += 80_000; return { purged: 1, deleted: 10, more: false } }   // cleanup chương trình 1 ăn ngân sách
    const s = await runCmsSalesCron(c.deps, { budgetMs: 100_000, releaseOpen: true })
    expect(s.results).toHaveLength(1)
    expect(s.pending).toEqual([uid(2), uid(3)])
    expect(c.order).toEqual([uid(1)])
    expect(s.elapsedMs).toBeGreaterThanOrEqual(80_000)
  })

  test('cleanup còn việc ⇒ cảnh báo CLEANUP_PENDING + HTTP 207; cleanup lỗi ⇒ CLEANUP_FAILED', async () => {
    const c = cronDeps([{ id: uid(1), lastPublishedAt: null }], { cleanup: async () => ({ purged: 1, deleted: 10, more: true }) })
    const s = await runCmsSalesCron(c.deps, { releaseOpen: true })
    expect([s.warnings, s.results[0].cleanupMore, cmsSalesCronHttpStatus(s)]).toEqual([['CLEANUP_PENDING'], true, 207])
    const d = cronDeps([{ id: uid(1), lastPublishedAt: null }], { cleanup: async () => { throw new Error('x') } })
    const sd = await runCmsSalesCron(d.deps, { releaseOpen: true })
    expect(sd.warnings).toEqual(['CLEANUP_PENDING', 'CLEANUP_FAILED'])
  })

  test('L6: chọn chương trình dùng timeout theo ngân sách cron; lỗi nội bộ vẫn ghi elapsedMs thật', async () => {
    let io: S.CmsIo | null = null
    let t = 0
    const c = cronDeps([{ id: uid(1), lastPublishedAt: null }], {
      listDuePrograms: async (_d: string, x: S.CmsIo) => { io = x; return [{ id: uid(1), lastPublishedAt: null }] },
      // publish trả shape sai ⇒ lỗi ngoài dự kiến trong lõi (nhánh INTERNAL của cron).
      publish: async () => { t += 500; return undefined },
    })
    c.deps.now = () => t
    const s = await runCmsSalesCron(c.deps, { budgetMs: 40_000, releaseOpen: true })
    expect(io).toEqual({ timeoutMs: 40_000 })
    expect([s.results[0].status, s.results[0].code, s.results[0].elapsedMs]).toEqual(['error', 'INTERNAL', 500])
  })
})
