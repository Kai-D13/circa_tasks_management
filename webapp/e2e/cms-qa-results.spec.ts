import { test, expect } from '@playwright/test'
import * as R from './cmsQaResults'
import { newCmsQaManifest, type CmsQaRunManifest, type CmsQaStatusRow } from './cmsQaTooling'
import { cmsQaWriterGate, CMS_QA_MARKER } from './writeQaGates'
import { createCmsFixtureRunner } from './cmsFixtureRunner'
import { cmsBudget, runCmsSalesSync, CMS_SALES_STOP_RESERVE_MS, CMS_RPC_START_MIN_MS, type CmsSalesSyncDeps } from '../lib/cms/salesSync'
import { normalizeSalesRow } from '../lib/cms/source/contract'
import { parseUtcMicros, vnDateOfMicros } from '../lib/cms/time'

// CMS — QA kết quả bằng bán GIẢ có gate (PM 03/11 REL-P1-1): sinh nguồn giả, preflight cục bộ / DB, guard trước mỗi bước ghi
// (ghép với lõi thật lib/cms/salesSync.ts + deps giả), sổ writer, đối chiếu run sales khi close, cổng cmsQaWriterGate.
// Thuần — không DB / mạng. CLI tiến trình con: scripts/qa-cms-cli-exit.mjs §6.

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROG = uid(1), S1 = uid(11), S2 = uid(12)
const A = uid(21), B = uid(22), SM = uid(23), SUPER = uid(24), QL = uid(25), REAL = uid(26)
const RUN = 'cms-qa-20261103T101500-ab12'
const HEAD = 'a'.repeat(40), TREE = 'b'.repeat(40)

function manifest(o: Partial<CmsQaRunManifest> = {}): CmsQaRunManifest {
  const m = newCmsQaManifest({
    runId: RUN, mode: 'manual-localhost', host: 'db.example.test', dbNow: '2026-11-03T10:15:00.000Z', gitHead: HEAD, gitTree: TREE,
    buildId: 'build', port: 3120, users: [
      { id: SUPER, role: 'admin', markerExpiresAt: '2026-11-03T14:00:00.000Z', remainingS: 3 * 3600 },
      { id: A, role: 'staff', markerExpiresAt: '2026-11-03T14:00:00.000Z', remainingS: 3 * 3600 },
      { id: B, role: 'staff', markerExpiresAt: '2026-11-03T14:00:00.000Z', remainingS: 3 * 3600 },
      { id: SM, role: 'sm', markerExpiresAt: '2026-11-03T14:00:00.000Z', remainingS: 3 * 3600 },
    ],
  })
  return { ...m, serverPid: 4242, launcherPid: 4241, ...o } as CmsQaRunManifest
}
const status = (over: Partial<Record<string, Partial<CmsQaStatusRow>>> = {}): CmsQaStatusRow[] =>
  [SUPER, A, B, SM].map((id) => ({
    user_id: id, user_exists: true, role: 'x', store_type: 'os', store_active: true, granted_by: 'qa-script:operator',
    granted_at: '2026-11-03 09:00:00+00', expires_at: '2026-11-03 14:00:00+00', db_now: '2026-11-03 10:30:00+00', active: true,
    remaining_s: 3 * 3600, ...(over[id] ?? {}),
  }))

function snapshot(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    program_id: PROG, status: 'active', is_test: true, config_version: 2, start_date: '2026-11-01', end_date: '2026-11-30',
    catalog_target_gmv: null, today_vn: '2026-11-03', current_result_run_id: null, previous_rows_read: null, store_ids: [S1, S2],
    products: [
      { id: uid(31), product_id: '900001', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '30', tiers: [{ order: 1, from: 1, to: null, amount: '10000' }] },
      { id: uid(32), product_id: '900002', gmv_basis: 'product', target_gmv: '200000', base_quantity_cms: '0.5', tiers: [{ order: 1, from: 1, to: 9, amount: '5000' }] },
    ],
    sellers: [
      { id: A, email: 'qa.staff.a@cms.example.test', role: 'staff', store_id: S1 },
      { id: B, email: 'qa.staff.b@cms.example.test', role: 'staff', store_id: S2 },
      { id: QL, email: 'qlch@cms.example.test', role: 'store_manager', store_id: S1 },
      { id: REAL, email: 'that.ban.that@cms.example.test', role: 'staff', store_id: S1 },
    ],
    stores: [S1, S2].map((id) => ({ id, store_type: 'os', is_active: true })),
    mapping_fp: 'c'.repeat(32), ...o,
  }
}
const fakeIn = (o: Partial<R.CmsQaFakeInput> = {}): R.CmsQaFakeInput => ({
  qaRunId: RUN, startDate: '2026-11-01', endDate: '2026-11-30', todayVn: '2026-11-03',
  products: [{ productId: '900001', baseQuantityCms: '30' }, { productId: '900002', baseQuantityCms: '0.5' }],
  staff: [{ id: A, email: 'qa.staff.a@cms.example.test' }, { id: B, email: 'qa.staff.b@cms.example.test' }],
  linesPerStaff: 30, unassigned: true, ...o,
})

type Call = { fn: string; args: unknown[] }
function coreDeps(rows: ReturnType<typeof R.cmsQaFakeSalesRows>, o: Partial<Record<string, unknown>> = {}) {
  const calls: Call[] = []
  const log = (fn: string, ...args: unknown[]) => { calls.push({ fn, args }) }
  const snap = snapshot()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    table: R.CMS_QA_FAKE_TABLE,
    runner: createCmsFixtureRunner({ sales: rows }),
    loadSnapshot: async (id: string) => { log('loadSnapshot', id); return snap },
    openRun: async (id: string, d: unknown) => { log('openRun', id, d); return { ...snap, run_id: uid(99) } },
    stage: async (run: string, part: string, no: number, r: unknown[]) => { log('stage', part, no, r.length); return r.length },
    sealBegin: async () => { log('sealBegin'); return { ok: true } },
    sealStep: async (_r: string, n: number) => { log('sealStep', n); return n === 10 ? { sealed: true } : { ok: true } },
    publish: async () => { log('publish'); return { published: true } },
    finish: async (run: string, st: string, d: Record<string, unknown>) => { log('finish', st, d.error_code) },
    cleanup: async () => { log('cleanup'); return { purged: 0, deleted: 0, more: false } },
    now: () => Date.now(),
    ...o,
  }
  return { deps: deps as CmsSalesSyncDeps, calls, fns: () => calls.map((c) => c.fn) }
}

test.describe('CMS QA kết quả — nguồn bán giả @desktop', () => {
  test('tất định; chỉ email staff QA đã chọn (+ không email / .invalid); tiền tố QA-; trong kỳ VN tới hôm nay; qua đúng biên adapter', () => {
    const rows = R.cmsQaFakeSalesRows(fakeIn())
    expect(R.cmsQaFakeSalesRows(fakeIn())).toEqual(rows)
    expect(rows.length).toBe(2 * 30 + 2)
    expect(new Set(rows.map((r) => r.seller_email))).toEqual(new Set(['qa.staff.a@cms.example.test', 'qa.staff.b@cms.example.test', null, R.CMS_QA_FAKE_UNKNOWN_EMAIL]))
    expect(rows.every((r) => String(r.order_line_id).startsWith('QA-ab12-') && String(r.order_id).startsWith('QA-O-') && String(r.order_code).startsWith('QA-') && r.pos_code === 'QA')).toBe(true)
    expect(new Set(rows.map((r) => r.order_line_id)).size).toBe(rows.length)
    const days = rows.map((r) => vnDateOfMicros(parseUtcMicros(String(r.completed_at))!))
    expect(days.every((d) => d >= '2026-11-01' && d <= '2026-11-03')).toBe(true)
    expect(new Set(days).size).toBe(3)
    expect(new Set(rows.map((r) => r.product_id))).toEqual(new Set(['900001', '900002']))
    expect(rows.some((r) => r.order_type === 'ONLINE') && rows.filter((r) => r.order_type === 'OFFLINE').length > 50).toBe(true)
    // Có cả dòng nguyên và dòng lẻ (nửa K) ở SP K = 30.
    const k30 = rows.filter((r) => r.product_id === '900001').map((r) => Number(r.base_quantity))
    expect(k30.some((q) => q % 30 === 0) && k30.some((q) => q % 30 !== 0)).toBe(true)
    for (const r of rows) expect(normalizeSalesRow(r).ok, String(r.order_line_id)).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('that.ban.that')
  })

  test('từ chối đầu vào sai: chưa bắt đầu, không SP, staff 0 / quá trần, lines ngoài khoảng, runId lạ, K sai', () => {
    for (const o of [
      { todayVn: '2026-10-31' }, { products: [] }, { staff: [] },
      { staff: Array.from({ length: 11 }, (_, i) => ({ id: uid(100 + i), email: `x${i}@e.test` })) },
      { linesPerStaff: 0 }, { linesPerStaff: 501 }, { qaRunId: 'run-thật' }, { products: [{ productId: '1', baseQuantityCms: '0' }] },
      { startDate: '2026-12-01' },
    ] as Partial<R.CmsQaFakeInput>[]) expect(() => R.cmsQaFakeSalesRows(fakeIn(o)), JSON.stringify(o)).toThrow()
    expect(R.parseCmsQaStaffIds(undefined).ok).toBe(false)
    expect(R.parseCmsQaStaffIds(`${A},${A}`).ok).toBe(false)
    expect(R.parseCmsQaStaffIds(`${A},abc`).ok).toBe(false)
    expect(R.parseCmsQaStaffIds(` ${A.toUpperCase()} , ${B}`)).toEqual({ ok: true, value: [A, B] })
    expect(R.parseCmsQaLinesPerStaff(undefined)).toEqual({ ok: true, value: 30 })
    for (const v of ['0', '501', '1.5', '-1', 'x']) expect(R.parseCmsQaLinesPerStaff(v).ok).toBe(false)
  })

  test('nguồn giả chạy qua lõi THẬT: published, có kết quả cả 2 staff, nhóm Chưa gán NO_EMAIL / NOT_FOUND, dòng ONLINE bị loại', async () => {
    const rows = R.cmsQaFakeSalesRows(fakeIn())
    const f = coreDeps(rows)
    const r = await runCmsSalesSync(f.deps, PROG, { dryRun: false, source: R.CMS_QA_WRITER_SOURCE })
    expect([r.status, r.code]).toEqual(['published', null])
    expect(r.rowsRead).toBe(rows.length)
    expect(r.unassigned).toBe(2)
    expect(r.candidates).toBe(rows.filter((x) => x.order_type === 'OFFLINE').length)
    expect(BigInt(r.amountVnd!) > BigInt(0)).toBe(true)
    expect(f.calls.find((c) => c.fn === 'openRun')!.args[1]).toEqual({ source: 'qa' })
  })
})

test.describe('CMS QA kết quả — preflight và guard @desktop', () => {
  const local = (o: Partial<Parameters<typeof R.cmsQaWriterLocalCheck>[0]> = {}) => R.cmsQaWriterLocalCheck({
    manifest: manifest(), confirmRun: RUN, host: 'db.example.test', treeClean: true, gitHead: HEAD, gitTree: TREE, launcherAlive: true, staffIds: [A, B], ...o,
  })

  test('kiểm cục bộ: mọi điều kiện đủ ⇒ đạt; thiếu từng điều kiện ⇒ chặn đúng lý do', () => {
    expect(local()).toEqual({ ok: true })
    const cases: [Partial<Parameters<typeof R.cmsQaWriterLocalCheck>[0]>, RegExp][] = [
      [{ manifest: null }, /không có run QA đang mở/],
      [{ manifest: { ...manifest(), status: 'closed' } }, /không có run QA đang mở/],
      [{ confirmRun: undefined }, /thiếu --confirm-run/],
      [{ confirmRun: 'cms-qa-20261103T101500-ffff' }, /khác run đang mở/],
      [{ host: 'khac.example.test' }, /khác host của run/],
      [{ manifest: manifest({ mode: 'automated' }) }, /không có server QA/],
      [{ manifest: manifest({ port: null }) }, /không có server QA/],
      [{ manifest: manifest({ serverNotStopped: { pid: 1, at: 'x' } }) }, /CHƯA DỪNG/],
      [{ launcherAlive: false }, /launcher \/ server QA của run không còn chạy/],
      [{ treeClean: false }, /cây Git không sạch/],
      [{ gitHead: 'c'.repeat(40) }, /HEAD \/ tree hiện tại khác/],
      [{ gitTree: 'c'.repeat(40) }, /HEAD \/ tree hiện tại khác/],
      [{ staffIds: [A, SM] }, /không phải tài khoản QA vai staff/],
      [{ staffIds: [A, uid(77)] }, /không phải tài khoản QA vai staff/],
      [{ staffIds: [] }, /chưa chọn tài khoản staff QA/],
      // Security review P1-1: manifest của launcher cũ (không ghi pid launcher) ⇒ không ghi.
      [{ manifest: { ...manifest(), launcherPid: undefined } as CmsQaRunManifest }, /không ghi launcherPid/],
    ]
    for (const [o, re] of cases) {
      const r = local(o)
      expect(r.ok, JSON.stringify(o)).toBe(false)
      if (!r.ok) expect(r.reasons.join(' | '), JSON.stringify(o)).toMatch(re)
    }
  })

  test('kiểm DB: chương trình QA active thuộc run + marker đủ ⇒ đạt; thật / chưa kích hoạt / ngoài run / marker thiếu ⇒ chặn', () => {
    const prog = (o: Partial<R.CmsQaWriterProgramRow> = {}) => [{ id: PROG, is_test: true, status: 'active', qa_created_in_run: true, ...o }]
    const db = (o: Partial<Parameters<typeof R.cmsQaWriterDbCheck>[0]> = {}) =>
      R.cmsQaWriterDbCheck({ manifest: manifest(), programId: PROG, programRows: prog(), statusRows: status(), guardMinutes: 10, ...o })
    expect(db()).toEqual({ ok: true })
    // Ghi trong manifest (spec tự động) thay cho "tạo trong run".
    expect(db({ manifest: manifest({ programs: [{ id: PROG, status: 'active', isTest: true }] }), programRows: prog({ qa_created_in_run: false }) })).toEqual({ ok: true })
    const cases: [Partial<Parameters<typeof R.cmsQaWriterDbCheck>[0]>, RegExp][] = [
      [{ programRows: [] }, /không có chương trình/],
      [{ programRows: prog({ is_test: false }) }, /chương trình THẬT/],
      [{ programRows: prog({ status: 'draft' }) }, /chưa kích hoạt \/ đã chốt/],
      [{ programRows: prog({ status: 'locked' }) }, /chưa kích hoạt \/ đã chốt/],
      [{ programRows: prog({ qa_created_in_run: false }) }, /không thuộc run/],
      [{ statusRows: status({ [B]: { active: false } }) }, /marker QA không còn hạn/],
      [{ statusRows: status({ [SM]: { remaining_s: 9 * 60 } }) }, /< ngưỡng canh 10 phút/],
      [{ statusRows: status().filter((s) => s.user_id !== SUPER) }, /không đọc được tài khoản QA/],
    ]
    for (const [o, re] of cases) {
      const r = db(o)
      expect(r.ok, JSON.stringify(o).slice(0, 120)).toBe(false)
      if (!r.ok) expect(r.reasons.join(' | ')).toMatch(re)
    }
    expect(() => R.cmsQaWriterProgramSql('abc', '2026-11-03T10:15:00.000Z', [A])).toThrow()
    expect(() => R.cmsQaWriterProgramSql(PROG, "2026-11-03'; DROP", [A])).toThrow()
    expect(() => R.cmsQaWriterProgramSql(PROG, '2026-11-03T10:15:00.000Z', [])).toThrow()
    expect(R.cmsQaWriterProgramSql(PROG, '2026-11-03T10:15:00.000Z', [A, B])).toMatch(/^SELECT p\.id::text/)
  })

  // Đồng hồ giả cho guard: workUntil xa ⇒ không chạm ngân sách (trừ ca ngân sách).
  const farClock = () => { const c = { t: 0 }; return { c, clock: { now: () => c.t, workUntil: 10_000_000, minStartMs: 10_000 } } }

  test('guard trước MỖI bước ghi: đủ ⇒ published; guard gọi trước open / mọi khối stage / seal / publish / cleanup; detail open gắn qa_run_id + qa_writer_id; run_id ghi sổ ngay', async () => {
    const steps: string[] = []
    const opened: string[] = []
    const f = coreDeps(R.cmsQaFakeSalesRows(fakeIn()))
    const deps = R.cmsQaGuardedDeps(f.deps, async (s) => { steps.push(s) }, {
      clock: farClock().clock, tag: { qaRunId: RUN, writerId: 'w-0123456789ab' }, onOpened: async (id) => { opened.push(id) },
    })
    const r = await runCmsSalesSync(deps, PROG, { dryRun: false, source: 'qa', chunkSize: 20 })
    expect([r.status, r.code]).toEqual(['published', null])
    expect(steps).toEqual(f.fns().filter((x) => x !== 'loadSnapshot' && x !== 'finish'))
    expect(steps.filter((s) => s === 'stage').length).toBeGreaterThan(3)
    expect(f.calls.find((c) => c.fn === 'openRun')!.args[1]).toEqual({ source: 'qa', qa_run_id: RUN, qa_writer_id: 'w-0123456789ab' })
    expect(opened).toEqual([uid(99)])
    // onOpened chạy TRƯỚC khối stage đầu tiên.
    expect(f.fns().indexOf('stage')).toBeGreaterThan(f.fns().indexOf('openRun'))
  })

  test('mất điều kiện giữa chừng ⇒ bước không chạy, lõi đóng run error CMS_QA_GUARD_LOST, KHÔNG publish (pointer giữ)', async () => {
    const rows = R.cmsQaFakeSalesRows(fakeIn())
    for (const [failAt, nth] of [['openRun', 1], ['stage', 1], ['stage', 3], ['sealBegin', 1], ['sealStep', 5], ['publish', 1]] as const) {
      const f = coreDeps(rows)
      let n = 0
      const deps = R.cmsQaGuardedDeps(f.deps, async (s) => { if (s === failAt && ++n === nth) throw new Error('marker hết') }, { clock: farClock().clock })
      const r = await runCmsSalesSync(deps, PROG, { dryRun: false, source: 'qa', chunkSize: 20 })
      expect([r.status, r.code], `${failAt}#${nth}`).toEqual(['error', R.CMS_QA_GUARD_LOST])
      expect(f.fns(), `${failAt}#${nth}`).not.toContain('publish')
      if (failAt === 'openRun') expect(f.fns()).toEqual(['loadSnapshot'])
      else expect(f.calls.filter((c) => c.fn === 'finish').map((c) => c.args), `${failAt}#${nth}`).toEqual([['error', R.CMS_QA_GUARD_LOST]])
    }
  })

  test('QA-P1-1: điều kiện mất TRONG LÚC guard chờ IO ⇒ guard kiểm lại sau IO, bước ghi KHÔNG chạy', async () => {
    // Mô phỏng đúng thứ tự guard của CLI: đọc DB (chậm) rồi mới kiểm launcher; launcher dừng giữa lúc đọc.
    const f = coreDeps(R.cmsQaFakeSalesRows(fakeIn()))
    let launcher = true, reads = 0
    const guard = async (step: string) => {
      if (step === 'stage') { reads++; await new Promise((r) => setTimeout(r, 5)); launcher = false }
      if (!launcher) throw new Error('launcher dừng')
    }
    const r = await runCmsSalesSync(R.cmsQaGuardedDeps(f.deps, guard, { clock: farClock().clock }), PROG, { dryRun: false, source: 'qa', chunkSize: 20 })
    expect([r.status, r.code, reads]).toEqual(['error', R.CMS_QA_GUARD_LOST, 1])
    expect(f.fns().filter((x) => x === 'stage')).toEqual([])
  })

  test('QA-P1-1: ngân sách gồm cả thời gian guard — guard kéo vượt mốc làm việc ⇒ CMS_QA_GUARD_DEADLINE, không ghi; timeout ghi tính lại sau guard', async () => {
    // (a) guard tiêu hết ngân sách trước stage.
    const f = coreDeps(R.cmsQaFakeSalesRows(fakeIn()))
    const { c, clock } = farClock()
    clock.workUntil = 200_000
    const deps = R.cmsQaGuardedDeps(f.deps, async (s) => { if (s === 'stage') c.t += 195_000 }, { clock })
    const r = await runCmsSalesSync(deps, PROG, { dryRun: false, source: 'qa', chunkSize: 20 })
    expect([r.status, r.code]).toEqual(['error', R.CMS_QA_GUARD_DEADLINE])
    expect(f.fns()).not.toContain('stage')
    // (b) hết ngân sách TRƯỚC khi gọi guard ⇒ không gọi guard, không ghi.
    let called = 0
    const g = coreDeps(R.cmsQaFakeSalesRows(fakeIn()))
    const d2 = R.cmsQaGuardedDeps(g.deps, async () => { called++ }, { clock: { now: () => 0, workUntil: 5_000, minStartMs: 10_000 } })
    const r2 = await runCmsSalesSync(d2, PROG, { dryRun: false, source: 'qa' })
    expect([r2.code, called, g.fns()]).toEqual([R.CMS_QA_GUARD_DEADLINE, 0, ['loadSnapshot']])
    // (c) timeout của bước ghi = min(timeout lõi, phần còn lại SAU guard).
    const seen: number[] = []
    const h = coreDeps(R.cmsQaFakeSalesRows(fakeIn()), { stage: async (_r: string, _p: string, _n: number, rows: unknown[], io: { timeoutMs: number }) => { seen.push(io.timeoutMs); return rows.length } })
    const hc = farClock()
    hc.clock.workUntil = 100_000
    const d3 = R.cmsQaGuardedDeps(h.deps, async (s) => { if (s === 'stage') hc.c.t += 70_000 }, { clock: hc.clock })
    await runCmsSalesSync(d3, PROG, { dryRun: false, source: 'qa', chunkSize: 20000 })
    expect(seen.length).toBe(1)
    expect(seen[0]).toBeLessThanOrEqual(30_000)
  })

  test('PM r2 P2: đồng hồ có phần lẻ — mọi timeout I/O nguyên, ≤ phần còn lại, AbortSignal.timeout THẬT nhận (biên 12 s / 20 s / 50 s)', async () => {
    // Đúng loại lỗi Node cần chặn (Node 24: ERR_OUT_OF_RANGE) — nếu Node đổi hành vi, test vẫn ép số nguyên ở dưới.
    expect(() => AbortSignal.timeout(12_000.25)).toThrow()
    // Đồng hồ writer: nguyên, không giảm, kể cả timeOrigin / now có phần lẻ.
    let pt = 0.37
    const mono = R.cmsQaMonoClock({ timeOrigin: 1_762_164_900_123.618, now: () => (pt += 0.41) })
    const ticks = Array.from({ length: 50 }, () => mono())
    expect(ticks.every((x) => Number.isInteger(x))).toBe(true)
    expect(ticks.every((x, i) => i === 0 || x >= ticks[i - 1])).toBe(true)
    // Helper biên: floor, sàn, NaN ⇒ ném.
    expect(R.cmsQaIoTimeoutMs(30_000, 19_999.75)).toBe(19_999)
    expect(R.cmsQaIoTimeoutMs(30_000, 400.5, 1_000)).toBe(1_000)
    expect(() => R.cmsQaIoTimeoutMs(30_000, Number.NaN)).toThrow(R.CMS_QA_GUARD_DEADLINE)
    for (const leftMs of [12_000, 20_000, 50_000]) {
      // Lõi: work / stop / sourceMs từ đồng hồ lẻ.
      const b = cmsBudget(() => 0.25, leftMs + CMS_SALES_STOP_RESERVE_MS)
      for (const ms of [b.work().timeoutMs, b.stop().timeoutMs, b.sourceMs()]) {
        expect(Number.isInteger(ms)).toBe(true)
        expect(() => AbortSignal.timeout(ms)).not.toThrow()
      }
      expect(b.work().timeoutMs).toBeLessThanOrEqual(leftMs)
      // Lõi + wrapper: mỗi deps gọi AbortSignal.timeout thật; đồng hồ lẻ tăng dần giữa các lần gọi.
      let t = 0.25
      const now = () => (t += 0.37)
      const seen: Array<[string, number]> = []
      const io = (fn: string, x: { timeoutMs: number }) => { seen.push([fn, x.timeoutMs]); AbortSignal.timeout(x.timeoutMs) }
      const f = coreDeps(R.cmsQaFakeSalesRows(fakeIn({ linesPerStaff: 5 })), {
        now,
        loadSnapshot: async (_id: string, x: { timeoutMs: number }) => { io('loadSnapshot', x); return snapshot() },
        openRun: async (_id: string, _d: unknown, x: { timeoutMs: number }) => { io('openRun', x); return { ...snapshot(), run_id: uid(99) } },
        stage: async (_r: string, _p: string, _n: number, rows: unknown[], x: { timeoutMs: number }) => { io('stage', x); return rows.length },
        sealBegin: async (_r: string, _e: unknown, x: { timeoutMs: number }) => { io('sealBegin', x); return { ok: true } },
        sealStep: async (_r: string, n: number, x: { timeoutMs: number }) => { io('sealStep', x); return n === 10 ? { sealed: true } : { ok: true } },
        publish: async (_r: string, x: { timeoutMs: number }) => { io('publish', x); return { published: true } },
        finish: async (_r: string, _s: string, _d: unknown, x: { timeoutMs: number }) => { io('finish', x) },
        cleanup: async (_p: string, _m: number, x: { timeoutMs: number }) => { io('cleanup', x); return { purged: 0, deleted: 0, more: false } },
      })
      const workUntil = leftMs // đồng hồ bắt đầu ở 0,25 ⇒ phần còn lại < leftMs, có phần lẻ
      const deps = R.cmsQaGuardedDeps(f.deps, async () => { t += 0.29 }, { clock: { now, workUntil, minStartMs: CMS_RPC_START_MIN_MS } })
      const r = await runCmsSalesSync(deps, PROG, { dryRun: false, source: 'qa', deadlineAt: workUntil + CMS_SALES_STOP_RESERVE_MS })
      expect([leftMs, r.status, r.code]).toEqual([leftMs, 'published', null])
      expect(seen.map((s) => s[0])).toEqual(expect.arrayContaining(['loadSnapshot', 'openRun', 'stage', 'sealBegin', 'sealStep', 'publish', 'cleanup']))
      expect(seen.filter(([, ms]) => !Number.isInteger(ms) || ms <= 0)).toEqual([])
      expect(seen.filter(([fn, ms]) => fn !== 'cleanup' && fn !== 'finish' && ms > leftMs)).toEqual([])
    }
    // finish (đóng run khi guard mất) cũng đi qua biên số nguyên.
    let t2 = 0.25
    const now2 = () => (t2 += 0.37)
    const fin: number[] = []
    const g = coreDeps(R.cmsQaFakeSalesRows(fakeIn({ linesPerStaff: 5 })), { now: now2, finish: async (_r: string, _s: string, _d: unknown, x: { timeoutMs: number }) => { fin.push(x.timeoutMs); AbortSignal.timeout(x.timeoutMs) } })
    const dg = R.cmsQaGuardedDeps(g.deps, async (s) => { if (s === 'stage') throw new Error('mất') }, { clock: { now: now2, workUntil: 21_000, minStartMs: CMS_RPC_START_MIN_MS } })
    const rg = await runCmsSalesSync(dg, PROG, { dryRun: false, source: 'qa', deadlineAt: 21_000 + CMS_SALES_STOP_RESERVE_MS })
    expect([rg.status, rg.code, fin.length, fin.every((x) => Number.isInteger(x))]).toEqual(['error', R.CMS_QA_GUARD_LOST, 1, true])
  })

  test('QA-P1-2: ghi sổ ngay sau openRun lỗi ⇒ CMS_QA_LEDGER_FAILED, dừng trước stage; kết quả ⇒ sổ `unknown`', async () => {
    const f = coreDeps(R.cmsQaFakeSalesRows(fakeIn()))
    const deps = R.cmsQaGuardedDeps(f.deps, async () => {}, { clock: farClock().clock, onOpened: async () => { throw new Error('EPERM') } })
    const r = await runCmsSalesSync(deps, PROG, { dryRun: false, source: 'qa' })
    expect([r.status, r.code, r.runId]).toEqual(['error', R.CMS_QA_LEDGER_FAILED, null])
    expect(f.fns()).not.toContain('stage')
    expect(R.cmsQaWriterOutcome(r)).toBe('unknown')
    for (const code of ['OPEN_FAILED', 'PUBLISH_UNKNOWN', 'CLOSE_FAILED', 'INTERNAL']) expect(R.cmsQaWriterOutcome({ status: 'error', code })).toBe('unknown')
    for (const code of [null, R.CMS_QA_GUARD_LOST, R.CMS_QA_GUARD_DEADLINE, 'CMS_SYNC_BUSY', 'RESULTS_RELEASE_GATE']) expect(R.cmsQaWriterOutcome({ status: 'held', code })).toBe('done')
  })

  test('QA-P1-1: marker trừ bảo thủ thời gian đã trôi kể từ lúc bắt đầu đọc', () => {
    const rows = status({ [A]: { remaining_s: 615 } })
    const aged = R.cmsQaAgeStatusRows(rows, 20_400)
    expect(aged.find((x) => x.user_id === A)!.remaining_s).toBe(594)
    const c = R.cmsQaWriterDbCheck({ manifest: manifest(), programId: PROG, programRows: [{ id: PROG, is_test: true, status: 'active', qa_created_in_run: true }], statusRows: aged, guardMinutes: 10 })
    expect(c.ok).toBe(false)
    expect(R.cmsQaWriterDbCheck({ manifest: manifest(), programId: PROG, programRows: [{ id: PROG, is_test: true, status: 'active', qa_created_in_run: true }], statusRows: rows, guardMinutes: 10 }).ok).toBe(true)
  })

  test('cổng writer: cần biến PROCESS + host đúng + manifest PHẢI mở (ngược cmsWriteGate)', () => {
    const env = { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: 'db.example.test', NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test' }
    expect(cmsQaWriterGate({ env, envFileText: null, markerExists: true })).toEqual({ ok: true, host: 'db.example.test' })
    const no = (o: Parameters<typeof cmsQaWriterGate>[0]) => { const g = cmsQaWriterGate(o); return g.ok ? '' : g.reason }
    expect(no({ env, envFileText: null, markerExists: false })).toMatch(new RegExp(`không có run QA đang mở \\(${CMS_QA_MARKER.replace('.', '\\.')}\\)`))
    expect(no({ env: { ...env, E2E_CMS_WRITE_QA: undefined }, envFileText: null, markerExists: true })).toMatch(/E2E_CMS_WRITE_QA=YES/)
    expect(no({ env: { ...env, E2E_EXPECTED_SUPABASE_HOST: 'khac' }, envFileText: null, markerExists: true })).toMatch(/TRÙNG CHÍNH XÁC/)
    expect(no({ env, envFileText: 'E2E_CMS_WRITE_QA=YES\n', markerExists: true })).toMatch(/\.env\.local/)
    expect(no({ env, envFileText: 'CMS_PROGRAM_ENABLED=true\n', markerExists: true })).toMatch(/CMS_PROGRAM_ENABLED=true/)
  })
})

test.describe('CMS QA kết quả — sổ writer và đối chiếu close @desktop', () => {
  const WID = 'w-0123456789ab', WID2 = 'w-0123456789ac'
  const entry = (o: Partial<R.CmsQaWriterEntry> = {}): R.CmsQaWriterEntry => ({
    ...R.newCmsQaWriterEntry({ writerId: WID, qaRunId: RUN, pid: 777, programId: PROG, staff: [A], lines: 31, now: '2026-11-03T10:20:00.000000Z' }), ...o,
  })
  const file = (e: R.CmsQaWriterEntry, name = `${e.writerId}.json`) => ({ name, text: JSON.stringify(e) })
  const res = (runId: string | null, code: string | null = null) => ({ status: code ? 'error' : 'published', code, runId, stagedRows: 1, rowsRead: 1, candidates: 1, included: 1, unassigned: 0 })
  const run = (o: Partial<R.CmsQaSalesRunRow>): R.CmsQaSalesRunRow => ({
    id: uid(90), program_id: PROG, is_test: true, status: 'ok', source: 'qa', error_code: null, qa_run_id: RUN, qa_writer_id: WID, ...o,
  })

  test('close từ chối writer còn chạy / không rõ kết thúc / `unknown` / sổ hỏng / khác run / sai tên; done / reconciled thì qua', () => {
    const alive = (pid: number) => pid === 777
    expect(R.cmsQaWritersCloseCheck(RUN, [file(entry({ status: 'done' }))], alive).reasons).toEqual([])
    expect(R.cmsQaWritersCloseCheck(RUN, [file(entry({ status: 'reconciled' }))], () => false).reasons).toEqual([])
    expect(R.cmsQaWritersCloseCheck(RUN, [file(entry())], alive).reasons.join()).toMatch(/CÒN CHẠY/)
    expect(R.cmsQaWritersCloseCheck(RUN, [file(entry())], () => false).reasons.join()).toMatch(/không rõ kết thúc.*reconcile --writer=w-0123456789ab/)
    expect(R.cmsQaWritersCloseCheck(RUN, [file(entry({ status: 'unknown', result: res(null, 'OPEN_FAILED') }))], () => false).reasons.join()).toMatch(/KHÔNG RÕ \(OPEN_FAILED/)
    expect(R.cmsQaWritersCloseCheck(RUN, [{ name: `${WID}.json`, text: '{' }], alive).reasons.join()).toMatch(/hỏng/)
    expect(R.cmsQaWritersCloseCheck(RUN, [file(entry({ qaRunId: 'cms-qa-20261102T101500-cd34' }))], alive).reasons.join()).toMatch(/thuộc run khác/)
    expect(R.cmsQaWritersCloseCheck(RUN, [file(entry({ status: 'done' }), 'w-ffffffffffff.json')], alive).reasons.join()).toMatch(/sai tên file/)
    expect(R.parseCmsQaWriterEntry(JSON.stringify({ ...entry(), openedRunId: 'x' })).ok).toBe(false)
    expect(R.parseCmsQaWriterEntry(JSON.stringify({ ...entry(), status: 'lạ' })).ok).toBe(false)
    expect(() => R.newCmsQaWriterEntry({ writerId: 'x', qaRunId: RUN, pid: 1, programId: PROG, staff: [], lines: 0, now: '' })).toThrow()
  })

  test('run sales trong cửa sổ — liên kết run ↔ writer (PM QA-P1-2): đúng writer + sổ biết run ⇒ qua; thiếu / sai liên kết ⇒ ĐỎ; run thật như cũ', () => {
    const w = [entry({ status: 'done', openedRunId: uid(90), result: res(uid(90)) }),
      entry({ writerId: WID2, status: 'reconciled', reconcile: { at: 'x', runs: [{ id: uid(91), status: 'error', errorCode: 'QA_WRITER_ABORTED' }], finishedOrphan: uid(91) } })]
    const ok = R.cmsQaSalesRunsCheck([run({}), run({ id: uid(91), status: 'error', error_code: 'QA_WRITER_ABORTED', qa_writer_id: WID2 })], w, { qaRunId: RUN })
    expect(ok).toMatchObject({ reasons: [], warningProgramIds: [] })
    expect(ok.runs.map((x) => x.writerId)).toEqual([WID, WID2])
    const red = (rows: R.CmsQaSalesRunRow[], re: RegExp, ww = w) => expect(R.cmsQaSalesRunsCheck(rows, ww, { qaRunId: RUN }).reasons.join(' | ')).toMatch(re)
    red([run({ id: uid(92), source: 'operator', qa_writer_id: null, qa_run_id: null })], /không do writer của run này \(source operator\)/)
    red([run({ id: uid(93), qa_run_id: 'cms-qa-20261102T101500-cd34' })], /không do writer của run này/)
    red([run({ id: uid(94), qa_writer_id: 'w-ffffffffffff' })], /không có sổ trong run/)
    red([run({ id: uid(95), program_id: uid(5) })], /khác chương trình của sổ/)
    // Mất phản hồi openRun: sổ done / unknown nhưng không biết run ⇒ ĐỎ, chỉ reconcile mới gỡ.
    red([run({ id: uid(96) })], /chưa có trong sổ \(mất phản hồi\?\).*reconcile --writer=w-0123456789ab/, [entry({ status: 'done', result: res(null, 'OPEN_FAILED') })])
    red([run({ status: 'running' })], /còn running/)
    // Chương trình thật.
    red([run({ is_test: false, program_id: REAL })], /THẬT.*do writer QA/)
    red([run({ is_test: false, program_id: REAL, source: 'operator', qa_writer_id: null, status: 'held', error_code: 'RESULTS_RELEASE_GATE' })], /Q-206 HOLD/)
    expect(R.cmsQaSalesRunsCheck([run({ is_test: false, program_id: REAL, source: 'cron', qa_writer_id: null, qa_run_id: null })], w, { qaRunId: RUN, releaseOpen: true })).toMatchObject({ reasons: [], warningProgramIds: [REAL] })
    expect(R.cmsQaSalesRunsCheck([run({ is_test: false, program_id: REAL, source: 'qa' })], w, { qaRunId: RUN, releaseOpen: true }).reasons.length).toBe(1)
    expect(() => R.cmsQaRunSalesRunsSql("x' OR 1=1")).toThrow()
    expect(R.cmsQaRunSalesRunsSql('2026-11-03T10:15:00.000Z')).toMatch(/qa_writer_id[\s\S]*r\.kind = 'sales' AND r\.started_at >= '2026-11-03T10:15:00\.000Z'::timestamptz/)
  })

  test('reconcile (PM QA-P1-2): chỉ run LIÊN KẾT đúng writer; running + pid chết / unknown / done thiếu run ⇒ được; còn sống / đã đủ / liên kết sai ⇒ từ chối', () => {
    const other = run({ id: uid(80), qa_writer_id: WID2, status: 'running' }) // writer khác cùng chương trình — không được đụng
    // running + pid chết, run liên kết còn running ⇒ orphan đúng run của writer, KHÔNG phải run của writer khác.
    const p1 = R.cmsQaReconcileCheck(entry(), [other, run({ status: 'running' })], false)
    expect(p1).toMatchObject({ ok: true, orphan: uid(90) })
    if (p1.ok) expect(p1.linked.map((x) => x.id)).toEqual([uid(90)])
    expect(R.cmsQaReconcileCheck(entry(), [run({})], true)).toMatchObject({ ok: false })
    // unknown (OPEN_FAILED) + DB có run liên kết đã đóng ⇒ được, không orphan.
    expect(R.cmsQaReconcileCheck(entry({ status: 'unknown', result: res(null, 'OPEN_FAILED') }), [run({ status: 'error', error_code: 'X' })], false)).toMatchObject({ ok: true, orphan: null })
    // done + null run nhưng DB có run liên kết ⇒ được (mất phản hồi open).
    expect(R.cmsQaReconcileCheck(entry({ status: 'done', result: res(null, 'CMS_SYNC_BUSY') }), [run({ status: 'error', error_code: 'X' })], false)).toMatchObject({ ok: true })
    // done + mọi run liên kết đã biết ⇒ không cần.
    expect(R.cmsQaReconcileCheck(entry({ status: 'done', openedRunId: uid(90), result: res(uid(90)) }), [run({})], false)).toMatchObject({ ok: false })
    expect(R.cmsQaReconcileCheck(entry({ status: 'reconciled' }), [], false)).toMatchObject({ ok: false })
    // Liên kết sai namespace / run QA / chương trình ⇒ điều tra, không tự nhận.
    for (const bad of [run({ is_test: false }), run({ qa_run_id: 'cms-qa-20261102T101500-cd34' }), run({ program_id: uid(5) }), run({ source: 'operator' })]) {
      const c = R.cmsQaReconcileCheck(entry(), [bad], false)
      expect(c.ok, JSON.stringify(bad)).toBe(false)
    }
    expect(R.cmsQaReconcileCheck(entry(), [run({ status: 'running' }), run({ id: uid(97), status: 'running' })], false)).toMatchObject({ ok: false })
  })
})

// ── P3a — QA chốt có gate + sổ ý định (work order 03/11 §4.2) ─────────────────
test.describe('CMS QA chốt (P3a) — tham số, cờ process, sổ ý định, reconcile, close @desktop', () => {
  const RUN_X = uid(31), OP = 'l-0123456789ab', OP2 = 'l-ba9876543210'
  const lockEntry = (o: Partial<R.CmsQaLockEntry> = {}): R.CmsQaLockEntry => ({
    ...R.newCmsQaLockEntry({ operationId: OP, qaRunId: RUN, pid: 4243, programId: PROG, actorId: SUPER, expectedRunId: RUN_X, policyVersion: 1, ack: false, now: '2026-11-03T10:20:00.000Z' }),
    ...o,
  })
  const done = (o: Partial<R.CmsQaLockEntry> = {}) => lockEntry({ status: 'done', finishedAt: '2026-11-03T10:20:01.000Z',
    result: { ok: true, code: null, already: false, runId: RUN_X, amountVnd: '120000' }, ...o })
  const unknownResult = { ok: false, code: 'UNKNOWN_OUTCOME', already: false, runId: null, amountVnd: null }

  test('cờ LOCK chỉ từ biến PROCESS: đủ 3 cờ ⇒ đạt; thiếu cờ nào nêu cờ đó; .env.local có CMS_LOCK_ENABLED=true ⇒ gate chặn', () => {
    expect(R.cmsQaLockFlagsOk({ CMS_PROGRAM_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true', CMS_LOCK_ENABLED: 'true' })).toEqual({ ok: true })
    const r = R.cmsQaLockFlagsOk({ CMS_PROGRAM_ENABLED: 'true', CMS_LOCK_ENABLED: 'true' })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.reason).toMatch(/CMS_EARNINGS_ENABLED=true/); expect(r.reason).not.toMatch(/CMS_PROGRAM_ENABLED/) }
    expect(R.cmsQaLockFlagsOk({ CMS_PROGRAM_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true', CMS_LOCK_ENABLED: '1' }).ok).toBe(false)
    const env = { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: 'db.example.test', NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test' }
    for (const text of ['CMS_LOCK_ENABLED=true\n', 'export CMS_LOCK_ENABLED = "true" # thử\n']) {
      const g = cmsQaWriterGate({ env, envFileText: text, markerExists: true })
      expect(g.ok, text).toBe(false)
      if (!g.ok) expect(g.reason).toMatch(/CMS_LOCK_ENABLED=true đang nằm trong \.env\.local/)
    }
    expect(cmsQaWriterGate({ env, envFileText: 'CMS_LOCK_ENABLED=false\n', markerExists: true }).ok).toBe(true)
  })

  test('tham số: actor bắt buộc; lock cần --expect-run + --policy-version; preview không nhận; lý do chuẩn hoá như action', () => {
    expect(R.parseCmsQaLockArgs({ actor: SUPER.toUpperCase() }, false)).toEqual({ ok: true, value: { actorId: SUPER, expectedRunId: null, policyVersion: null, ack: null } })
    expect(R.parseCmsQaLockArgs({ actor: SUPER, expectRun: RUN_X, policyVersion: '1', ack: '  Đã soát dòng chưa gán  ' }, true))
      .toEqual({ ok: true, value: { actorId: SUPER, expectedRunId: RUN_X, policyVersion: 1, ack: 'Đã soát dòng chưa gán' } })
    const bad: [Parameters<typeof R.parseCmsQaLockArgs>[0], boolean, RegExp][] = [
      [{}, true, /--actor/],
      [{ actor: 'x' }, false, /--actor/],
      [{ actor: SUPER, expectRun: RUN_X }, false, /lock-preview không nhận/],
      [{ actor: SUPER, policyVersion: '1' }, true, /--expect-run/],
      [{ actor: SUPER, expectRun: 'abc', policyVersion: '1' }, true, /--expect-run/],
      [{ actor: SUPER, expectRun: RUN_X }, true, /--policy-version/],
      [{ actor: SUPER, expectRun: RUN_X, policyVersion: '0' }, true, /--policy-version/],
      [{ actor: SUPER, expectRun: RUN_X, policyVersion: '1.5' }, true, /--policy-version/],
      [{ actor: SUPER, expectRun: RUN_X, policyVersion: '1', ack: '   ngắn   ' }, true, /--ack/],
      [{ actor: SUPER, expectRun: RUN_X, policyVersion: '1', ack: 'x'.repeat(1001) }, true, /--ack/],
    ]
    for (const [v, forLock, re] of bad) {
      const r = R.parseCmsQaLockArgs(v, forLock)
      expect(r.ok, JSON.stringify(v)).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(re)
    }
  })

  test('kiểm cục bộ: như writer + actor là QA vai admin của run (staff / SM / ngoài run ⇒ chặn)', () => {
    type In = Parameters<typeof R.cmsQaLockLocalCheck>[0]
    const local = (o: Partial<In> = {}) => R.cmsQaLockLocalCheck({
      manifest: manifest(), confirmRun: RUN, host: 'db.example.test', treeClean: true, gitHead: HEAD, gitTree: TREE, launcherAlive: true, actorId: SUPER, ...o,
    })
    expect(local()).toEqual({ ok: true })
    const cases: [Partial<In>, RegExp][] = [
      [{ manifest: null }, /không có run QA đang mở/],
      [{ actorId: A }, /không phải tài khoản QA vai admin/],
      [{ actorId: SM }, /không phải tài khoản QA vai admin/],
      [{ actorId: REAL }, /không phải tài khoản QA vai admin/],
      [{ launcherAlive: false }, /launcher \/ server QA của run không còn chạy/],
      [{ treeClean: false }, /cây Git không sạch/],
      [{ confirmRun: undefined }, /thiếu --confirm-run/],
    ]
    for (const [o, re] of cases) {
      const r = local(o)
      expect(r.ok, JSON.stringify(o)).toBe(false)
      if (!r.ok) expect(r.reasons.join(' | ')).toMatch(re)
    }
  })

  test('sổ ý định: đủ khoá vết (qa_run_id, operation_id, program, expected run, policy) trước RPC; parse từ chối sổ hỏng; outcome', () => {
    const e = lockEntry()
    expect(e).toMatchObject({ kind: 'cms-qa-lock', status: 'intent', operationId: OP, qaRunId: RUN, programId: PROG, expectedRunId: RUN_X, policyVersion: 1, result: null })
    expect(JSON.stringify(e)).not.toMatch(/@/)
    expect(R.parseCmsQaLockEntry(JSON.stringify(e))).toEqual({ ok: true, value: e })
    expect(R.parseCmsQaLockEntry(JSON.stringify(done()))).toMatchObject({ ok: true })
    for (const bad of ['{', JSON.stringify({ ...e, kind: 'cms-qa-writer' }), JSON.stringify({ ...e, operationId: 'w-0123456789ab' }),
      JSON.stringify({ ...e, expectedRunId: 'x' }), JSON.stringify({ ...e, policyVersion: 0 }), JSON.stringify({ ...e, status: 'done' }),
      JSON.stringify({ ...e, status: 'reconciled' }), JSON.stringify({ ...e, status: 'lạ' })]) {
      expect(R.parseCmsQaLockEntry(bad).ok, bad.slice(0, 80)).toBe(false)
    }
    expect(() => R.newCmsQaLockEntry({ operationId: 'l-xyz', qaRunId: RUN, pid: 1, programId: PROG, actorId: SUPER, expectedRunId: RUN_X, policyVersion: 1, ack: false, now: 'x' })).toThrow()
    expect(R.cmsQaLockOutcome({ ok: true })).toBe('done')
    expect(R.cmsQaLockOutcome({ ok: false, code: 'UNKNOWN_OUTCOME' })).toBe('unknown')
    for (const c of ['CMS_LOCK_RUN_CHANGED', 'BUSY', 'QUERY_FAILED', 'CMS_PROGRAM_LOCKED']) expect(R.cmsQaLockOutcome({ ok: false, code: c })).toBe('rejected')
    expect(R.cmsQaLockClaimedRun(done())).toBe(RUN_X)
    expect(R.cmsQaLockClaimedRun(lockEntry())).toBeNull()
    const pending = R.cmsQaPendingLockOps([lockEntry(), done({ operationId: OP2 }), lockEntry({ operationId: OP2, status: 'unknown', result: unknownResult }),
      lockEntry({ programId: uid(2) })], PROG)
    expect(pending.map((x) => x.status)).toEqual(['intent', 'unknown'])
  })

  test('reconcile: payout khớp ⇒ đã chốt (mất phản hồi sau commit); lệch ⇒ điều tra; không payout ⇒ chưa chốt CHỈ khi hết phiên chốt + qua thời gian lắng', () => {
    const t0 = Date.parse('2026-11-03T10:20:00.000Z')
    const row = (o: Partial<R.CmsQaLockStateRow> = {}): R.CmsQaLockStateRow => ({ program_id: PROG, status: 'active', is_test: true, run_id: null, locked_by: null, locked_at: null, ...o })
    const unk = lockEntry({ status: 'unknown', finishedAt: '2026-11-03T10:20:05.000Z', result: unknownResult })
    const probe = (o: Partial<R.CmsQaLockProbeRow> = {}): R.CmsQaLockProbeRow => ({ can_see_all: true, tracking: true, hidden: 0, inflight: 0, payout_writers: 0, ...o })
    const opt = (o: { pidAlive?: boolean; nowMs?: number; probe?: R.CmsQaLockProbeRow | undefined } = {}) => ({ pidAlive: false, nowMs: t0 + 10 * 60_000, probe: probe(), ...o })
    expect(R.cmsQaLockReconcileCheck(unk, row({ status: 'locked', run_id: RUN_X, locked_by: SUPER, locked_at: '2026-11-03 10:20:00+00' }), opt()))
      .toEqual({ ok: true, locked: true, payout: { programId: PROG, runId: RUN_X, lockedBy: SUPER, lockedAt: '2026-11-03 10:20:00+00', isTest: true } })
    expect(R.cmsQaLockReconcileCheck(lockEntry(), row({ status: 'locked', run_id: RUN_X, locked_by: SUPER }), opt())).toMatchObject({ ok: true, locked: true })
    expect(R.cmsQaLockReconcileCheck(unk, row(), opt())).toEqual({ ok: true, locked: false, payout: null })
    const no = (e: R.CmsQaLockEntry, r: R.CmsQaLockStateRow | undefined, o = opt()) => {
      const c = R.cmsQaLockReconcileCheck(e, r, o)
      expect(c.ok).toBe(false)
      return c.ok ? null : c
    }
    expect(no(lockEntry(), row(), opt({ pidAlive: true }))).toMatchObject({ wait: true, reason: expect.stringMatching(/còn chạy/) })
    expect(no(done(), row())?.reason).toMatch(/kết quả xác định/)
    expect(no(lockEntry({ status: 'reconciled', reconcile: { at: 'x', locked: false, payout: null } }), row())?.reason).toMatch(/đã reconciled/)
    expect(no(unk, undefined)?.reason).toMatch(/không có chương trình/)
    expect(no(unk, row({ is_test: false }))?.reason).toMatch(/không phải is_test/)
    expect(no(unk, row({ status: 'locked', run_id: uid(99), locked_by: SUPER }))?.reason).toMatch(/KHÔNG khớp/)
    expect(no(unk, row({ status: 'locked', run_id: RUN_X, locked_by: uid(98) }))?.reason).toMatch(/KHÔNG khớp/)
    expect(no(unk, row({ status: 'locked' }))?.reason).toMatch(/không có payout/)
    expect(no(unk, row(), opt({ probe: probe({ inflight: 1 }) }))).toMatchObject({ wait: true, reason: expect.stringMatching(/phiên DB đang chạy/) })
    // db-review P2-3: transaction chốt "idle in transaction" (query đã đổi) vẫn giữ RowExclusiveLock trên bảng payout ⇒ chờ.
    expect(no(unk, row(), opt({ probe: probe({ payout_writers: 1 }) }))).toMatchObject({ wait: true, reason: expect.stringMatching(/khoá ghi bảng payout/) })
    // Không chứng minh được (vai không thấy query mọi phiên / track_activities tắt / phiên ẩn / thiếu lượt dò) ⇒ không kết luận, không "chờ".
    for (const p of [probe({ can_see_all: false }), probe({ tracking: false }), probe({ hidden: 2 }), undefined]) {
      const c = no(unk, row(), opt({ probe: p }))
      expect(c?.reason).toMatch(/không chứng minh được/)
      expect(c?.wait).toBeUndefined()
    }
    // Payout khớp sổ ⇒ đã chốt, không cần lượt dò (kể cả dò thất bại).
    expect(R.cmsQaLockReconcileCheck(unk, row({ status: 'locked', run_id: RUN_X, locked_by: SUPER }), opt({ probe: undefined }))).toMatchObject({ ok: true, locked: true })
    const fin = Date.parse('2026-11-03T10:20:05.000Z')
    expect(no(unk, row(), opt({ nowMs: fin + R.CMS_QA_LOCK_SETTLE_MS - 1 }))).toMatchObject({ wait: true, reason: expect.stringMatching(/thời gian lắng/) })
    expect(R.cmsQaLockReconcileCheck(unk, row(), opt({ nowMs: fin + R.CMS_QA_LOCK_SETTLE_MS }))).toMatchObject({ ok: true, locked: false })
  })

  test('close: thao tác chốt còn chạy / không rõ ⇒ ĐỎ; payout QA phải khớp sổ (chốt ngoài sổ ⇒ ĐỎ); sổ nói đã chốt mà DB không có ⇒ ĐỎ; thật do QA ⇒ ĐỎ', () => {
    const f = (e: R.CmsQaLockEntry, name = `${e.operationId}.json`) => ({ name, text: JSON.stringify(e) })
    const red = (files: { name: string; text: string }[], alive = false) => R.cmsQaLocksCloseCheck(RUN, files, () => alive).reasons.join(' | ')
    expect(red([f(lockEntry())], true)).toMatch(/CÒN CHẠY/)
    expect(red([f(lockEntry())])).toMatch(/không rõ kết thúc.*reconcile --writer=l-0123456789ab/)
    expect(red([f(lockEntry({ status: 'unknown', result: unknownResult }))])).toMatch(/KẾT QUẢ KHÔNG RÕ/)
    expect(red([f(done(), 'l-ffffffffffff.json')])).toMatch(/sai tên file/)
    expect(red([f(done({ qaRunId: 'cms-qa-20261103T101500-ffff' }))])).toMatch(/thuộc run khác/)
    expect(red([{ name: `${OP}.json`, text: '{' }])).toMatch(/hỏng/)
    const rejected = lockEntry({ operationId: OP2, status: 'rejected', result: { ok: false, code: 'CMS_LOCK_RUN_CHANGED', already: false, runId: null, amountVnd: null } })
    expect(R.cmsQaLocksCloseCheck(RUN, [f(done()), f(rejected)], () => false).reasons).toEqual([])

    const pay = (o: Partial<R.CmsQaPayoutRow> = {}): R.CmsQaPayoutRow => ({ program_id: PROG, run_id: RUN_X, locked_by: SUPER, locked_at: '2026-11-03 10:20:00+00', is_test: true, program_is_test: true, program_status: 'locked', ...o })
    const pc = (rows: R.CmsQaPayoutRow[], locks: R.CmsQaLockEntry[], payoutsTable = true) => R.cmsQaPayoutsCloseCheck(rows, locks, { qaUserIds: [SUPER, A, B, SM], payoutsTable })
    const good = pc([pay()], [done()])
    expect(good.reasons).toEqual([])
    expect(good.payouts).toEqual([{ programId: PROG, runId: RUN_X, isTest: true, lockedAt: '2026-11-03 10:20:00+00', operationId: OP }])
    const viaReconcile = lockEntry({ status: 'reconciled', reconcile: { at: 'x', locked: true, payout: { programId: PROG, runId: RUN_X, lockedBy: SUPER, lockedAt: 'x', isTest: true } } })
    expect(pc([pay()], [viaReconcile]).reasons).toEqual([])
    expect(pc([pay()], []).reasons.join(' | ')).toMatch(/chốt ngoài sổ/)
    expect(pc([pay()], [lockEntry({ status: 'unknown', result: unknownResult })]).reasons.join(' | ')).toMatch(/chốt ngoài sổ .*mất phản hồi chưa reconcile/)
    expect(pc([pay({ locked_by: uid(97) })], [done()]).reasons.join(' | ')).toMatch(/chốt ngoài sổ/)
    expect(pc([pay({ run_id: uid(96) })], [done()]).reasons.join(' | ')).toMatch(/chốt ngoài sổ/)
    expect(pc([], [done()]).reasons.join(' | ')).toMatch(/DB không có payout tương ứng/)
    expect(pc([], [done()], false).reasons.join(' | ')).toMatch(/DB không có payout tương ứng/)
    expect(pc([pay({ is_test: false, program_is_test: false, program_id: uid(95) })], []).reasons.join(' | ')).toMatch(/THẬT .* bị tài khoản QA của run chốt/)
    const w = pc([pay({ is_test: false, program_is_test: false, program_id: uid(95), locked_by: uid(94) })], [])
    expect(w.reasons).toEqual([])
    expect(w.warningProgramIds).toEqual([uid(95)])
    expect(R.cmsQaLedgerPartition(['w-0123456789ab.json', 'l-0123456789ab.json', 'x.json', 'l-xyz.json']))
      .toEqual({ writers: ['w-0123456789ab.json'], locks: ['l-0123456789ab.json'], other: ['x.json', 'l-xyz.json'] })
  })
})

test.describe('CMS QA chốt (P3a) — launcher chỉ mở cờ LOCK cho server QA khi opt-in (security review P1-1) @desktop', () => {
  test('LOCK ở shell không opt-in ⇒ chặn; --with-lock cần EARNINGS + LOCK + server; DB phải có 123 và policy thật còn khoá', () => {
    const L = (env: Record<string, string | undefined>, withLock: boolean, server = true) => R.cmsQaLauncherLockCheck({ processEnv: env, withLock, server })
    expect(L({}, false)).toEqual({ ok: true, lock: false })
    expect(L({ CMS_LOCK_ENABLED: 'false', CMS_EARNINGS_ENABLED: 'true' }, false)).toEqual({ ok: true, lock: false })
    const no = (r: ReturnType<typeof L>) => (r.ok ? '' : r.reason)
    expect(no(L({ CMS_LOCK_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true' }, false))).toMatch(/start --with-lock/)
    expect(no(L({}, true))).toMatch(/--with-lock cần CMS_EARNINGS_ENABLED=true và CMS_LOCK_ENABLED=true/)
    expect(no(L({ CMS_LOCK_ENABLED: 'true' }, true))).toMatch(/CMS_EARNINGS_ENABLED=true/)
    expect(no(L({ CMS_LOCK_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true' }, true, false))).toMatch(/--no-server/)
    expect(L({ CMS_LOCK_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true' }, true)).toEqual({ ok: true, lock: true })
    expect(R.cmsQaLauncherLockDbCheck(true, 'false')).toEqual({ ok: true })
    const db = (h: unknown, r: unknown) => { const c = R.cmsQaLauncherLockDbCheck(h, r); return c.ok ? '' : c.reason }
    expect(db(false, null)).toMatch(/chưa có migration 123/)
    expect(db(true, 'true')).toMatch(/policy chốt THẬT không còn khoá/)
    expect(db(true, null)).toMatch(/policy chốt THẬT không còn khoá/)
  })
})

test.describe('CMS QA chốt (P3a r2) — server QA chỉ đọc chốt (PM r1 PKG-P1-2) @desktop', () => {
  test('launcher LUÔN đặt CMS_QA_SERVER=1 cho server con (có / không --with-lock); CLI lock (đường có sổ) không áp chỉ-đọc', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const run = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'cms-qa-run.mjs'), 'utf8')
    expect(run).toContain("const childEnv = { ...env, CMS_PROGRAM_ENABLED: 'true', CMS_QA_SERVER: '1', PORT: String(port), HOSTNAME: 'localhost' }")
    expect(run).not.toMatch(/delete childEnv\.CMS_QA_SERVER/)
    const cli = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'cms-qa-results.mjs'), 'utf8')
    expect(cli).toContain('qaReadonly: () => false,')
    const { cmsQaServerFromEnv } = await import('../lib/cms/flags')
    expect(cmsQaServerFromEnv({ CMS_QA_SERVER: '1' })).toBe(true)
    expect(cmsQaServerFromEnv({ CMS_QA_SERVER: 'true' })).toBe(false) // chỉ đúng giá trị launcher đặt
    expect(cmsQaServerFromEnv({})).toBe(false)
  })
})
