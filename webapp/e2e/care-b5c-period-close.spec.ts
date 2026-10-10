import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect, request as pwRequest } from '@playwright/test'
import {
  CARE_PERIOD_CLOSE_RPC_TIMEOUT_MS, parseCarePeriodCloseCount, runCarePeriodClose, type CarePeriodCloseDeps,
} from '../lib/care/periodClose'

// CRM-CSKH B5c — cron care-period-close (SPEC §B5c, plan §2.8): (1) điều phối thuần với deps giả; (2) end-to-end
// trên PGlite với RPC THẬT của migration 114 theo từng "ngày" cron (biên hẹn 30/10, 31/10, đóng kỳ 01/11, import
// kỳ mới chạy trước cron); (3) nguồn route; (4) HTTP thật trên server QA: 401/503 trước mọi DB I/O.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))

function fakeDeps(over: Partial<CarePeriodCloseDeps> = {}) {
  const log: string[] = []
  const deps: CarePeriodCloseDeps = {
    stampOverdue: async () => { log.push('stamp'); return 3 },
    closePeriod: async () => { log.push('close'); return 7 },
    now: () => 1_000,
    ...over,
  }
  return { deps, log }
}

test.describe('care B5c — điều phối một lượt đóng kỳ (deps giả) @desktop', () => {
  test('thành công: stamp_overdue TRƯỚC close_period; trả số từng bước', async () => {
    const { deps, log } = fakeDeps()
    const r = await runCarePeriodClose(deps)
    expect(log).toEqual(['stamp', 'close'])
    expect(r).toEqual({ ok: true, stampOverdue: { status: 'ok', rows: 3 }, closePeriod: { status: 'ok', rows: 7 }, elapsedMs: 0 })
  })

  test('lỗi RPC thứ nhất ⇒ VẪN đóng kỳ (độc lập) rồi báo lỗi; lỗi RPC thứ hai ⇒ giữ số bước 1; cả hai lỗi ⇒ mã lỗi đầu; không lộ lỗi thô', async () => {
    const raw = new Error('permission denied for function care_stamp_overdue — task 7b1c… QA-K1')
    const a = fakeDeps({ stampOverdue: async () => { throw raw } })
    const r1 = await runCarePeriodClose(a.deps)
    expect(a.log).toEqual(['close']) // stamp lỗi kéo dài không chặn đóng kỳ (security-reviewer P2)
    expect(r1).toMatchObject({ ok: false, code: 'DB_STAMP_OVERDUE_FAILED', stampOverdue: { status: 'failed', rows: null }, closePeriod: { status: 'ok', rows: 7 } })
    const b = fakeDeps({ closePeriod: async () => { throw raw } })
    const r2 = await runCarePeriodClose(b.deps)
    expect(b.log).toEqual(['stamp'])
    expect(r2).toMatchObject({ ok: false, code: 'DB_CLOSE_PERIOD_FAILED', stampOverdue: { status: 'ok', rows: 3 }, closePeriod: { status: 'failed', rows: null } })
    const c = fakeDeps({ stampOverdue: async () => { throw raw }, closePeriod: async () => { throw raw } })
    const r3 = await runCarePeriodClose(c.deps)
    expect(r3).toMatchObject({ ok: false, code: 'DB_STAMP_OVERDUE_FAILED', stampOverdue: { status: 'failed' }, closePeriod: { status: 'failed' } })
    expect(JSON.stringify([r1, r2, r3])).not.toMatch(/permission|care_stamp|QA-K1|7b1c/)
  })

  test('đếm từ RPC: chỉ số nguyên ≥ 0 — sai dạng ⇒ throw (không báo 0 giả); trần app > timeout DB 8 s', () => {
    expect(parseCarePeriodCloseCount(0)).toBe(0)
    expect(parseCarePeriodCloseCount(25)).toBe(25)
    for (const bad of [null, undefined, '3', -1, 1.5, Number.NaN, {}, [1]]) expect(() => parseCarePeriodCloseCount(bad), String(bad)).toThrow()
    expect(CARE_PERIOD_CLOSE_RPC_TIMEOUT_MS).toBeGreaterThan(8_000)
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
test.describe('care B5c — end-to-end PGlite (RPC 114 thật theo ngày cron) @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')

  test('biên hẹn 30/10 · 31/10 · đóng kỳ 01/11 · chạy lặp không cộng trùng · import T11 trước cron cùng kết quả', async () => {
    test.setTimeout(300_000)
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const P10 = '2026-10-01', P11 = '2026-11-01'
    const K = { k30: 'QA-PC30', k31: 'QA-PC31', kNone: 'QA-PCNONE' }

    // Kỳ T10: 3 khách; hẹn 30/10, hẹn 31/10, không hẹn — không ai gọi lại.
    const seed = async () => {
      const db: any = await L.freshDb(PGlite)
      const b = await L.stage(db, [L.row(K.k30, 'QAOS01', L.EA, 'P1'), L.row(K.k31, 'QAOS01', L.EA, 'P1'), L.row(K.kNone, 'QAOS01', L.EA, 'P1')], { period: P10 })
      expect((await L.finalize(db, b, L.U.mkt, P10)).status).toBe('committed')
      await L.record(db, '2026-10-05', L.U.A, (await L.taskOf(db, K.k30, P10)).id, 'CALLBACK', 'QA hẹn', '2026-10-30')
      await L.record(db, '2026-10-05', L.U.A, (await L.taskOf(db, K.k31, P10)).id, 'CALLBACK', 'QA hẹn', '2026-10-31')
      return db
    }
    // Deps của route nhưng "hôm nay" cố định: hàm nội bộ *_at(date) mà care_stamp_overdue()/care_close_period() bọc.
    const depsAt = (db: any, day: string): CarePeriodCloseDeps => ({
      stampOverdue: async () => parseCarePeriodCloseCount(await L.count(db, `SELECT public.care__stamp_overdue_at($1::date)`, [day])),
      closePeriod: async () => parseCarePeriodCloseCount(await L.count(db, `SELECT public.care__close_period_at($1::date)`, [day])),
      now: () => Date.now(),
    })
    const snap = async (db: any) => {
      const t = async (k: string) => { const x = await L.taskOf(db, k, P10); return `${x.status}:${x.first_overdue_on ? x.first_overdue_on.toISOString().slice(0, 10) : '-'}` }
      return { k30: await t(K.k30), k31: await t(K.k31), kNone: await t(K.kNone) }
    }
    const report = async (db: any) => L.as(db, L.U.super, async () => (await db.query(`SELECT sum(tasks_total)::int total,
      sum(overdue_in_period)::int overdue, sum(closed_unfinished)::int unfinished FROM public.care_report($1::date)`, [P10])).rows[0])

    const db = await seed()
    let r = await runCarePeriodClose(depsAt(db, '2026-10-30'))
    expect(r).toMatchObject({ ok: true, stampOverdue: { rows: 0 }, closePeriod: { rows: 0 } }) // hẹn 30/10, ngày 30/10 ⇒ chưa trễ
    r = await runCarePeriodClose(depsAt(db, '2026-10-31'))
    expect(r).toMatchObject({ ok: true, stampOverdue: { rows: 1 }, closePeriod: { rows: 0 } })
    expect(await snap(db)).toEqual({ k30: 'open:2026-10-31', k31: 'open:-', kNone: 'open:-' }) // hẹn 31/10 không trễ trong T10
    r = await runCarePeriodClose(depsAt(db, '2026-10-31'))
    expect(r).toMatchObject({ ok: true, stampOverdue: { rows: 0 }, closePeriod: { rows: 0 } }) // chạy lặp ⇒ 0
    r = await runCarePeriodClose(depsAt(db, '2026-11-01'))
    expect(r).toMatchObject({ ok: true, stampOverdue: { rows: 0 }, closePeriod: { rows: 3 } })
    const afterCron = await snap(db)
    expect(afterCron).toEqual({ k30: 'closed_unfinished:2026-10-31', k31: 'closed_unfinished:-', kNone: 'closed_unfinished:-' })
    expect(await report(db)).toEqual({ total: 3, overdue: 1, unfinished: 3 }) // Quá hạn T10 = 1 (chỉ hẹn 30/10)
    r = await runCarePeriodClose(depsAt(db, '2026-11-01'))
    expect(r).toMatchObject({ ok: true, stampOverdue: { rows: 0 }, closePeriod: { rows: 0 } }) // lặp ⇒ không đóng/cộng trùng
    expect(await report(db)).toEqual({ total: 3, overdue: 1, unfinished: 3 })
    await db.close()

    // Import T11 lúc 00:01 ngày 01/11 (TRƯỚC cron 00:05): finalize đóng T10 trong cùng transaction; cron sau đó 0 dòng.
    const db2 = await seed()
    const b11 = await L.stage(db2, [L.row('QA-PCNEW', 'QAOS01', L.EA, 'P1')], { period: P11 })
    expect(await L.finalize(db2, b11, L.U.mkt, P11)).toMatchObject({ status: 'committed', closed_previous_period: 3 })
    r = await runCarePeriodClose(depsAt(db2, '2026-11-01'))
    expect(r).toMatchObject({ ok: true, stampOverdue: { rows: 0 }, closePeriod: { rows: 0 } })
    expect(await snap(db2)).toEqual(afterCron)
    expect(await report(db2)).toEqual({ total: 3, overdue: 1, unfinished: 3 })

    // Hai RPC không tham số (route gọi) chỉ service_role; trả số nguyên.
    const svc = await L.as(db2, null, async () => (await db2.query(`SELECT public.care_stamp_overdue() s, public.care_close_period() c`)).rows[0], 'service_role')
    expect(Number.isSafeInteger(svc.s) && Number.isSafeInteger(svc.c)).toBe(true)
    for (const who of [L.U.super, L.U.mkt, L.U.A]) {
      expect(await L.raises(L.as(db2, who, () => db2.query(`SELECT public.care_stamp_overdue()`)), 'permission denied'), String(who)).toBe(true)
      expect(await L.raises(L.as(db2, who, () => db2.query(`SELECT public.care_close_period()`)), 'permission denied'), String(who)).toBe(true)
    }
    await db2.close()
  })
})

test.describe('care B5c — nguồn cron care-period-close @desktop', () => {
  test('route: Bearer CRON_SECRET → CARE_ENABLED + CARE_SYNC_ENABLED (503) trước mọi IO; stamp rồi close; log chỉ số/mã', () => {
    const route = read('app/api/cron/care-period-close/route.ts')
    const body = /export async function GET\(request: NextRequest\) \{\n([\s\S]*?)\n\}/.exec(route)![1]
    expect(body.trimStart()).toMatch(/^const secret = request\.headers\.get\('authorization'\)/)
    expect(body.indexOf('{ status: 401 }')).toBeLessThan(body.indexOf('isCareEnabled()'))
    expect(body).toMatch(/if \(!isCareEnabled\(\) \|\| !isCareSyncEnabled\(\)\) \{\s*return NextResponse\.json\([\s\S]*?\{ status: 503 \}\)\s*\}/)
    expect(body.indexOf('isCareSyncEnabled()')).toBeLessThan(body.indexOf('closeCarePeriod()'))
    expect(body).toContain('status: r.ok ? 200 : 500')
    expect(route).not.toMatch(/console\.(log|warn|error)\([^)]*\b(err|error|e\.message|message)\b/)
    const server = read('lib/care/server/periodClose.ts')
    expect(server).toMatch(/^import 'server-only'/)
    const iStamp = server.indexOf("supabaseAdmin.rpc('care_stamp_overdue')"), iClose = server.indexOf("supabaseAdmin.rpc('care_close_period')")
    expect(iStamp).toBeGreaterThan(-1)
    expect(iClose).toBeGreaterThan(iStamp)
    for (const fn of ['care_stamp_overdue', 'care_close_period']) {
      expect(server.slice(server.indexOf(`supabaseAdmin.rpc('${fn}')`)).split('\n')[0]).toMatch(/\.abortSignal\(rpcSignal\(\)\)$/)
    }
    expect(server).not.toMatch(/console\./)
    expect(read('lib/care/periodClose.ts')).not.toMatch(/from ['"](next|@supabase|@\/lib\/supabase|server-only)/)
    // Không sửa 114 cho route này: hai RPC không tham số đã có, chỉ service_role.
    const sql = read('../supabase/migrations/114_care_crm_foundation.sql')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.care_close_period()\nRETURNS integer')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.care_stamp_overdue()\nRETURNS integer')
  })
})

test.describe('care B5c — HTTP thật trên server QA (cờ OFF) @desktop', () => {
  test.skip(!process.env.CRON_SECRET, 'cần CRON_SECRET (source .env.local) giống server QA')
  const auth = (s: string) => ({ Authorization: `Bearer ${s}` })

  test('thiếu/sai secret ⇒ 401; đúng secret mà cờ OFF ⇒ 503 (không chạm DB — prod chưa có 114 nên nếu gọi RPC sẽ 500)', async ({ baseURL }) => {
    const api = await pwRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
    for (const route of ['/api/cron/care-period-close', '/api/cron/care-orders-sync']) {
      expect((await api.get(route, { maxRedirects: 0 })).status(), route).toBe(401)
      expect((await api.get(route, { headers: auth('sai-secret'), maxRedirects: 0 })).status(), route).toBe(401)
      const ok = await api.get(route, { headers: auth(process.env.CRON_SECRET!), maxRedirects: 0 })
      expect(ok.status(), route).toBe(503)
      expect(await ok.text()).toMatch(/CARE_ENABLED \+ CARE_SYNC_ENABLED/)
    }
    await api.dispose()
  })

  test('CARE_ENABLED bật nhưng CARE_SYNC_ENABLED tắt (server E2E_CARE_ON_URL) ⇒ vẫn 503', async () => {
    test.skip(!process.env.E2E_CARE_ON_URL, 'cần E2E_CARE_ON_URL (server QA bật CARE_ENABLED)')
    const api = await pwRequest.newContext({ baseURL: process.env.E2E_CARE_ON_URL, storageState: { cookies: [], origins: [] } })
    for (const route of ['/api/cron/care-period-close', '/api/cron/care-orders-sync']) {
      const r = await api.get(route, { headers: auth(process.env.CRON_SECRET!), maxRedirects: 0 })
      expect(r.status(), route).toBe(503)
    }
    await api.dispose()
  })
})
