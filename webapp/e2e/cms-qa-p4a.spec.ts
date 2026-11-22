import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import * as T from './cmsQaTooling'
import * as R from './cmsQaResults'
import * as A from './cmsSourceAttest'
import * as P from './cmsQaReport'
import type { CmsQaRunManifest, CmsQaStatusRow } from './cmsQaTooling'

// CMS P4-A (PM 22/11 `planning/reviews/2026-11-22-cms-auto-r2-p4a-tooling-pm.md` §4) — spec THUẦN + CLI âm trước IO cho ba phần công cụ:
// A1 launcher headless (mode + liveness chung + vòng đời), A2 writer nguồn bq (tham số / env / cấu hình / hợp đồng / sổ),
// A3 báo cáo sau chốt QA (sổ, kết cục, reconcile, close). Không mạng, không DB. Phần chạy lõi thật trên DB cô lập: selftest PGlite ngoài Git.

const WEBAPP = path.resolve(__dirname, '..')
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROG = uid(1), PROG2 = uid(2), REALP = uid(3), SUPER = uid(24), STAFF = uid(21), OTHER = uid(31)
const PAY = uid(41), IDEM = uid(51), IDEM2 = uid(52), REP = uid(61), REP2 = uid(62)
const RUN = 'cms-qa-20261122T101500-ab12'
const HEAD = 'a'.repeat(40), TREE = 'b'.repeat(40)
const NONCE = 'c'.repeat(32)
const LP = 4241, SP = 4242
const NOW = 1_800_000_000_000

function base(mode: 'manual-localhost' | 'manual-headless'): CmsQaRunManifest {
  const m = T.newCmsQaManifest({
    runId: RUN, mode, host: 'db.example.test', dbNow: '2026-11-22T10:15:00.000Z', gitHead: HEAD, gitTree: TREE, buildId: 'build',
    port: mode === 'manual-localhost' ? 3120 : null, users: [
      { id: SUPER, role: 'admin', markerExpiresAt: '2026-11-22T20:00:00.000Z', remainingS: 9 * 3600 },
      { id: STAFF, role: 'staff', markerExpiresAt: '2026-11-22T20:00:00.000Z', remainingS: 9 * 3600 },
    ],
  })
  return mode === 'manual-localhost' ? { ...m, serverPid: SP, launcherPid: LP } : { ...m, launcherPid: LP, headless: { nonce: NONCE } }
}
const hb = (o: Partial<T.CmsQaHeartbeat> = {}) => JSON.stringify(T.newCmsQaHeartbeat({ runId: RUN, launcherPid: LP, nonce: NONCE, seq: 3, at: NOW - 2_000, state: 'active', reason: null, ...o }))
const probes = (o: Partial<T.CmsQaLivenessProbes> = {}): T.CmsQaLivenessProbes => ({ pidAlive: (p) => p === LP || p === SP, portUp: true, heartbeatText: hb(), nowMs: NOW, ...o })
const why = (r: ReturnType<typeof T.cmsQaRunLiveness>) => (r.alive ? '' : r.reason)

test.describe('CMS P4-A · A1 mode launcher + liveness chung @desktop', () => {
  test('cờ dòng lệnh ⇒ mode; --headless không đi cùng --no-server; chỉ hai mode thủ công là "có canh"', () => {
    expect(T.cmsQaLauncherMode({ noServer: false, headless: false })).toEqual({ ok: true, value: 'manual-localhost' })
    expect(T.cmsQaLauncherMode({ noServer: false, headless: true })).toEqual({ ok: true, value: 'manual-headless' })
    expect(T.cmsQaLauncherMode({ noServer: true, headless: false })).toEqual({ ok: true, value: 'no-server' })
    expect(T.cmsQaLauncherMode({ noServer: true, headless: true }).ok).toBe(false)
    expect(T.cmsQaModeWatched('manual-localhost')).toBe(true)
    expect(T.cmsQaModeWatched('manual-headless')).toBe(true)
    expect(T.cmsQaModeWatched('no-server')).toBe(false)
    expect(T.cmsQaModeWatched('automated')).toBe(false)
  })

  test('manifest headless: dạng chặt — không cổng / server, có pid + nonce; mode khác không được mang khối headless', () => {
    const ok = (m: unknown) => T.parseCmsQaManifest(JSON.stringify(m))
    expect(ok(base('manual-headless')).ok).toBe(true)
    expect(ok(base('manual-localhost')).ok).toBe(true)
    for (const bad of [
      { ...base('manual-headless'), port: 3120 },
      { ...base('manual-headless'), serverPid: 9 },
      { ...base('manual-headless'), launcherPid: undefined },
      { ...base('manual-headless'), headless: null },
      { ...base('manual-headless'), headless: { nonce: 'xyz' } },
      { ...base('manual-localhost'), headless: { nonce: NONCE } },
    ]) expect(ok(bad).ok, JSON.stringify(bad).slice(0, 120)).toBe(false)
  })

  test('localhost: điều kiện cũ nguyên vẹn (pid launcher + pid server + cổng, không cờ serverNotStopped)', () => {
    const m = base('manual-localhost')
    expect(T.cmsQaRunLiveness(m, probes({ heartbeatText: null }))).toEqual({ alive: true })
    expect(why(T.cmsQaRunLiveness(m, probes({ portUp: false })))).toMatch(/cổng server QA/)
    expect(why(T.cmsQaRunLiveness(m, probes({ pidAlive: (p) => p === SP })))).toMatch(/pid launcher/)
    expect(why(T.cmsQaRunLiveness(m, probes({ pidAlive: (p) => p === LP })))).toMatch(/pid server QA/)
    expect(why(T.cmsQaRunLiveness({ ...m, serverNotStopped: { pid: SP, at: 'x' } } as unknown as CmsQaRunManifest, probes()))).toMatch(/CHƯA DỪNG/)
    expect(why(T.cmsQaRunLiveness({ ...m, launcherPid: undefined }, probes()))).toMatch(/launcherPid/)
    expect(why(T.cmsQaRunLiveness({ ...m, status: 'closed' } as CmsQaRunManifest, probes()))).toMatch(/không còn mở/)
  })

  test('headless: sống CHỈ KHI pid launcher sống + heartbeat đúng lượt, active, còn mới', () => {
    const m = base('manual-headless')
    expect(T.cmsQaRunLiveness(m, probes({ portUp: false }))).toEqual({ alive: true }) // không có cổng — không phải điều kiện
    expect(T.cmsQaRunLiveness(m, probes({ heartbeatText: hb({ at: NOW - T.CMS_QA_HEARTBEAT_MAX_AGE_MS }) }))).toEqual({ alive: true }) // đúng biên
  })

  test('ĐỐI CHỨNG ÂM headless giả sống: thiếu / hỏng / cũ / tương lai / stopped / pid chết / pid tái dùng (nonce lệch) / run khác', () => {
    const m = base('manual-headless')
    const cases: [Partial<T.CmsQaLivenessProbes>, RegExp][] = [
      [{ heartbeatText: null }, /không có heartbeat/],
      [{ heartbeatText: '{' }, /không phải JSON/],
      [{ heartbeatText: JSON.stringify({ kind: 'x' }) }, /sai loại/],
      [{ heartbeatText: hb({ at: NOW - T.CMS_QA_HEARTBEAT_MAX_AGE_MS - 1 }) }, /heartbeat cũ/],
      [{ heartbeatText: hb({ at: NOW + T.CMS_QA_HEARTBEAT_FUTURE_MS + 1 }) }, /tương lai/],
      [{ heartbeatText: hb({ state: 'stopped', reason: 'Ctrl+C' }) }, /đã dừng canh \(Ctrl\+C\)/],
      [{ pidAlive: () => false }, /pid launcher không còn/],
      // pid launcher bị tiến trình KHÁC dùng lại: pid "sống" nhưng không ghi được nhịp của lượt ⇒ nhịp cũ / nonce khác.
      [{ heartbeatText: hb({ nonce: 'd'.repeat(32) }) }, /không thuộc lượt launcher/],
      [{ heartbeatText: hb({ launcherPid: LP + 1 }) }, /không thuộc lượt launcher/],
      [{ heartbeatText: hb({ runId: 'cms-qa-20261122T101500-ffff' }) }, /không thuộc lượt launcher/],
      [{ nowMs: Number.NaN }, /đồng hồ/],
    ]
    for (const [o, re] of cases) expect(why(T.cmsQaRunLiveness(m, probes(o))), String(re)).toMatch(re)
    // pidAlive ném ⇒ coi như chết, không ném ra ngoài.
    expect(why(T.cmsQaRunLiveness(m, probes({ pidAlive: () => { throw new Error('x') } })))).toMatch(/pid launcher không còn/)
  })

  test('ĐỐI CHỨNG ÂM --no-server / automated: KHÔNG BAO GIỜ sống dù pid sống, cổng "mở", có heartbeat hợp lệ', () => {
    const noServer = { ...base('manual-localhost'), port: null, serverPid: null } as CmsQaRunManifest
    expect(why(T.cmsQaRunLiveness(noServer, probes()))).toMatch(/--no-server/)
    const auto = { ...base('manual-localhost'), mode: 'automated' } as CmsQaRunManifest
    expect(why(T.cmsQaRunLiveness(auto, probes()))).toMatch(/automated/)
    // --no-server tự gắn nonce / heartbeat cũng không thành headless: manifest như vậy không qua parse, và mode vẫn là localhost.
    const forged = { ...noServer, headless: { nonce: NONCE } } as CmsQaRunManifest
    expect(T.parseCmsQaManifest(JSON.stringify(forged)).ok).toBe(false)
    expect(T.cmsQaRunLiveness(forged, probes()).alive).toBe(false)
  })

  test('điều kiện cục bộ của mọi lệnh ghi dùng CHUNG helper: headless hợp lệ qua; no-server / automated / launcher chết bị chặn', () => {
    const inp = (m: CmsQaRunManifest, launcherAlive: boolean) => ({ manifest: m, confirmRun: RUN, host: 'db.example.test', treeClean: true, gitHead: HEAD, gitTree: TREE, launcherAlive })
    const H = base('manual-headless'), Lh = base('manual-localhost')
    for (const m of [H, Lh]) {
      expect(R.cmsQaWriterLocalCheck({ ...inp(m, true), staffIds: [STAFF] })).toEqual({ ok: true })
      expect(R.cmsQaBqLocalCheck(inp(m, true))).toEqual({ ok: true })
      expect(R.cmsQaLockLocalCheck({ ...inp(m, true), actorId: SUPER })).toEqual({ ok: true })
      const dead = R.cmsQaBqLocalCheck(inp(m, false))
      expect(dead.ok ? '' : dead.reasons.join('|')).toMatch(/không còn chạy hoặc không còn canh/)
    }
    const ns = R.cmsQaBqLocalCheck(inp({ ...Lh, port: null } as CmsQaRunManifest, true))
    expect(ns.ok ? '' : ns.reasons.join('|')).toMatch(/không có server QA/)
    const au = R.cmsQaLockLocalCheck({ ...inp({ ...Lh, mode: 'automated' } as CmsQaRunManifest, true), actorId: SUPER })
    expect(au.ok ? '' : au.reasons.join('|')).toMatch(/không có server QA/)
    const tree = R.cmsQaBqLocalCheck({ ...inp(H, true), gitTree: 'c'.repeat(40) })
    expect(tree.ok ? '' : tree.reasons.join('|')).toMatch(/HEAD \/ tree hiện tại khác candidate/)
    expect(R.cmsQaBqLocalCheck({ ...inp(H, true), manifest: null })).toEqual({ ok: false, reasons: ['không có run QA đang mở'] })
  })
})

// ── Vòng đời headless: đồng hồ / timer giả ──
function fakeClock(start = 0) {
  let now = start
  let seq = 0
  const timers: { id: number; fn: () => void; ms: number; next: number }[] = []
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return {
    now: () => now,
    setInterval: (fn: () => void, ms: number) => { const id = ++seq; timers.push({ id, fn, ms, next: now + ms }); return id },
    clearInterval: (h: unknown) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1) },
    timers,
    async advanceTo(target: number) {
      for (;;) {
        const due = timers.filter((t) => t.next <= target).sort((a, b) => a.next - b.next || a.id - b.id)[0]
        if (!due) break
        now = due.next
        due.next += due.ms
        due.fn()
        await flush()
      }
      now = target
      await flush()
    },
  }
}
const srow = (remaining: number): CmsQaStatusRow => ({
  user_id: SUPER, user_exists: true, role: 'admin', store_type: null, store_active: null, granted_by: 'qa-script:operator',
  granted_at: '2026-11-22T01:00:00.000Z', expires_at: '2026-11-22T20:00:00.000Z', db_now: '2026-11-22T10:00:00.000Z', active: remaining > 0, remaining_s: remaining,
})

test.describe('CMS P4-A · A1 vòng đời launcher headless (timer giả) @desktop', () => {
  function world(o: { pre?: number; poll?: () => Promise<CmsQaStatusRow[]>; check?: () => string | null; beatFail?: (n: number, state: string) => boolean } = {}) {
    const c = fakeClock()
    const beats: { state: string; reason: string | null; at: number }[] = []
    const sig: Record<string, (() => void)[]> = { SIGINT: [], SIGTERM: [] }
    const logs: string[] = []
    let n = 0
    const p = T.runCmsQaHeadlessLifecycle({
      watchdog: T.createCmsQaWatchdog({ userIds: [SUPER], guardMinutes: 10 }), preRows: [srow(o.pre ?? 3 * 3600)], preStartedAt: 0,
      poll: o.poll ?? (() => Promise.resolve([srow(3 * 3600)])),
      beat: (state, reason) => { n += 1; if (o.beatFail?.(n, state)) throw new Error('EPERM giả'); beats.push({ state, reason, at: c.now() }) },
      check: o.check, now: c.now, setInterval: c.setInterval, clearInterval: c.clearInterval,
      onSignal: (s, fn) => { sig[s].push(fn) }, offSignal: (s, fn) => { sig[s] = sig[s].filter((f) => f !== fn) },
      log: (l) => logs.push(l),
    })
    return { c, beats, sig, logs, p }
  }

  test('chạy bình thường: nhịp đầu NGAY (CLI thấy sống), sau đó mỗi 5 s; Ctrl+C ⇒ nhịp stopped, mã 0, gỡ timer + handler', async () => {
    const w = world()
    await w.c.advanceTo(0)
    expect(w.beats).toEqual([{ state: 'active', reason: null, at: 0 }])
    await w.c.advanceTo(21_000)
    expect(w.beats.filter((b) => b.state === 'active').map((b) => b.at)).toEqual([0, 5_000, 10_000, 15_000, 20_000])
    w.sig.SIGINT[0]()
    const r = await w.p
    expect(r).toMatchObject({ rc: 0, stopKind: 'operator', reason: 'Ctrl+C', beats: 5 })
    expect(w.beats.at(-1)).toMatchObject({ state: 'stopped', reason: 'Ctrl+C' })
    expect(w.c.timers).toEqual([])
    expect(w.sig.SIGINT.length + w.sig.SIGTERM.length).toBe(0)
    await w.c.advanceTo(120_000)
    expect(w.beats.at(-1)?.state).toBe('stopped') // không nhịp active nào sau khi dừng
  })

  test('marker không đủ hạn ngay preflight ⇒ KHÔNG nhịp active nào, mã 1', async () => {
    const w = world({ pre: 60 })
    const r = await w.p
    expect(r).toMatchObject({ rc: 1, stopKind: 'watchdog', beats: 0 })
    expect(w.beats.every((b) => b.state === 'stopped')).toBe(true)
  })

  test('marker sắp hết (poll báo còn dưới ngưỡng) ⇒ dừng canh, nhịp stopped, mã 1; không nhịp active sau đó', async () => {
    let calls = 0
    const w = world({ poll: () => Promise.resolve([srow(++calls >= 2 ? 300 : 3 * 3600)]) })
    await w.c.advanceTo(10 * 60_000)
    const r = await w.p
    expect(r).toMatchObject({ rc: 1, stopKind: 'watchdog' })
    const stopAt = w.beats.find((b) => b.state === 'stopped')?.at ?? -1
    expect(stopAt).toBeGreaterThan(0)
    expect(w.beats.filter((b) => b.state === 'active' && b.at > stopAt)).toEqual([])
  })

  test('DB không đọc được liên tiếp / poll treo ⇒ dừng theo canh marker (lỗi liên tiếp hoặc hạn độc lập), mã 1', async () => {
    const a = world({ poll: () => Promise.reject(new Error('pg-meta lỗi')) })
    await a.c.advanceTo(10 * 60_000)
    expect(await a.p).toMatchObject({ rc: 1, stopKind: 'watchdog' })
    const b = world({ pre: 1200, poll: () => new Promise<CmsQaStatusRow[]>(() => {}) })
    await b.c.advanceTo(30 * 60_000)
    const rb = await b.p
    expect(rb).toMatchObject({ rc: 1, stopKind: 'watchdog' })
    // dừng TRƯỚC hạn marker − ngưỡng: marker còn 1200 s từ t=0, ngưỡng 600 s ⇒ nhịp active cuối ≤ 600 s.
    expect(Math.max(...b.beats.filter((x) => x.state === 'active').map((x) => x.at))).toBeLessThanOrEqual(600_000)
  })

  test('cây Git / HEAD đổi hoặc manifest không còn của lượt (check trả lý do / ném) ⇒ dừng TRƯỚC khi ghi nhịp kế, mã 1', async () => {
    let bad: string | null = null
    const w = world({ check: () => bad })
    await w.c.advanceTo(10_000)
    bad = 'HEAD / tree đã đổi so với candidate của run'
    await w.c.advanceTo(15_000)
    const r = await w.p
    expect(r).toMatchObject({ rc: 1, stopKind: 'error', reason: 'HEAD / tree đã đổi so với candidate của run' })
    expect(w.beats.filter((b) => b.state === 'active').map((b) => b.at)).toEqual([0, 5_000, 10_000])
    const t = world({ check: () => { throw new Error('git lỗi') } })
    expect(await t.p).toMatchObject({ rc: 1, stopKind: 'error', beats: 0 })
  })

  test('không ghi được heartbeat ⇒ fail-closed (dừng, mã 1); ghi stopped cũng lỗi ⇒ vẫn kết thúc (nhịp cũ tự quá hạn)', async () => {
    const w = world({ beatFail: (n) => n >= 3 })
    await w.c.advanceTo(60_000)
    const r = await w.p
    expect(r).toMatchObject({ rc: 1, stopKind: 'error', beats: 2 })
    expect(r.reason).toMatch(/không ghi được heartbeat/)
    expect(w.logs.join('\n')).toMatch(/nhịp cũ tự quá hạn/)
    expect(w.c.timers).toEqual([])
  })

  test('SIGTERM ⇒ operator, mã 0', async () => {
    const w = world()
    await w.c.advanceTo(5_000)
    w.sig.SIGTERM[0]()
    expect(await w.p).toMatchObject({ rc: 0, stopKind: 'operator', reason: 'SIGTERM' })
  })
})

test.describe('CMS P4-A · A1 guard chứng nhận / báo cáo dùng liveness chung @desktop', () => {
  const TS = '2026-11-22T20:00:00.000Z'
  const mk = (mode: 'manual-localhost' | 'manual-headless') => {
    const m = { ...base(mode), programs: [{ id: PROG, status: 'active', isTest: true }] } as unknown as CmsQaRunManifest
    return { m, text: JSON.stringify(m, null, 2) }
  }
  function worldOf(mode: 'manual-localhost' | 'manual-headless', progStatus = 'active') {
    const { m, text } = mk(mode)
    let t = 5_000_000
    const w = { text: text as string | null, alive: new Set([LP, SP]), port: true, hbText: hb() as string | null, wall: NOW }
    const d: A.CmsAttestGuardDeps = {
      now: () => t, manifestText: () => w.text,
      parseManifest: (s) => { const p = T.parseCmsQaManifest(s); return p.ok ? p.value : null },
      git: () => ({ treeClean: true, gitHead: HEAD, gitTree: TREE }),
      pidAlive: (pid) => w.alive.has(pid), portOpen: async () => w.port,
      heartbeatText: () => w.hbText, wallNow: () => w.wall,
      read: async (sql) => (/cms_qa_access/.test(sql) ? [SUPER, STAFF].map((id) => ({ user_id: id, user_exists: true, active: true, remaining_s: 3600 }))
        : [{ id: PROG, is_test: true, status: progStatus, qa_created_in_run: false }]),
    }
    const gIn = (statuses?: readonly string[]) => ({ manifestText: text, manifest: m, confirmRun: RUN, host: 'db.example.test', actorId: SUPER, programId: PROG,
      deadlineAt: t + A.CMS_ATTEST_QA_BUDGET_MS, ...(statuses ? { statuses } : {}) })
    return { w, d, gIn, TS }
  }

  test('headless: guard đạt khi heartbeat mới; heartbeat đổi NGAY TRƯỚC final (launcher vừa dừng) ⇒ chặn — không cần cổng', async () => {
    const s = worldOf('manual-headless')
    s.w.port = false
    expect((await A.cmsAttestQaGuard(s.d, s.gIn())).final()).toMatchObject({ ok: true })
    const g = await A.cmsAttestQaGuard(s.d, s.gIn())
    s.w.hbText = hb({ state: 'stopped', reason: 'Ctrl+C' }) // sau pha IO, trước bước cuối đồng bộ
    expect(JSON.stringify(g.final())).toMatch(/launcher \/ server QA/)
    s.w.hbText = hb()
    s.w.wall = NOW + 60_000 // heartbeat cũ dần (launcher treo)
    expect((await A.cmsAttestQaGuard(s.d, s.gIn())).final()).toMatchObject({ ok: false })
    s.w.wall = NOW
    s.w.hbText = null
    expect((await A.cmsAttestQaGuard(s.d, s.gIn())).final()).toMatchObject({ ok: false })
  })

  test('localhost: hành vi cũ (cổng đóng ⇒ chặn; heartbeat không liên quan)', async () => {
    const s = worldOf('manual-localhost')
    s.w.hbText = null
    expect((await A.cmsAttestQaGuard(s.d, s.gIn())).final()).toMatchObject({ ok: true })
    s.w.port = false
    expect((await A.cmsAttestQaGuard(s.d, s.gIn())).final()).toMatchObject({ ok: false })
  })

  test('trạng thái chương trình: mặc định chỉ active; báo cáo sau chốt truyền [locked] — không nới cho lệnh khác', async () => {
    const act = worldOf('manual-headless', 'active'), lck = worldOf('manual-headless', 'locked')
    expect((await A.cmsAttestQaGuard(act.d, act.gIn())).final()).toMatchObject({ ok: true })
    expect((await A.cmsAttestQaGuard(lck.d, lck.gIn())).final()).toMatchObject({ ok: false })
    expect((await A.cmsAttestQaGuard(lck.d, lck.gIn(['locked']))).final()).toMatchObject({ ok: true })
    expect(JSON.stringify((await A.cmsAttestQaGuard(act.d, act.gIn(['locked']))).final())).toMatch(/không thuộc \[locked\]/)
  })
})

test.describe('CMS P4-A · A2 writer nguồn bq — tham số, env PROCESS, cấu hình, hợp đồng, sổ @desktop', () => {
  test('--source: mặc định fixture (writer cũ không đổi); chỉ nhận fixture | bq', () => {
    expect(R.parseCmsQaWriterSource(undefined)).toEqual({ ok: true, value: 'fixture' })
    expect(R.parseCmsQaWriterSource('fixture')).toEqual({ ok: true, value: 'fixture' })
    expect(R.parseCmsQaWriterSource('bq')).toEqual({ ok: true, value: 'bq' })
    for (const bad of ['', 'BQ', 'bigquery', 'auto', 'legacy']) expect(R.parseCmsQaWriterSource(bad).ok, bad).toBe(false)
  })

  test('--expect-*: bắt buộc đủ ba, giá trị trong danh sách', () => {
    expect(R.parseCmsQaBqExpect({ cv: '3', basis: 'cms_unit', policy: 'full_line_qty_refund_v1' })).toEqual({ ok: true, value: { cv: 3, basis: 'cms_unit', policy: 'full_line_qty_refund_v1' } })
    for (const bad of [
      { cv: undefined, basis: 'pos_base', policy: 'sales_only_v1' }, { cv: '1', basis: undefined, policy: 'sales_only_v1' }, { cv: '1', basis: 'pos_base', policy: undefined },
      { cv: '0', basis: 'pos_base', policy: 'sales_only_v1' }, { cv: '1.5', basis: 'pos_base', policy: 'sales_only_v1' }, { cv: '1', basis: 'unit', policy: 'sales_only_v1' },
      { cv: '1', basis: 'pos_base', policy: 'full_line' },
    ]) expect(R.parseCmsQaBqExpect(bad).ok, JSON.stringify(bad)).toBe(false)
  })

  test('cờ + view là biến PROCESS: thiếu ⇒ chặn; cờ nằm trong .env.local ⇒ chặn (không lấy cờ từ tệp, không đổi container)', () => {
    const full = { CMS_CALC_MODES_ENABLED: 'true', CMS_RETURNS_ENABLED: 'true', CMS_BQ_SALES_TABLE: 'p.d.sales', CMS_BQ_RETURNS_TABLE: 'p.d.returns' }
    expect(R.cmsQaBqSourceEnvCheck(full, null)).toEqual({ ok: true })
    expect(R.cmsQaBqSourceEnvCheck(full, 'OTHER=1\n# CMS_RETURNS_ENABLED=true\nCMS_RETURNS_ENABLED=false\n')).toEqual({ ok: true })
    for (const k of R.CMS_QA_BQ_PROCESS_VARS) {
      const r = R.cmsQaBqSourceEnvCheck({ ...full, [k]: undefined }, null)
      expect(r.ok ? '' : r.reason, k).toContain(k)
    }
    expect(R.cmsQaBqSourceEnvCheck({ ...full, CMS_RETURNS_ENABLED: 'TRUE' }, null).ok).toBe(false)
    for (const line of ['CMS_RETURNS_ENABLED=true', 'export CMS_CALC_MODES_ENABLED = "true"  # x', "  CMS_RETURNS_ENABLED='true'"]) {
      const r = R.cmsQaBqSourceEnvCheck(full, `A=1\n${line}\n`)
      expect(r.ok ? '' : r.reason, line).toMatch(/\.env\.local/)
    }
  })

  test('cấu hình chương trình phải khớp bộ operator gõ lại (cv / cách tính / policy) — lệch từng trường ⇒ lý do', () => {
    const e = { cv: 3, basis: 'cms_unit', policy: 'full_line_qty_refund_v1' } as const
    const row = { id: PROG, config_version: 3, quantity_basis: 'cms_unit', returns_policy: 'full_line_qty_refund_v1' }
    expect(R.cmsQaBqProfileCheck(row, e)).toEqual([])
    expect(R.cmsQaBqProfileCheck({ ...row, config_version: '3' }, e)).toEqual([]) // pg-meta có thể trả text
    expect(R.cmsQaBqProfileCheck({ ...row, config_version: 4 }, e).join()).toMatch(/config_version/)
    expect(R.cmsQaBqProfileCheck({ ...row, quantity_basis: 'pos_base' }, e).join()).toMatch(/cách tính/)
    expect(R.cmsQaBqProfileCheck({ ...row, returns_policy: 'sales_only_v1' }, e).join()).toMatch(/policy trả/)
    expect(R.cmsQaBqProfileCheck(undefined, e).join()).toMatch(/không đọc được cấu hình/)
    expect(R.cmsQaWriterProfileSql(PROG)).toMatch(/^SELECT /)
    expect(R.cmsQaWriterProfileSql(PROG)).not.toMatch(/INSERT|UPDATE|DELETE/i)
    expect(() => R.cmsQaWriterProfileSql("x'; DROP")).toThrow()
  })

  test('hợp đồng run DB ghim: khớp cách tính + policy + provider bq; fixture / lệch / legacy không đúng kỳ vọng ⇒ false (không fallback)', () => {
    const e = { cv: 3, basis: 'cms_unit', policy: 'full_line_qty_refund_v1' } as const
    const c = { quantityBasis: 'cms_unit', returnsPolicy: 'full_line_qty_refund_v1', provider: 'bq' }
    expect(R.cmsQaBqContractMatch(c, e)).toBe(true)
    expect(R.cmsQaBqContractMatch({ ...c, provider: 'fixture' }, e)).toBe(false)
    expect(R.cmsQaBqContractMatch({ ...c, returnsPolicy: 'sales_only_v1' }, e)).toBe(false)
    expect(R.cmsQaBqContractMatch({ ...c, quantityBasis: 'pos_base' }, e)).toBe(false)
    expect(R.cmsQaBqContractMatch(null, e)).toBe(false) // run legacy không bao giờ là full_line
    expect(R.cmsQaBqContractMatch('x', e)).toBe(false)
    expect(R.cmsQaBqContractMatch(null, { cv: 1, basis: 'pos_base', policy: 'sales_only_v1' })).toBe(true)
  })

  test('sổ writer: nguồn bq mang kỳ vọng, không staff / dòng giả; nguồn giả giữ dạng cũ; parse từ chối sổ bq thiếu kỳ vọng', () => {
    const e = { cv: 3, basis: 'cms_unit', policy: 'full_line_qty_refund_v1' } as const
    const common = { writerId: 'w-0123456789ab', qaRunId: RUN, pid: 77, programId: PROG, now: '2026-11-22T10:20:00.000Z' }
    const bq = R.newCmsQaWriterEntry({ ...common, staff: [], lines: 0, source: 'bq', expect: e })
    expect(bq).toMatchObject({ source: 'bq', expect: e, net: null, status: 'running', staff: [], lines: 0 })
    expect(R.parseCmsQaWriterEntry(JSON.stringify(bq)).ok).toBe(true)
    const old = R.newCmsQaWriterEntry({ ...common, staff: [STAFF], lines: 30 })
    expect('source' in old || 'expect' in old || 'net' in old).toBe(false)
    expect(R.parseCmsQaWriterEntry(JSON.stringify(old)).ok).toBe(true)
    expect(() => R.newCmsQaWriterEntry({ ...common, staff: [STAFF], lines: 0, source: 'bq', expect: e })).toThrow()
    expect(() => R.newCmsQaWriterEntry({ ...common, staff: [], lines: 0, source: 'bq' })).toThrow()
    expect(() => R.newCmsQaWriterEntry({ ...common, staff: [STAFF], lines: 30, expect: e })).toThrow()
    expect(R.parseCmsQaWriterEntry(JSON.stringify({ ...bq, expect: null })).ok).toBe(false)
    expect(R.parseCmsQaWriterEntry(JSON.stringify({ ...bq, source: 'legacy' })).ok).toBe(false)
  })

  test('ĐỐI CHỨNG ÂM run ownership / journal binding: close chỉ nhận run mang tag của writer CÓ SỔ biết run; receipt giả / thiếu tag ⇒ ĐỎ', () => {
    const e = { cv: 3, basis: 'cms_unit', policy: 'full_line_qty_refund_v1' } as const
    const RID = uid(71)
    const w = { ...R.newCmsQaWriterEntry({ writerId: 'w-0123456789ab', qaRunId: RUN, pid: 77, programId: PROG, staff: [], lines: 0, now: '2026-11-22T10:20:00.000Z', source: 'bq', expect: e }),
      status: 'done' as const, openedRunId: RID, finishedAt: '2026-11-22T10:21:00.000Z',
      result: { status: 'published', code: null, runId: RID, stagedRows: 4, rowsRead: 4, candidates: 4, included: 4, unassigned: 0, sourceRows: null } }
    const row = (o: Record<string, unknown> = {}) => ({ id: RID, program_id: PROG, is_test: true, status: 'published', source: 'qa', error_code: null, qa_run_id: RUN, qa_writer_id: 'w-0123456789ab', ...o })
    const chk = (rows: unknown[], ws: unknown[]) => R.cmsQaSalesRunsCheck(rows as R.CmsQaSalesRunRow[], ws as R.CmsQaWriterEntry[], { qaRunId: RUN, releaseOpen: true }).reasons
    expect(chk([row()], [w])).toEqual([])
    expect(chk([row()], []).length).toBeGreaterThan(0) // run có tag nhưng KHÔNG có sổ (receipt giả / sổ bị xoá)
    expect(chk([row({ qa_writer_id: 'w-ffffffffffff' })], [w]).length).toBeGreaterThan(0) // tag writer khác
    expect(chk([row({ qa_run_id: 'cms-qa-20261122T101500-ffff' })], [w]).length).toBeGreaterThan(0) // run QA khác
    expect(chk([row({ source: 'operator', qa_run_id: null, qa_writer_id: null })], [w]).length).toBeGreaterThan(0) // sync-qa-net ngoài (nguồn operator) trong cửa sổ
    expect(chk([row({ id: uid(72) })], [w]).length).toBeGreaterThan(0) // sổ không biết run này
    expect(chk([row({ status: 'running' })], [w]).length).toBeGreaterThan(0) // run QA chưa khép
    expect(chk([row({ program_id: REALP, is_test: false })], [w]).length).toBeGreaterThan(0) // writer QA trên chương trình THẬT
  })
})

// PM 22/11 `planning/reviews/2026-11-22-cms-p4a-candidate-audit-pm.md` §3 — R2-b (hợp đồng run DB khi reconcile / close) + R2-c (close ↔ pid launcher).
test.describe('CMS P4-A r1 · R2-b hợp đồng của RUN TRONG DB so với kỳ vọng của sổ @desktop', () => {
  const WID = 'w-0123456789ab', WID2 = 'w-ffffffffffff'
  const RID = uid(71), RID2 = uid(72)
  const exp = { cv: 3, basis: 'cms_unit', policy: 'full_line_qty_refund_v1' } as const
  const ent = (o: Record<string, unknown> = {}) => ({ ...R.newCmsQaWriterEntry({ writerId: WID, qaRunId: RUN, pid: 77, programId: PROG, staff: [], lines: 0, now: '2026-11-22T10:20:00.000Z', source: 'bq', expect: exp }), ...o }) as R.CmsQaWriterEntry
  const crow = (o: Record<string, unknown> = {}): R.CmsQaBqRunContractRow => ({ id: RID, program_id: PROG, is_test: true, status: 'ok', config_version: 3, quantity_basis: 'cms_unit',
    returns_policy: 'full_line_qty_refund_v1', calc_contract_version: 'cms-calc-ret2-v2', status_dictionary_version: 'cms-return-status-v2', pin_provider: 'bq', source: 'qa', qa_run_id: RUN, qa_writer_id: WID, ...o } as R.CmsQaBqRunContractRow)
  const srow = (o: Record<string, unknown> = {}) => ({ id: RID, program_id: PROG, is_test: true, status: 'ok', source: 'qa', error_code: null, qa_run_id: RUN, qa_writer_id: WID, ...o }) as R.CmsQaSalesRunRow
  const file = (e: R.CmsQaWriterEntry) => ({ name: `${e.writerId}.json`, text: JSON.stringify(e) })

  test('SQL chỉ đọc đúng cột đã ghim của run (không đọc cấu hình chương trình); id sai / rỗng bị từ chối', () => {
    const s = R.cmsQaBqRunContractSql([RID, RID2])
    expect(s).toMatch(/^SELECT /)
    expect(s).toContain('FROM public.cms_sync_runs r')
    for (const c of ['r.config_version', 'r.quantity_basis', 'r.returns_policy', 'r.calc_contract_version', 'r.status_dictionary_version', "r.source_pin ->> 'provider'", "r.detail ->> 'qa_writer_id'"]) expect(s).toContain(c)
    expect(s).not.toMatch(/cms_programs|INSERT|UPDATE|DELETE|;/i)
    expect(() => T.pgMetaReadOnly(s)).not.toThrow()
    expect(() => R.cmsQaBqRunContractSql([])).toThrow()
    expect(() => R.cmsQaBqRunContractSql(["x' OR 1=1 --"])).toThrow()
  })

  test('run đúng mọi trường ⇒ khớp; ĐỐI CHỨNG ÂM từng phần: cv / cách tính / policy / calc / từ điển / provider / thiếu pin / tag / is_test / chương trình / không có dòng', () => {
    const e = ent()
    expect(R.cmsQaBqRunContractCheck(crow(), e, RID)).toEqual({ runId: RID, status: 'ok', match: true, reasons: [] })
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ config_version: 4 }, /config_version/], [{ config_version: null }, /config_version/], [{ config_version: '3x' }, /config_version/],
      [{ quantity_basis: 'pos_base' }, /cách tính/], [{ returns_policy: 'net_returns_v1' }, /policy trả/], [{ returns_policy: null }, /policy trả/],
      [{ calc_contract_version: 'cms-calc-ret2-v1' }, /calc_contract_version/], [{ status_dictionary_version: 'cms-return-status-v1' }, /status_dictionary_version/],
      [{ pin_provider: 'fixture' }, /provider/], [{ pin_provider: null }, /provider/],
      [{ qa_writer_id: WID2 }, /tag run/], [{ qa_run_id: 'cms-qa-20261122T101500-ffff' }, /tag run/], [{ source: 'operator' }, /tag run/],
      [{ is_test: false }, /is_test/], [{ program_id: PROG2 }, /khác chương trình/], [{ id: RID2 }, /khác run/],
    ]
    for (const [o, re] of bad) {
      const v = R.cmsQaBqRunContractCheck(crow(o), e, RID)
      expect(v.match, JSON.stringify(o)).toBe(false)
      expect(v.reasons.join('; ')).toMatch(re)
    }
    expect(R.cmsQaBqRunContractCheck(undefined, e, RID).match).toBe(false) // không đọc được ⇒ KHÔNG khớp
    expect(R.cmsQaBqRunContractCheck(crow(), { ...e, expect: null }, RID).match).toBe(false)
    // config_version dạng chuỗi số (pg-meta) vẫn so đúng
    expect(R.cmsQaBqRunContractCheck(crow({ config_version: '3' }), e, RID).match).toBe(true)
    // kỳ vọng legacy: mọi cột hợp đồng NULL mới khớp; run mang hợp đồng ⇒ lệch
    const leg = ent({ expect: { cv: 3, basis: 'pos_base', policy: 'sales_only_v1' } })
    const nul = { quantity_basis: null, returns_policy: null, calc_contract_version: null, status_dictionary_version: null, pin_provider: null }
    expect(R.cmsQaBqRunContractCheck(crow(nul), leg, RID).match).toBe(true)
    expect(R.cmsQaBqRunContractCheck(crow(), leg, RID).match).toBe(false)
    // policy net_returns_v1 ⇒ bộ phiên bản v1
    const netE = ent({ expect: { cv: 3, basis: 'cms_unit', policy: 'net_returns_v1' } })
    expect(R.cmsQaBqRunContractCheck(crow({ returns_policy: 'net_returns_v1', calc_contract_version: 'cms-calc-ret2-v1', status_dictionary_version: 'cms-return-status-v1' }), netE, RID).match).toBe(true)
    expect(R.cmsQaBqRunContractCheck(crow({ returns_policy: 'net_returns_v1' }), netE, RID).match).toBe(false)
  })

  test('reconcile: chỉ run ĐÃ CÔNG BỐ bị đòi hợp đồng; run error / held / running giữ luồng cũ; không có run ⇒ không có gì để nhận', () => {
    const e = ent({ status: 'unknown' })
    expect(R.cmsQaBqRunsVerdicts(e, [{ id: RID, status: 'ok' }], [crow()])).toEqual([{ runId: RID, status: 'ok', match: true, reasons: [] }])
    expect(R.cmsQaBqRunsVerdicts(e, [{ id: RID, status: 'ok' }], [])[0].match).toBe(false) // run ok mà không đọc được metadata
    expect(R.cmsQaBqRunsVerdicts(e, [{ id: RID, status: 'error' }, { id: RID2, status: 'held' }], [])).toEqual([])
    expect(R.cmsQaBqRunsVerdicts(e, [], [])).toEqual([])
  })

  test('mục sổ: hợp đồng hiệu lực — done theo net.expectMatch; reconciled theo reconcile.contract; run ok CHƯA kiểm ⇒ false (không suy đúng từ việc tìm thấy run)', () => {
    const res = (status: string) => ({ status, code: null, runId: RID, stagedRows: 1, rowsRead: 1, candidates: 1, included: 1, unassigned: 0, sourceRows: null })
    const net = (m: boolean | null) => ({ amountVnd: '1', resultHash: 'h', contract: null, expectMatch: m })
    const rec = (status: string, contract?: R.CmsQaBqRunVerdict[]) => ({ at: '2026-11-22T10:25:00.000Z', runs: [{ id: RID, status, errorCode: null }], finishedOrphan: null, ...(contract ? { contract } : {}) })
    expect(R.cmsQaBqEntryMatch(ent({ status: 'done', result: res('published'), net: net(true) }))).toBe(true)
    expect(R.cmsQaBqEntryMatch(ent({ status: 'done', result: res('published'), net: net(false) }))).toBe(false)
    expect(R.cmsQaBqEntryMatch(ent({ status: 'done', result: res('published'), net: net(null) }))).toBe(false)
    expect(R.cmsQaBqEntryMatch(ent({ status: 'done', result: res('held'), net: net(false) }))).toBeNull()
    expect(R.cmsQaBqEntryMatch(ent({ status: 'reconciled', reconcile: rec('ok', [{ runId: RID, status: 'ok', match: true, reasons: [] }]) }))).toBe(true)
    expect(R.cmsQaBqEntryMatch(ent({ status: 'reconciled', reconcile: rec('ok', [{ runId: RID, status: 'ok', match: false, reasons: ['x'] }]) }))).toBe(false)
    expect(R.cmsQaBqEntryMatch(ent({ status: 'reconciled', reconcile: rec('ok') }))).toBe(false) // sổ reconcile kiểu cũ: tìm thấy run nhưng chưa kiểm
    expect(R.cmsQaBqEntryMatch(ent({ status: 'reconciled', reconcile: rec('ok', [{ runId: RID2, status: 'ok', match: true, reasons: [] }]) }))).toBe(false) // kết quả của run khác
    expect(R.cmsQaBqEntryMatch(ent({ status: 'reconciled', reconcile: rec('error') }))).toBeNull() // không có run công bố
    expect(R.cmsQaBqEntryMatch({ ...ent({ status: 'reconciled', reconcile: rec('ok') }), source: 'fixture' } as R.CmsQaWriterEntry)).toBeNull() // writer nguồn giả: không áp
  })

  test('close theo SỔ: unknown→reconciled đúng hợp đồng ⇒ xanh; reconciled lệch / chưa kiểm ⇒ ĐỎ; có lượt bq khớp SAU đó ⇒ hết đỏ; không có run ⇒ không coi là đã publish', () => {
    const rec = (status: string, contract?: R.CmsQaBqRunVerdict[]) => ({ at: '2026-11-22T10:25:00.000Z', runs: [{ id: RID, status, errorCode: null }], finishedOrphan: null, ...(contract ? { contract } : {}) })
    const fin = { finishedAt: '2026-11-22T10:25:00.000Z', result: { status: 'error', code: 'PUBLISH_UNKNOWN', runId: RID, stagedRows: 1, rowsRead: 1, candidates: 1, included: 1, unassigned: 0, sourceRows: null } }
    const good = ent({ status: 'reconciled', ...fin, reconcile: rec('ok', [{ runId: RID, status: 'ok', match: true, reasons: [] }]) })
    const badE = ent({ status: 'reconciled', ...fin, reconcile: rec('ok', [{ runId: RID, status: 'ok', match: false, reasons: ['config_version của run (4) khác --expect-cv (3)'] }]) })
    const unchecked = ent({ status: 'reconciled', ...fin, reconcile: rec('ok') })
    const none = ent({ status: 'reconciled', ...fin, reconcile: { at: '2026-11-22T10:25:00.000Z', runs: [], finishedOrphan: null, contract: [] } })
    const chk = (...es: R.CmsQaWriterEntry[]) => R.cmsQaWritersCloseCheck(RUN, es.map(file), () => false).reasons
    expect(chk(good)).toEqual([])
    expect(chk(badE).join()).toMatch(/reconciled có run đã công bố nhưng hợp đồng run trong DB LỆCH/)
    expect(chk(unchecked).join()).toMatch(/CHƯA được kiểm/)
    expect(chk(none)).toEqual([]) // không run công bố: không đỏ vì hợp đồng — và cmsQaBqEntryMatch = null (không được tính là lượt khớp)
    expect(R.cmsQaBqEntryMatch(none)).toBeNull()
    const later = { ...good, writerId: WID2, finishedAt: '2026-11-22T10:40:00.000Z' } as R.CmsQaWriterEntry
    expect(chk(badE, later)).toEqual([])
    expect(chk(badE, { ...later, finishedAt: '2026-11-22T10:00:00.000Z' } as R.CmsQaWriterEntry).join()).toMatch(/LỆCH/) // lượt khớp TRƯỚC không gỡ
    expect(chk(badE, { ...later, programId: PROG2 } as R.CmsQaWriterEntry).join()).toMatch(/LỆCH/) // chương trình khác không gỡ
    expect(chk(badE, { ...none, writerId: WID2, finishedAt: '2026-11-22T10:40:00.000Z' } as R.CmsQaWriterEntry).join()).toMatch(/LỆCH/) // lượt không có run không gỡ
  })

  test('close theo DB (cùng nghĩa cho lượt thường và lượt reconcile): run ok của writer bq lệch metadata ⇒ ĐỎ dù sổ ghi khớp; run bq khớp SAU đó ⇒ hết đỏ; writer nguồn giả không bị xét', () => {
    const w = ent({ status: 'done', openedRunId: RID })
    expect(R.cmsQaBqRunsCloseCheck([w], [srow()], [crow()])).toEqual([])
    expect(R.cmsQaBqRunsCloseCheck([w], [srow()], [crow({ config_version: 9 })]).join()).toMatch(/LỆCH kỳ vọng của sổ: config_version/)
    expect(R.cmsQaBqRunsCloseCheck([w], [srow()], []).join()).toMatch(/không đọc được metadata/) // thiếu dòng hợp đồng ⇒ ĐỎ
    expect(R.cmsQaBqRunsCloseCheck([w], [srow({ status: 'error' })], [])).toEqual([]) // run chưa công bố: luồng cũ
    const w2 = ent({ writerId: WID2, status: 'done', openedRunId: RID2 })
    const s2 = srow({ id: RID2, qa_writer_id: WID2 }), c2 = crow({ id: RID2, qa_writer_id: WID2 })
    expect(R.cmsQaBqRunsCloseCheck([w, w2], [srow(), s2], [crow({ pin_provider: 'fixture' }), c2])).toEqual([]) // lệch rồi có run khớp sau
    expect(R.cmsQaBqRunsCloseCheck([w, w2], [s2, srow()], [crow({ pin_provider: 'fixture' }), c2]).join()).toMatch(/provider/) // run khớp đứng TRƯỚC không gỡ
    expect(R.cmsQaBqRunsCloseCheck([w, w2], [srow(), { ...s2, program_id: PROG2 }], [crow({ pin_provider: 'fixture' }), { ...c2, program_id: PROG2 }]).length).toBeGreaterThan(0)
    const fx = { ...w, source: undefined, expect: undefined } as unknown as R.CmsQaWriterEntry
    expect(R.cmsQaBqRunsCloseCheck([fx], [srow()], [])).toEqual([])
  })
})

test.describe('CMS P4-A r1 · R2-c close ↔ pid launcher headless (tách khỏi liveness "đủ khoẻ để ghi") @desktop', () => {
  const M = base('manual-headless')
  const aliveLP = (p: number) => p === LP
  test('pid SỐNG ⇒ từ chối dù heartbeat mới / cũ / stopped / mất; pid CHẾT ⇒ đi tiếp; pid thiếu / không kiểm được ⇒ dừng; mode khác không áp', () => {
    // liveness (đủ khoẻ để ghi) đổi theo heartbeat — còn close thì KHÔNG phụ thuộc heartbeat
    expect(T.cmsQaRunLiveness(M, probes()).alive).toBe(true)
    expect(T.cmsQaRunLiveness(M, probes({ heartbeatText: hb({ at: NOW - 60_000 }) })).alive).toBe(false)
    expect(T.cmsQaRunLiveness(M, probes({ heartbeatText: hb({ state: 'stopped', reason: 'Ctrl+C' }) })).alive).toBe(false)
    expect(T.cmsQaRunLiveness(M, probes({ heartbeatText: null })).alive).toBe(false)
    expect(T.cmsQaHeadlessCloseBlock(M, aliveLP)).toMatch(/pid launcher headless 4241 CÒN SỐNG/)
    expect(T.cmsQaHeadlessCloseBlock(M, aliveLP)).toMatch(/không tự kill, không sửa manifest/)
    expect(T.cmsQaHeadlessCloseBlock(M, () => false)).toBeNull()
    expect(T.cmsQaHeadlessCloseBlock({ ...M, launcherPid: null } as unknown as CmsQaRunManifest, () => false)).toMatch(/không ghi pid launcher/)
    expect(T.cmsQaHeadlessCloseBlock({ ...M, launcherPid: 0 } as unknown as CmsQaRunManifest, () => false)).toMatch(/không ghi pid launcher/)
    expect(T.cmsQaHeadlessCloseBlock(M, () => { throw new Error('EPERM') })).toMatch(/không kiểm được pid launcher/)
    expect(T.cmsQaHeadlessCloseBlock(base('manual-localhost'), () => true)).toBeNull()
  })
  test('nguồn: close gọi kiểm pid TRƯỚC mọi đọc DB và không thay cho kiểm liveness; không có lệnh kill / ghi manifest trong nhánh này', () => {
    const src = fs.readFileSync(path.join(WEBAPP, 'scripts', 'cms-qa-run.mjs'), 'utf8')
    const iLive = src.indexOf("m.mode === 'manual-headless' && (await runLiveness(T, m)).alive")
    const iPid = src.indexOf('T.cmsQaHeadlessCloseBlock(m, pidAlive)')
    const iDb = src.indexOf('T.cmsQaRunProgramsSql(m.startedAt, uids)')
    expect(iLive).toBeGreaterThan(0)
    expect(iPid).toBeGreaterThan(iLive)
    expect(iDb).toBeGreaterThan(iPid)
    expect(src.slice(iLive, iDb)).not.toMatch(/process\.kill\(|taskkill|writeFileSync|renameSync/)
  })
})

test.describe('CMS P4-A · A3 báo cáo sau chốt QA — sổ, kết cục, reconcile, close @desktop', () => {
  const SHA = 'e'.repeat(64)
  const op = (o: Partial<P.CmsQaReportOp> = {}): P.CmsQaReportOp => ({
    ...P.newCmsQaReportOp({ operationId: 'r-0123456789ab', qaRunId: RUN, host: 'db.example.test', pid: 88, programId: PROG, payoutRunId: PAY, profile: null, idemKey: IDEM,
      reasonSha256: P.cmsQaReportSha('lý do kiểm QA báo cáo sau chốt'), actorId: SUPER, payload: { sha256: SHA, returns: 2, asOf: '2026-11-22T10:30:00.000000Z', returnsDigest: 'f'.repeat(64) },
      startedAt: '2026-11-22T10:30:00.000Z' }), ...o })
  const done = (o: Partial<P.CmsQaReportOp> = {}) => op({ status: 'done', finishedAt: '2026-11-22T10:30:05.000Z', result: { code: null, saved: 'saved', reportId: REP }, ...o })
  const file = (e: P.CmsQaReportOp) => ({ name: `${e.operationId}.json`, text: JSON.stringify(e) })
  const M = base('manual-headless')

  test('sổ: tạo / parse; đầu vào sai bị từ chối; lý do chỉ lưu sha', () => {
    const e = op()
    expect(e).toMatchObject({ status: 'intent', result: null, finishedAt: null })
    expect(JSON.stringify(e)).not.toContain('lý do kiểm QA')
    expect(P.parseCmsQaReportOp(JSON.stringify(e))).toEqual({ ok: true, value: e })
    expect(P.parseCmsQaReportOp(JSON.stringify(done())).ok).toBe(true)
    expect(P.parseCmsQaReportOp(JSON.stringify({ ...done(), result: { code: null, saved: 'saved', reportId: null } })).ok).toBe(false)
    expect(P.parseCmsQaReportOp(JSON.stringify({ ...e, status: 'unknown' })).ok).toBe(false) // unknown phải có kết quả
    expect(P.parseCmsQaReportOp(JSON.stringify({ ...e, status: 'reconciled' })).ok).toBe(false)
    expect(P.parseCmsQaReportOp('{').ok).toBe(false)
    for (const bad of [{ operationId: 'a-0123456789ab' }, { programId: 'x' }, { idemKey: 'x' }, { actorId: 'x' }, { profile: 'sales_only_v1' }, { reasonSha256: 'x' }, { pid: 0 }]) {
      expect(() => P.newCmsQaReportOp({ ...op(), ...bad } as never), JSON.stringify(bad)).toThrow()
    }
  })

  test('kết cục request: saved / already ⇒ done; DB giữ lại / từ chối xác định ⇒ rejected; mất phản hồi / sai dạng ⇒ unknown (không coi là đạt)', () => {
    expect(P.cmsQaReportOutcome({ kind: 'ok', data: { saved: true, report_id: REP } })).toEqual({ status: 'done', result: { code: null, saved: 'saved', reportId: REP } })
    expect(P.cmsQaReportOutcome({ kind: 'ok', data: { saved: true, already: true, report_id: REP } })).toMatchObject({ status: 'done', result: { saved: 'already' } })
    expect(P.cmsQaReportOutcome({ kind: 'ok', data: { saved: false, code: 'CMS_RETURN_LEDGER_CONFLICT' } })).toEqual({ status: 'rejected', result: { code: 'CMS_RETURN_LEDGER_CONFLICT', saved: null, reportId: null } })
    expect(P.cmsQaReportOutcome({ kind: 'rejected', code: 'CMS_REPORT_FORBIDDEN' })).toMatchObject({ status: 'rejected', result: { code: 'CMS_REPORT_FORBIDDEN' } })
    expect(P.cmsQaReportOutcome({ kind: 'unknown', code: 'NETWORK' })).toMatchObject({ status: 'unknown' })
    for (const weird of [null, [], 'ok', { saved: true }, { saved: true, report_id: 'x' }, { saved: 'yes' }, {}]) {
      expect(P.cmsQaReportOutcome({ kind: 'ok', data: weird }), JSON.stringify(weird)).toMatchObject({ status: 'unknown', result: { code: 'REPLY_INVALID' } })
    }
  })

  test('thao tác chưa khép chặn lệnh ghi mới của CÙNG chương trình; khoá yêu cầu không dùng lại cho nội dung khác', () => {
    const unk = op({ status: 'unknown', finishedAt: 'x', result: { code: 'NETWORK', saved: null, reportId: null } })
    expect(P.cmsQaReportPendingOps([op(), unk, done({ operationId: 'r-aaaaaaaaaaaa' })], PROG).map((e) => e.status)).toEqual(['intent', 'unknown'])
    expect(P.cmsQaReportPendingOps([op()], PROG2)).toEqual([])
    const same = { idemKey: IDEM, programId: PROG, payoutRunId: PAY, actorId: SUPER }
    expect(P.cmsQaReportIdemReuse([done()], same)).toBeNull()
    expect(P.cmsQaReportIdemReuse([done()], { ...same, idemKey: IDEM2 })).toBeNull()
    for (const diff of [{ programId: PROG2 }, { payoutRunId: uid(42) }, { actorId: OTHER }]) expect(P.cmsQaReportIdemReuse([done()], { ...same, ...diff }), JSON.stringify(diff)).toMatch(/--idem đã dùng/)
  })

  test('reconcile: chỉ kết luận khi có bằng chứng — tìm thấy đủ bộ ⇒ đã lập; không thấy + không phiên + đủ lắng ⇒ chưa lập; còn lại CHỜ / từ chối', () => {
    const unk = op({ status: 'unknown', finishedAt: '2026-11-22T10:30:05.000Z', result: { code: 'NETWORK', saved: null, reportId: null } })
    const t0 = Date.parse('2026-11-22T10:30:05.000Z')
    const probe = { can_see_all: true, hidden: 0, inflight: 0 }
    const dbRow = { id: REP, program_id: PROG, payout_run_id: PAY, created_via: 'super', created_by: SUPER }
    const o = (x: Partial<Parameters<typeof P.cmsQaReportReconcileCheck>[2]> = {}) => ({ nowMs: t0 + P.CMS_QA_REPORT_SETTLE_MS, pidAlive: false, probe, ...x })
    expect(P.cmsQaReportReconcileCheck(unk, [dbRow], o({ nowMs: t0 }))).toEqual({ ok: true, found: true, reportId: REP }) // tìm thấy ⇒ không cần chờ lắng
    expect(P.cmsQaReportReconcileCheck(unk, [], o())).toEqual({ ok: true, found: false, reportId: null })
    expect(P.cmsQaReportReconcileCheck(unk, [], o({ nowMs: t0 + 1_000 }))).toMatchObject({ ok: false, wait: true })
    expect(P.cmsQaReportReconcileCheck(unk, [], o({ probe: { ...probe, inflight: 1 } }))).toMatchObject({ ok: false, wait: true })
    expect(P.cmsQaReportReconcileCheck(unk, [], o({ probe: { ...probe, can_see_all: false } }))).toMatchObject({ ok: false })
    expect(P.cmsQaReportReconcileCheck(unk, [], o({ probe: { ...probe, hidden: 2 } }))).toMatchObject({ ok: false })
    expect(P.cmsQaReportReconcileCheck(unk, [], o({ probe: undefined }))).toMatchObject({ ok: false })
    expect(P.cmsQaReportReconcileCheck(op(), [], o({ pidAlive: true }))).toMatchObject({ ok: false, wait: true }) // intent còn chạy
    expect(P.cmsQaReportReconcileCheck(done(), [dbRow], o())).toMatchObject({ ok: false }) // đã có kết quả
    expect(P.cmsQaReportReconcileCheck(unk, [dbRow, { ...dbRow, id: REP2 }], o())).toMatchObject({ ok: false })
    // ĐỐI CHỨNG ÂM actor / session: đúng khoá nhưng người lập / đường lập / run chốt khác ⇒ KHÔNG tự nhận.
    for (const diff of [{ created_by: OTHER }, { created_via: 'cron' }, { payout_run_id: uid(42) }, { program_id: PROG2 }]) {
      expect(P.cmsQaReportReconcileCheck(unk, [{ ...dbRow, ...diff }], o()), JSON.stringify(diff)).toMatchObject({ ok: false })
    }
    expect(P.cmsQaReportReconcileSql(unk)).toMatch(/manual_request = '00000000-0000-4000-8000-000000000051'::uuid/)
    expect(() => P.cmsQaReportReconcileSql({ programId: "x'", idemKey: IDEM })).toThrow()
  })

  const closeOpts = { pidAlive: () => false, reportsTable: true, programIdsInRun: [PROG] }
  const dbRep = (o: Partial<P.CmsQaRunReportRow> = {}): P.CmsQaRunReportRow => ({ id: REP, program_id: PROG, payout_run_id: PAY, created_via: 'super', created_by: SUPER, manual_request: IDEM, is_test: true, ...o })

  test('close: sổ done khớp đủ bộ báo cáo trong DB ⇒ xanh; không sổ + không báo cáo ⇒ xanh', () => {
    expect(P.cmsQaReportsCloseCheck(M, [file(done())], [dbRep()], closeOpts).reasons).toEqual([])
    expect(P.cmsQaReportsCloseCheck(M, [], [], closeOpts)).toEqual({ reasons: [], entries: [], warningProgramIds: [] })
    // reconciled-found và reconciled-not-found đều khép được.
    const rf = op({ status: 'reconciled', finishedAt: 'x', result: { code: 'NETWORK', saved: null, reportId: null }, reconcile: { at: 'x', found: true, reportId: REP } })
    expect(P.cmsQaReportsCloseCheck(M, [file(rf)], [dbRep()], closeOpts).reasons).toEqual([])
    const rn = op({ status: 'reconciled', finishedAt: 'x', result: { code: 'NETWORK', saved: null, reportId: null }, reconcile: { at: 'x', found: false, reportId: null } })
    expect(P.cmsQaReportsCloseCheck(M, [file(rn)], [], closeOpts).reasons).toEqual([])
    // từ chối xác định: không có báo cáo ⇒ xanh.
    const rj = op({ status: 'rejected', finishedAt: 'x', result: { code: 'CMS_REPORT_FORBIDDEN', saved: null, reportId: null } })
    expect(P.cmsQaReportsCloseCheck(M, [file(rj)], [], closeOpts).reasons).toEqual([])
  })

  test('ĐỐI CHỨNG ÂM unknown bị đóng: intent (pid sống / chết) và unknown ⇒ close ĐỎ kèm lệnh reconcile', () => {
    const unk = op({ status: 'unknown', finishedAt: 'x', result: { code: 'NETWORK', saved: null, reportId: null } })
    expect(P.cmsQaReportsCloseCheck(M, [file(unk)], [], closeOpts).reasons.join('|')).toMatch(/KHÔNG RÕ .*reconcile --op=r-0123456789ab/)
    expect(P.cmsQaReportsCloseCheck(M, [file(op())], [], closeOpts).reasons.join('|')).toMatch(/không rõ kết thúc .*reconcile/)
    expect(P.cmsQaReportsCloseCheck(M, [file(op())], [], { ...closeOpts, pidAlive: () => true }).reasons.join('|')).toMatch(/CÒN CHẠY/)
    // unknown mà DB đã có báo cáo cùng khoá: vẫn ĐỎ (chưa reconcile) VÀ báo cáo bị coi là ngoài sổ.
    const r = P.cmsQaReportsCloseCheck(M, [file(unk)], [dbRep()], closeOpts).reasons.join('|')
    expect(r).toMatch(/KHÔNG RÕ/)
    expect(r).toMatch(/không có trong sổ của run/)
  })

  test('ĐỐI CHỨNG ÂM close: báo cáo ngoài sổ / lệch sổ / sai người / sai đường / chương trình ngoài run / sổ ghi đã lập mà DB không có / sổ hỏng', () => {
    const chk = (files: { name: string; text: string }[], rows: P.CmsQaRunReportRow[], o = closeOpts) => P.cmsQaReportsCloseCheck(M, files, rows, o).reasons.join('|')
    expect(chk([], [dbRep()])).toMatch(/không có trong sổ của run/) // lập ngoài CLI (vd. gọi RPC tay)
    expect(chk([file(done())], [dbRep({ manual_request: IDEM2 })])).toMatch(/lệch thao tác/)
    expect(chk([file(done())], [dbRep({ payout_run_id: uid(42) })])).toMatch(/lệch thao tác/)
    expect(chk([file(done())], [dbRep({ created_by: OTHER })])).toMatch(/không do tài khoản QA của run lập/)
    expect(chk([file(done())], [dbRep({ created_via: 'cron', created_by: null })])).toMatch(/không do tài khoản QA của run lập/)
    expect(chk([file(done())], [dbRep()], { ...closeOpts, programIdsInRun: [PROG2] })).toMatch(/ngoài run/)
    expect(chk([file(done())], [])).toMatch(/DB không có báo cáo đó/)
    expect(chk([file(done())], [], { ...closeOpts, reportsTable: false })).toMatch(/DB chưa có bảng báo cáo/)
    expect(chk([{ name: 'r-0123456789ab.json', text: '{' }], [])).toMatch(/hỏng/)
    expect(chk([{ name: 'r-ffffffffffff.json', text: JSON.stringify(done()) }], [dbRep()])).toMatch(/sai tên file/)
    expect(chk([file(done({ qaRunId: 'cms-qa-20261122T101500-ffff' }))], [])).toMatch(/thuộc run khác/)
    expect(chk([file(done({ host: 'other.example.test' }))], [])).toMatch(/host khác/)
    // `already` trỏ báo cáo lập trước mốc run (phát lại khoá cũ) ⇒ không đòi thấy trong cửa sổ.
    expect(chk([file(done({ result: { code: null, saved: 'already', reportId: REP } }))], [])).toBe('')
  })

  test('ĐỐI CHỨNG ÂM is_test: báo cáo trên chương trình THẬT do tài khoản / công cụ QA ⇒ ĐỎ; do người khác (cron / super thật) ⇒ chỉ cảnh báo', () => {
    const real = dbRep({ program_id: REALP, is_test: false })
    expect(P.cmsQaReportsCloseCheck(M, [], [real], closeOpts).reasons.join('|')).toMatch(/THẬT .* do tài khoản \/ công cụ QA lập/)
    expect(P.cmsQaReportsCloseCheck(M, [file(done({ programId: REALP }))], [dbRep({ program_id: REALP, is_test: false, created_by: OTHER })], closeOpts).reasons.join('|')).toMatch(/THẬT/)
    const cron = P.cmsQaReportsCloseCheck(M, [], [dbRep({ program_id: REALP, is_test: false, created_via: 'cron', created_by: null, manual_request: null })], closeOpts)
    expect(cron.reasons).toEqual([])
    expect(cron.warningProgramIds).toEqual([REALP])
  })

  test('SQL của CLI / close chỉ đọc, đúng bảng; mốc sai bị từ chối', () => {
    for (const s of [P.CMS_QA_HAS_REPORTS_SQL, P.CMS_QA_REPORT_INFLIGHT_SQL, P.cmsQaRunReportsSql('2026-11-22T10:15:00.000Z'), P.cmsQaReportReconcileSql(op())]) {
      expect(s).toMatch(/^SELECT/)
      expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|GRANT)\b/i)
    }
    expect(P.cmsQaRunReportsSql('2026-11-22T10:15:00.000Z')).toMatch(/cms_return_close_reports r JOIN public\.cms_programs p/)
    expect(() => P.cmsQaRunReportsSql("2026-11-22'; DROP TABLE x; --")).toThrow()
  })
})

test.describe('CMS P4-A · CLI âm trước IO (URL .invalid — mọi ca thoát 2, không request) + nguồn @desktop', () => {
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(E2E_CMS|CMS_|E2E_EXPECTED_SUPABASE_HOST)/.test(k)) clean[k] = v
    }
    const r = spawnSync(process.execPath, [path.join(WEBAPP, 'scripts', script), ...args], {
      cwd: WEBAPP, encoding: 'utf8', timeout: 60_000,
      env: { ...clean, NEXT_PUBLIC_SUPABASE_URL: 'https://p4a-negative.invalid', SUPABASE_SERVICE_ROLE_KEY: 'x', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x', ...env } as unknown as NodeJS.ProcessEnv,
    })
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }
  const hasRun = fs.existsSync(path.join(WEBAPP, '.qa-cms.json'))
  const BQ = { CMS_CALC_MODES_ENABLED: 'true', CMS_RETURNS_ENABLED: 'true', CMS_BQ_SALES_TABLE: 'p.d.s', CMS_BQ_RETURNS_TABLE: 'p.d.r' }

  test('launcher: --headless không đi cùng --no-server / --port; --headless ngoài start; --with-lock --no-server vẫn chặn', () => {
    const WS = { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: 'p4a-negative.invalid' }
    let r = run('cms-qa-run.mjs', ['status', '--headless'])
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/--headless chỉ dùng với start/)
    r = run('cms-qa-run.mjs', ['start', `--users=${SUPER}`, '--headless', '--no-server'], WS)
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/--headless không dùng cùng --no-server/)
    r = run('cms-qa-run.mjs', ['start', `--users=${SUPER}`, '--headless', '--port=3120'], WS)
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/bỏ --port/)
    r = run('cms-qa-run.mjs', ['start', `--users=${SUPER}`, '--with-lock', '--no-server'], { ...WS, CMS_EARNINGS_ENABLED: 'true', CMS_LOCK_ENABLED: 'true' })
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/--no-server/)
    r = run('cms-qa-run.mjs', ['start', `--users=${SUPER}`, '--headless', '--with-lock'], WS)
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/--with-lock cần CMS_EARNINGS_ENABLED=true/)
    r = run('cms-qa-run.mjs', ['start', `--users=${SUPER}`, '--headless'])
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/E2E_CMS_WRITE_QA=YES/)
  })

  test('writer: --source sai / thiếu --expect-* / thiếu cờ PROCESS / kèm tham số nguồn giả / --dry-run ngoài bq ⇒ 2', () => {
    const base = ['publish', `--program=${PROG}`, `--confirm-run=${RUN}`]
    const EXP = ['--expect-cv=1', '--expect-basis=cms_unit', '--expect-policy=full_line_qty_refund_v1']
    let r = run('cms-qa-results.mjs', [...base, '--source=bigquery'], BQ)
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/--source chỉ nhận/)
    r = run('cms-qa-results.mjs', [...base, '--source=bq', '--expect-cv=1'], BQ)
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/cần đủ --expect-cv/)
    r = run('cms-qa-results.mjs', [...base, '--source=bq', ...EXP], { ...BQ, CMS_RETURNS_ENABLED: 'false' })
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/CMS_RETURNS_ENABLED=true là biến PROCESS/)
    r = run('cms-qa-results.mjs', [...base, '--source=bq', ...EXP], { CMS_CALC_MODES_ENABLED: 'true', CMS_RETURNS_ENABLED: 'true', CMS_BQ_SALES_TABLE: 'p.d.s' })
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/CMS_BQ_RETURNS_TABLE/)
    r = run('cms-qa-results.mjs', [...base, '--source=bq', ...EXP, `--staff=${STAFF}`], BQ)
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/không sinh dòng giả/)
    r = run('cms-qa-results.mjs', [...base, `--staff=${STAFF}`, '--dry-run'])
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/chỉ dùng với --source=bq/)
    r = run('cms-qa-results.mjs', [...base, `--staff=${STAFF}`, '--expect-cv=1'])
    expect(r.code, r.out).toBe(2)
    r = run('cms-qa-results.mjs', ['status', '--source=bq'])
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/chỉ dùng với publish/)
  })

  test('báo cáo: lệnh sai / thiếu cờ PROCESS / không có run mở ⇒ 2 (không gửi gì)', () => {
    test.skip(hasRun, 'đang có run QA thật mở — bỏ ca "không có run"')
    let r = run('cms-qa-report.mjs', ['save'])
    expect(r.code, r.out).toBe(2)
    r = run('cms-qa-report.mjs', ['report', '--bogus=1'])
    expect(r.code, r.out).toBe(2)
    r = run('cms-qa-report.mjs', ['report', `--program=${PROG}`, `--payout-run=${PAY}`, `--confirm-run=${RUN}`, '--reason=ly do kiem thu QA'])
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/CMS_CALC_MODES_ENABLED=true là biến PROCESS/)
    r = run('cms-qa-report.mjs', ['report', `--program=${PROG}`, `--payout-run=${PAY}`, `--confirm-run=${RUN}`, '--reason=ly do kiem thu QA'], BQ)
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/không có run QA đang mở/)
    for (const cmd of ['status', 'reconcile']) {
      r = run('cms-qa-report.mjs', [cmd, `--confirm-run=${RUN}`])
      expect(r.code, r.out).toBe(2)
      expect(r.out).toMatch(/không có run QA đang mở/)
    }
  })

  test('nguồn: MỘT helper liveness — không CLI nào còn tự ghép điều kiện pid / cổng; writer bq không thay runner / table; CLI báo cáo không dùng service_role để ghi', () => {
    const src = (f: string) => fs.readFileSync(path.join(WEBAPP, f), 'utf8')
    const code = (f: string) => src(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    for (const f of ['scripts/cms-qa-results.mjs', 'scripts/cms-qa-report.mjs', 'scripts/cms-qa-run.mjs', 'scripts/cms-source-attest.mjs']) {
      expect(code(f), f).not.toMatch(/pidAlive\(m\.(launcherPid|serverPid)\)/)
      expect(code(f), f).not.toMatch(/m\.mode\s*[!=]==\s*'manual-localhost'/)
    }
    expect(code('scripts/cms-qa-results.mjs')).toMatch(/runLiveness\(T, cur\)/)
    expect(code('scripts/cms-qa-run.mjs')).toMatch(/runLiveness\(T, m\)/)
    expect(code('e2e/cmsSourceAttest.ts')).toMatch(/cmsQaRunLiveness\(cur,/)
    expect(code('e2e/cmsQaResults.ts')).toMatch(/cmsQaWatchedShapeReason\(m\)/)
    expect(code('e2e/cmsQaResults.ts')).not.toMatch(/m\.mode !== 'manual-localhost'/)
    // writer bq: thân publishBq không nhắc runner / bảng / dòng giả.
    const w = code('scripts/cms-qa-results.mjs')
    const bq = w.slice(w.indexOf('async function publishBq('), w.indexOf("const programId = a.values['--program']"))
    expect(bq.length).toBeGreaterThan(500)
    expect(bq).not.toMatch(/CMS_QA_FAKE_TABLE|createCmsFixtureRunner|cmsQaFakeSalesRows|runner:/)
    expect(bq).toMatch(/source: R\.CMS_QA_WRITER_SOURCE/)
    expect(bq).toMatch(/tag: \{ qaRunId: m\.runId, writerId \}/)
    // CLI báo cáo: bước ghi duy nhất là fetch RPC _save_super với Bearer token phiên; không gọi RPC lưu của cron, không admin.rpc ghi.
    const rp = code('scripts/cms-qa-report.mjs')
    expect(rp.match(/rpc_cms_return_close_report_save_super/g)?.length).toBe(1)
    expect(rp).not.toMatch(/rpc_cms_return_close_report_save['"`]/)
    expect(rp.match(/admin\.rpc\(/g)).toEqual(['admin.rpc('])
    expect(rp).toMatch(/admin\.rpc\('rpc_cms_capabilities'\)/)
    expect(rp).toMatch(/authorization: `Bearer \$\{token\}`/)
    expect(rp).not.toMatch(/console\.log\([^)]*token/)
    expect(rp).not.toMatch(/process\.exit\(/)
  })
})
