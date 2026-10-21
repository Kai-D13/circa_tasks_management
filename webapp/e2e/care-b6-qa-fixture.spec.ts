import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { pgliteGateway, type Filter } from './careQaPglite'

// CRM-CSKH B6-qa — scripts/care-qa-fixture.mjs (up | verify | status | down) chạy trên PGlite với migration 114 THẬT
// qua một gateway cùng giao diện với gateway Supabase của script. Không chạm DB/Supabase thật. Kiểm: vòng đời đầy đủ,
// RLS/RPC theo vai, dọn hết (gồm care_reconcile_queue + bảng không có is_test), crash giữa chừng rồi down/retry,
// cổng sai host/thiếu cờ/cờ trong .env.local/marker còn, phạm vi lẫn dòng thật ⇒ dừng, output không ID/PII.

const ROOT = path.resolve(__dirname, '..')
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')

/* eslint-disable @typescript-eslint/no-explicit-any */
const HOST = 'db.example.test'
const ENV_BASE = { NEXT_PUBLIC_SUPABASE_URL: `https://${HOST}`, E2E_CARE_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: HOST }

test.describe('care B6-qa — scripts/care-qa-fixture.mjs trên PGlite (114 thật) @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  test.setTimeout(300_000)

  async function setup(failOn?: (op: string, name: string) => boolean, closed: string[] = []) {
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const F: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'care-qa-fixture.mjs')).href)
    const db: any = await L.freshDb(PGlite)
    await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('114', 'care_crm_foundation') ON CONFLICT DO NOTHING`)
    const env = { ...ENV_BASE, E2E_STAFF_EMAIL: L.EA, E2E_SUPER_EMAIL: L.SUPER_EMAIL, E2E_QLCH_EMAIL: 'qa.qlch1@example.invalid', E2E_SM_EMAIL: 'qa.sm@example.invalid', E2E_CARE_TRANSFER_TO_EMAIL: L.EB }
    const roles = { staff: L.U.A, super: L.U.super, qlch: L.U.qlch1, sm: L.U.sm }
    const gw = pgliteGateway(db, L, roles, { failOn, closed })
    const markerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'care-qa-')), '.qa-care.json')
    const ctx = { gw, env, envFileText: 'NEXT_PUBLIC_SUPABASE_URL=x\n', markerPath, nowMs: Date.parse('2026-10-15T05:00:00Z') }
    const totalTest = async () => Number((await db.query(`SELECT
      (SELECT count(*) FROM public.care_import_batches WHERE is_test) + (SELECT count(*) FROM public.care_customers WHERE is_test)
      + (SELECT count(*) FROM public.care_tasks WHERE is_test) + (SELECT count(*) FROM public.care_interactions WHERE is_test)
      + (SELECT count(*) FROM public.care_assignment_events WHERE is_test) + (SELECT count(*) FROM public.care_task_products)
      + (SELECT count(*) FROM public.care_reconcile_queue) + (SELECT count(*) FROM public.care_import_staging) AS n`)).rows[0].n)
    return { db, L, F, gw, env, ctx, markerPath, totalTest, closed }
  }

  test('vòng đời đầy đủ: up ⇒ status ⇒ verify (RLS/RPC theo vai, proof=[]) ⇒ down ⇒ 0 dòng, marker xoá; output không ID/PII', async () => {
    const { db, F, ctx, markerPath, totalTest, closed } = await setup()
    expect(await totalTest()).toBe(0)
    const up = await F.cmdUp(ctx)
    expect(up).toMatchObject({ ok: true, customers: 3, tasks: 3 })
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    expect(marker).toMatchObject({ v: 1, phase: 'ready', host: HOST })
    expect(marker.taskIds).toHaveLength(3)
    // Fixture là is_test trọn vẹn; UI người dùng loại is_test ⇒ không lẫn vào màn thật.
    expect(Number((await db.query(`SELECT count(*) n FROM public.care_tasks WHERE is_test`)).rows[0].n)).toBe(3)

    const st = await F.cmdStatus(ctx)
    expect(st.counts).toMatchObject({ care_import_batches: 1, care_customers: 3, care_tasks: 3, care_task_products: 3, care_interactions: 0, care_orders: 0 })

    const v = await F.cmdVerify(ctx)
    expect(v.results.filter((r: any) => r.result !== 'PASS'), JSON.stringify(v.results)).toEqual([])
    expect(v).toMatchObject({ ok: true, failed: 0, notVerified: 0 })
    expect(closed.sort()).toEqual(['qlch', 'sm', 'staff', 'super']) // mọi phiên đăng nhập E2E đều signOut
    expect(v.results.map((r: any) => r.check)).toEqual(expect.arrayContaining([
      'staff: ghi lượt không kết thúc CALLBACK (proof=[])', 'staff: ghi lượt kết thúc NO_NEED (proof=[]) + hàng đợi đối soát',
      'QLCH: 0 task CRM (Q-76/77)', 'super: care_report gồm test − không test = số task fixture', 'SM: chuyển giao 1 task có ghi chú',
    ]))
    // Lượt ghi không kèm ảnh (proof rỗng ⇒ không có object GCS).
    expect(Number((await db.query(`SELECT count(*) n FROM public.care_interactions WHERE is_test AND proof <> '[]'::jsonb`)).rows[0].n)).toBe(0)
    const st2 = await F.cmdStatus(ctx)
    expect(st2.counts.care_interactions).toBe(2)
    expect(st2.counts.care_reconcile_queue).toBe(1) // lượt kết thúc sinh hàng đợi — down phải dọn
    expect(st2.counts.care_assignment_events).toBeGreaterThanOrEqual(4) // assigned ×3 + transferred
    await expect(F.cmdVerify(ctx)).rejects.toMatchObject({ code: 'PHASE' }) // không chạy verify hai lần

    const down = await F.cmdDown(ctx)
    expect(down).toMatchObject({ ok: true, remaining: 0 })
    expect(down.deleted).toMatchObject({ care_reconcile_queue: 1, care_interactions: 2, care_tasks: 3, care_customers: 3, care_import_batches: 1, care_task_products: 3 })
    expect(fs.existsSync(markerPath)).toBe(false)
    expect(await totalTest()).toBe(0)
    // Output (in ra màn hình) chỉ số đếm/mã — không UUID, không SĐT/email/ID khách.
    expect(JSON.stringify([up, st, v, st2, down])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|@example|039000|QA-B6-/)
  })

  test('crash giữa chừng: chết sau staging (trước finalize) và sau finalize (trước cập nhật marker) ⇒ status thấy đúng dòng, down dọn sạch; down chạy lại được', async () => {
    for (const point of ['rpc:care_import_finalize', 'after-finalize']) {
      let finalized = false
      const { db, F, ctx, markerPath, totalTest } = await setup((op, name) => {
        if (point === 'rpc:care_import_finalize') return op === 'rpc' && name === 'care_import_finalize'
        if (op === 'rpc' && name === 'care_import_finalize') { finalized = true; return false }
        return false
      })
      if (point === 'after-finalize') {
        // Chết ngay sau finalize: bọc select để ném khi đọc lại task (trước khi marker ghi taskIds).
        const orig = ctx.gw.svc.select
        ctx.gw.svc.select = async (t: string, c: string, f: Filter[]) => { if (finalized && t === 'care_tasks') { finalized = false; const e: any = new Error('chết'); e.code = 'SIMULATED'; throw e } return orig(t, c, f) }
      }
      await expect(F.cmdUp(ctx), point).rejects.toBeTruthy()
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
      expect(marker.phase, point).toBe('reserved') // marker ghi TRƯỚC write đầu tiên, chưa có taskIds
      expect(marker.taskIds, point).toBeUndefined()
      const st = await F.cmdStatus(ctx)
      expect(st.counts.care_import_batches, point).toBe(1)
      if (point === 'after-finalize') expect(st.counts.care_tasks, point).toBe(3) // tìm qua batch_id/external_id dù marker thiếu ID
      await expect(F.cmdUp(ctx), point).rejects.toMatchObject({ code: 'GATE' }) // marker còn ⇒ up không chạy chồng
      // down lỗi một phần ⇒ giữ marker; chạy lại ⇒ sạch. Chết ở bảng có dòng thật trong phạm vi: chưa finalize thì
      // chỉ có batch/staging (chết ở batch, sau khi staging đã xoá); đã finalize thì chết ở task (giữa chuỗi FK).
      const failTable = point === 'rpc:care_import_finalize' ? 'care_import_batches' : 'care_tasks'
      let failOnce = true
      const origDel = ctx.gw.svc.del
      ctx.gw.svc.del = async (t: string, f: Filter[]) => { if (failOnce && t === failTable) { failOnce = false; const e: any = new Error('chết'); e.code = 'SIMULATED'; throw e } return origDel(t, f) }
      // 116: task is_test xoá qua RPC care_qa_delete_test_tasks (service_role mất DELETE care_tasks) ⇒ chết ở RPC đó.
      const origRpc = ctx.gw.svc.rpc
      ctx.gw.svc.rpc = async (fn: string, a: any) => {
        if (failOnce && failTable === 'care_tasks' && fn === 'care_qa_delete_test_tasks') { failOnce = false; const e: any = new Error('chết'); e.code = 'SIMULATED'; throw e }
        return origRpc(fn, a)
      }
      await expect(F.cmdDown(ctx), point).rejects.toBeTruthy()
      expect(fs.existsSync(markerPath), point).toBe(true)
      expect(await F.cmdDown(ctx), point).toMatchObject({ ok: true, remaining: 0 })
      expect(await totalTest(), point).toBe(0)
      await db.close()
    }
  })

  test('cổng: thiếu cờ / sai host / cờ nằm trong .env.local / marker còn / không có 114 ⇒ từ chối TRƯỚC khi ghi', async () => {
    const { db, F, ctx, markerPath, totalTest } = await setup()
    const variants: [string, any][] = [
      ['thiếu E2E_CARE_WRITE_QA', { ...ctx, env: { ...ctx.env, E2E_CARE_WRITE_QA: undefined } }],
      ['sai host', { ...ctx, env: { ...ctx.env, E2E_EXPECTED_SUPABASE_HOST: 'prod.khac.vn' } }],
      ['cờ trong .env.local', { ...ctx, envFileText: 'E2E_CARE_WRITE_QA=YES\n' }],
    ]
    for (const [name, c] of variants) await expect(F.cmdUp(c), name).rejects.toMatchObject({ code: 'GATE' })
    expect(fs.existsSync(markerPath)).toBe(false)
    fs.writeFileSync(markerPath, '{}')
    await expect(F.cmdUp(ctx), 'marker còn').rejects.toMatchObject({ code: 'GATE' })
    fs.rmSync(markerPath)
    await db.query(`DELETE FROM public.app_migrations WHERE version = '114'`)
    await expect(F.cmdUp(ctx)).rejects.toMatchObject({ code: 'NO_114' })
    expect(fs.existsSync(markerPath)).toBe(false)
    await expect(F.cmdDown(ctx)).rejects.toMatchObject({ code: 'GATE' }) // không marker ⇒ không có gì để dọn
    expect(await totalTest()).toBe(0)
    await db.close()
  })

  test('phạm vi marker lẫn dòng KHÔNG is_test ⇒ down dừng (SCOPE_NOT_TEST), giữ marker, không xoá gì', async () => {
    const { db, L, F, ctx, markerPath } = await setup()
    expect((await L.finalize(db, await L.stage(db, [L.row('QA-THAT-1', 'QAOS01', L.EA, 'P1')], { period: (F.vnToday().period) }), L.U.mkt, F.vnToday().today)).status).toBe('committed')
    const real = (await db.query(`SELECT id FROM public.care_import_batches WHERE NOT is_test`)).rows[0].id
    fs.writeFileSync(markerPath, JSON.stringify({ v: 1, runId: 'deadbeef', host: HOST, phase: 'ready', period: F.vnToday().period, batchId: real, externalIds: ['QA-B6-deadbeef-1'] }))
    await expect(F.cmdDown(ctx)).rejects.toMatchObject({ code: 'SCOPE_NOT_TEST' })
    expect(fs.existsSync(markerPath)).toBe(true)
    expect(Number((await db.query(`SELECT count(*) n FROM public.care_tasks WHERE NOT is_test`)).rows[0].n)).toBe(1)
    await db.close()
  })

  test('security P1/P2: không đóng task (thật hoặc test) kỳ trước; dọn được lượt REFUSED (FK từ chối → lượt); marker độc quyền; export trong .env.local; actor phải admin; host marker', async () => {
    // P1-a: còn task THẬT mở của kỳ trước ⇒ up dừng TRƯỚC khi ghi, task thật vẫn mở.
    {
      const { db, L, F, ctx, markerPath } = await setup()
      const { period } = F.vnToday()
      const prev = new Date(Date.parse(period + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10) // ngày cuối tháng trước
      const prevPeriod = prev.slice(0, 7) + '-01'
      expect((await L.finalize(db, await L.stage(db, [L.row('QA-REAL-PREV', 'QAOS01', L.EA, 'P1')], { period: prevPeriod }), L.U.mkt, prev)).status).toBe('committed')
      await expect(F.cmdUp(ctx)).rejects.toMatchObject({ code: 'OPEN_PREVIOUS' })
      expect(fs.existsSync(markerPath)).toBe(false)
      expect((await db.query('SELECT status FROM public.care_tasks WHERE NOT is_test')).rows[0].status).toBe('open')
      expect(Number((await db.query('SELECT count(*) n FROM public.care_import_batches WHERE is_test')).rows[0].n)).toBe(0)
      await db.close()
    }
    // PM r1 P1-2: task is_test (fixture lượt QA khác) đang mở kỳ trước cũng bị finalize đóng ⇒ up phải dừng.
    {
      const { db, L, F, ctx, markerPath } = await setup()
      const { period } = F.vnToday()
      const prev = new Date(Date.parse(period + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10)
      expect((await L.finalize(db, await L.stage(db, [L.row('QA-B6-old-1', 'QAOS01', L.EA, 'P1')], { period: prev.slice(0, 7) + '-01', isTest: true }), L.U.mkt, prev)).status).toBe('committed')
      await expect(F.cmdUp(ctx)).rejects.toMatchObject({ code: 'OPEN_PREVIOUS' })
      expect(fs.existsSync(markerPath)).toBe(false)
      expect((await db.query('SELECT status FROM public.care_tasks WHERE is_test')).rows[0].status).toBe('open') // không bị đóng ngoài phạm vi
      await db.close()
    }
    // P1-b: lượt REFUSED tạo dòng từ chối (interaction_id → lượt) ⇒ down vẫn dọn sạch, không lỗi FK.
    {
      const { db, L, F, ctx, markerPath, totalTest } = await setup()
      await F.cmdUp(ctx)
      const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
      await L.record(db, F.vnToday().today, L.U.A, m.taskIds[2], 'REFUSED', 'QA từ chối')
      expect((await F.cmdStatus(ctx)).counts.care_store_refusals).toBe(1)
      expect(await F.cmdDown(ctx)).toMatchObject({ ok: true, remaining: 0, deleted: { care_store_refusals: 1, care_interactions: 1 } })
      expect(await totalTest()).toBe(0)
      await db.close()
    }
    // P2: up song song — marker do lần khác tạo giữa lúc kiểm và lúc ghi ⇒ MARKER_EXISTS, không ghi DB.
    {
      const { db, F, ctx, markerPath, gw, totalTest } = await setup()
      const orig = gw.userByEmail
      gw.userByEmail = async (e: string) => { if (!fs.existsSync(markerPath)) fs.writeFileSync(markerPath, '{"v":1}'); return orig(e) }
      await expect(F.cmdUp(ctx)).rejects.toMatchObject({ code: 'MARKER_EXISTS' })
      expect(fs.readFileSync(markerPath, 'utf8')).toBe('{"v":1}') // không đè marker của lần kia
      expect(await totalTest()).toBe(0)
      fs.rmSync(markerPath)
      gw.userByEmail = orig
      // export trong .env.local; actor không phải admin
      await expect(F.cmdUp({ ...ctx, envFileText: 'export E2E_CARE_WRITE_QA=YES\n' })).rejects.toMatchObject({ code: 'GATE' })
      await expect(F.cmdUp({ ...ctx, env: { ...ctx.env, E2E_SUPER_EMAIL: ctx.env.E2E_STAFF_EMAIL } })).rejects.toMatchObject({ code: 'ACTOR_INVALID' })
      expect(fs.existsSync(markerPath)).toBe(false)
      // host marker khác host hiện tại ⇒ status/verify/down đều dừng
      await F.cmdUp(ctx)
      const other = { ...ctx, env: { ...ctx.env, NEXT_PUBLIC_SUPABASE_URL: 'https://prod.khac.vn', E2E_EXPECTED_SUPABASE_HOST: 'prod.khac.vn' } }
      await expect(F.cmdStatus(other)).rejects.toMatchObject({ code: 'HOST_MISMATCH' })
      await expect(F.cmdVerify(other)).rejects.toMatchObject({ code: 'HOST_MISMATCH' })
      await expect(F.cmdDown(other)).rejects.toMatchObject({ code: 'HOST_MISMATCH' })
      expect(await F.cmdDown(ctx)).toMatchObject({ ok: true, remaining: 0 })
      await db.close()
    }
  })

  test('PM r1 P1-1: hai fixture A/B — marker A trỏ task/khách/batch của B ⇒ SCOPE_MISMATCH TRƯỚC mọi DELETE, cả hai còn nguyên; care_orders theo ID giả ⇒ OUT_OF_SCOPE trước khi xoá', async () => {
    const { db, F, ctx, markerPath, totalTest } = await setup()
    const ctxB = { ...ctx, markerPath: markerPath + '.B' }
    await F.cmdUp(ctx)
    await F.cmdUp(ctxB)
    const A = JSON.parse(fs.readFileSync(markerPath, 'utf8')), B = JSON.parse(fs.readFileSync(ctxB.markerPath, 'utf8'))
    const before = await totalTest()
    const tamper = async (why: string, patch: any) => {
      fs.writeFileSync(markerPath, JSON.stringify({ ...A, ...patch }))
      await expect(F.cmdDown(ctx), why).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
      expect(await totalTest(), why).toBe(before) // không xoá gì của A lẫn B
      expect(fs.existsSync(markerPath), why).toBe(true)
    }
    await tamper('taskIds lẫn task B', { taskIds: [...A.taskIds.slice(0, 2), B.taskIds[0]] })
    await tamper('customerIds lẫn khách B', { customerIds: [...A.customerIds.slice(0, 2), B.customerIds[0]] })
    await tamper('batchId của B (hash run khác)', { batchId: B.batchId })
    await tamper('externalIds không suy ra từ runId', { externalIds: B.externalIds })
    // care_orders gắn ID giả của A (ngoài phạm vi xoá của script) ⇒ dừng TRƯỚC khi xoá.
    fs.writeFileSync(markerPath, JSON.stringify(A))
    await db.query(`INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES ('QA-ORD-1', $1, now() - interval '1 hour')`, [A.externalIds[0]])
    await expect(F.cmdDown(ctx)).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    expect(await totalTest()).toBe(before)
    await db.query(`DELETE FROM public.care_orders WHERE order_key = 'QA-ORD-1'`)
    // marker đúng ⇒ chỉ A bị dọn, B nguyên vẹn; rồi dọn B.
    expect(await F.cmdDown(ctx)).toMatchObject({ ok: true, remaining: 0 })
    expect((await F.cmdStatus(ctxB)).counts).toMatchObject({ care_tasks: 3, care_customers: 3, care_import_batches: 1 })
    expect(await F.cmdDown(ctxB)).toMatchObject({ ok: true, remaining: 0 })
    expect(await totalTest()).toBe(0)
    await db.close()
  })

  test('r2 security: down lỗi giữa chừng SAU khi đã xoá task ⇒ marker tearing_down, chạy lại xong; runId sai định dạng ⇒ MARKER_INVALID; 15 phút quanh giao tháng ⇒ MONTH_BOUNDARY', async () => {
    const { db, F, ctx, markerPath, totalTest } = await setup()
    await F.cmdUp(ctx)
    await F.cmdVerify(ctx)
    let failOnce = true
    const origDel = ctx.gw.svc.del
    ctx.gw.svc.del = async (t: string, f: Filter[]) => { if (failOnce && t === 'care_customers') { failOnce = false; const e: any = new Error('chết'); e.code = 'SIMULATED'; throw e } return origDel(t, f) }
    await expect(F.cmdDown(ctx)).rejects.toBeTruthy() // task đã xoá, khách còn
    const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    expect(m.phase).toBe('tearing_down')
    expect((await F.cmdStatus(ctx)).counts).toMatchObject({ care_tasks: 0, care_customers: 3 })
    expect(await F.cmdDown(ctx)).toMatchObject({ ok: true, remaining: 0 }) // DB ⊆ marker ⇒ chạy lại được
    expect(await totalTest()).toBe(0)
    // runId sai định dạng
    fs.writeFileSync(markerPath, JSON.stringify({ ...m, runId: 'x' }))
    await expect(F.cmdStatus(ctx)).rejects.toMatchObject({ code: 'MARKER_INVALID' })
    fs.rmSync(markerPath)
    // cổng giao tháng (giờ VN): 00:05 ngày 01 và 23:55 ngày cuối tháng ⇒ dừng TRƯỚC khi ghi
    expect(F.nearMonthBoundary(Date.parse('2026-10-31T17:05:00Z'))).toBe(true) // 00:05 VN 01/11
    expect(F.nearMonthBoundary(Date.parse('2026-10-31T16:55:00Z'))).toBe(true) // 23:55 VN 31/10
    expect(F.nearMonthBoundary(Date.parse('2026-10-15T05:00:00Z'))).toBe(false)
    await expect(F.cmdUp({ ...ctx, nowMs: Date.parse('2026-10-31T17:05:00Z') })).rejects.toMatchObject({ code: 'MONTH_BOUNDARY' })
    expect(fs.existsSync(markerPath)).toBe(false)
    expect(await totalTest()).toBe(0)
    await db.close()
  })

  test('gateway Supabase (đường prod) với client giả: filter in/eq, xoá đếm exact, ilike escape, giữ mã lỗi, login lỗi ⇒ mã an toàn', async () => {
    const F: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'care-qa-fixture.mjs')).href)
    const calls: string[] = []
    const builder = (table: string, result: any) => {
      const b: any = {}
      for (const m of ['select', 'in', 'eq', 'lt', 'ilike', 'delete', 'insert', 'maybeSingle', 'order', 'range']) {
        b[m] = (...a: any[]) => { calls.push(`${table}.${m}(${JSON.stringify(a)})`); return m === 'maybeSingle' ? Promise.resolve(result) : b }
      }
      b.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej)
      return b
    }
    const results: Record<string, any> = {
      care_tasks: { data: [{ id: 't' }], count: 3, error: null }, users: { data: { id: 'u', role: 'staff', store_id: 's' }, error: null },
      care_interactions: { data: null, count: 2, error: null }, care_customers: { data: null, error: { code: '42501', message: 'permission denied for table care_customers' } },
    }
    const fakeCreate = (_url: string, key: string) => ({
      from: (t: string) => builder(t, results[t] ?? { data: [], count: 0, error: null }),
      rpc: async (fn: string, args: any) => { calls.push(`rpc.${fn}(${JSON.stringify(args)})`); return { data: { status: 'open' }, error: null } },
      auth: { signInWithPassword: async ({ email }: any) => (key === 'anon' && email === 'ok@x' ? { data: { user: { id: 'uid-ok' } }, error: null } : { data: null, error: { message: 'Invalid login' } }) },
    })
    const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      E2E_STAFF_EMAIL: 'ok@x', E2E_STAFF_PASSWORD: 'p', E2E_QLCH_EMAIL: 'bad@x', E2E_QLCH_PASSWORD: 'p' }
    const gw = await F.makeSupabaseGateway(env, fakeCreate)
    expect(await gw.svc.count('care_tasks', [['id', 'in', ['a', 'b']], ['is_test', 'eq', true]])).toBe(3)
    expect(calls).toContain('care_tasks.in(["id",["a","b"]])')
    expect(calls).toContain('care_tasks.eq(["is_test",true])')
    expect(await gw.svc.del('care_interactions', [['task_id', 'in', ['a']], ['is_test', 'eq', true]])).toBe(2)
    expect(calls).toContain('care_interactions.delete([{"count":"exact"}])')
    await gw.userByEmail('A_b%c@x')
    expect(calls).toContain('users.ilike(["email","A\\\\_b\\\\%c@x"])') // _ và % được escape ⇒ không khớp rộng
    await expect(gw.svc.select('care_customers', 'external_id', [])).rejects.toMatchObject({ code: '42501' })
    const staff = await gw.as('staff')
    expect(staff.userId).toBe('uid-ok')
    await staff.rpc('care_record_interaction', { p_task_id: 't', p_proof: [] })
    expect(calls).toContain('rpc.care_record_interaction({"p_task_id":"t","p_proof":[]})')
    await expect(gw.as('qlch')).rejects.toMatchObject({ code: 'LOGIN' })
    expect(await gw.as('sm')).toBeNull() // thiếu tài khoản SM ⇒ NOT_VERIFIED ở verify, không lỗi
    await expect(gw.userByEmail('a*b@x')).rejects.toMatchObject({ code: 'ENV' }) // PostgREST đổi * thành % ⇒ từ chối
  })

  test('Q-121 gateway: `in` dài chia khối ≤ 100 (bỏ trùng); đọc theo trang tới đủ tổng exact dù max-rows nhỏ; tổng đổi giữa trang / thiếu id ⇒ PAGE; count/del cộng các khối', async () => {
    const F: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'care-qa-fixture.mjs')).href)
    const ids = Array.from({ length: 8000 }, (_, i) => `id-${String(i).padStart(5, '0')}`)
    const MAX_ROWS = 300 // PostgREST db-max-rows nhỏ hơn trang yêu cầu (1.000) — cắt im lặng
    const inSizes: number[] = []
    let drift = false
    const fakeCreate = () => ({
      from: () => {
        const st: any = {}
        const b: any = {
          select: (_c: string, o: any = {}) => { st.head = !!o.head; return b },
          delete: () => { st.del = true; return b },
          in: (col: string, v: string[]) => { if (v.length > 100) throw new Error('URL quá dài'); inSizes.push(v.length); if (col === 'id') st.vals = v; return b },
          eq: () => b, lt: () => b, order: () => b,
          range: (a: number, z: number) => { st.range = [a, z]; return b },
          then: (res: any, rej: any) => {
            const matched: string[] = st.vals ?? ids // lọc theo id ⇒ đúng các id; lọc khác (batch) ⇒ 8.000 dòng
            const count = drift && st.range?.[0] > 0 ? matched.length + 1 : matched.length
            const [a, z] = st.range ?? [0, matched.length - 1]
            const data = st.head || st.del ? null : matched.slice(a, Math.min(z + 1, a + MAX_ROWS)).map((id) => ({ id }))
            return Promise.resolve({ data, count, error: null }).then(res, rej)
          },
        }
        return b
      },
      rpc: async () => ({ data: null, error: null }), auth: {},
    })
    const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' }
    const gw = await F.makeSupabaseGateway(env, fakeCreate)
    expect((await gw.svc.select('care_tasks', 'id, customer_id', [['id', 'in', [...ids, ids[0]]], ['is_test', 'eq', true]])).map((r: any) => r.id)).toEqual(ids)
    expect(Math.max(...inSizes)).toBe(100)
    expect(await gw.svc.count('care_tasks', [['id', 'in', ids]])).toBe(8000)
    expect(await gw.svc.del('care_tasks', [['id', 'in', ids], ['is_test', 'eq', true]])).toBe(8000)
    expect((await gw.svc.select('care_tasks', 'id', [['batch_id', 'in', ['b1']]])).length).toBe(8000) // 27 trang × ≤ 300
    await expect(gw.svc.select('care_task_products', 'task_id', [['batch_id', 'in', ['b1']]])).rejects.toMatchObject({ code: 'PAGE' })
    drift = true
    await expect(gw.svc.select('care_tasks', 'id', [['batch_id', 'in', ['b1']]])).rejects.toMatchObject({ code: 'PAGE' })
    expect(F.splitInFilters([['id', 'in', ['a', 'a', 'b']], ['is_test', 'eq', true]], 1))
      .toEqual([[['id', 'in', ['a']], ['is_test', 'eq', true]], [['id', 'in', ['b']], ['is_test', 'eq', true]]])
    expect(F.splitInFilters([['id', 'in', ['a', 'b']]], 2)).toEqual([[['id', 'in', ['a', 'b']]]])
  })

  test('nguồn script: không tự chạy khi import; không DELETE toàn bảng; mọi xoá bảng có is_test kèm is_test; proof=[]; không GCS/care_orders/sync', () => {
    const src = read('scripts/care-qa-fixture.mjs')
    expect(src).toMatch(/if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(path\.resolve\(process\.argv\[1\]\)\)\.href\) await main\(\)/)
    expect(src).not.toMatch(/DELETE FROM|TRUNCATE|\.delete\(\)\s*$/m)
    for (const t of ['care_order_attributions', 'care_interactions', 'care_assignment_events', 'care_store_refusals', 'care_customers', 'care_import_batches']) {
      expect(src, t).toMatch(new RegExp(`del\\('${t}', \\[[^\\n]*\\.\\.\\.T\\]\\)`))
    }
    // 116: task is_test xoá qua RPC (X → L, chỉ is_test trong DB); trước 116 xoá thẳng — vẫn kèm is_test.
    expect(src.match(/care_tasks: await delTestTasks\(gw, s\.taskIds\)/g)?.length).toBe(2)
    expect(src).toContain("return gw.svc.del('care_tasks', [['id', 'in', taskIds], ['is_test', 'eq', true]])")
    expect(src).toContain("gw.svc.rpc('care_qa_delete_test_tasks', { p_task_ids: taskIds.slice(i, i + QA_DELETE_PART) })")
    expect(src).not.toMatch(/del\('care_tasks', \[\['id', 'in', s\.taskIds\]/)
    expect(src).toContain('p_proof: []')
    expect(src.indexOf("del('care_store_refusals'")).toBeLessThan(src.indexOf("del('care_interactions'")) // FK interaction_id
    expect(src.indexOf("del('care_order_attributions'")).toBeLessThan(src.indexOf("del('care_interactions'"))
    expect(src).toContain("{ flag: 'wx' }")
    expect(src).not.toMatch(/(insert|del)\('care_orders'|care_order_sync|createUploadUrl|storage\./) // care_orders chỉ ĐẾM, không ghi/xoá
    expect(src).toContain("import { CARE_QA_MARKER, careWriteGate, urlHost } from '../e2e/writeQaGates.ts'")
  })
})

test.describe('care B6-qa — đăng nhập fixture theo màn /login UI v2 @desktop', () => {
  test('loginCookie bấm đúng nút "Đăng nhập" như auth.setup; không còn selector "Sign in"; lỗi đăng nhập ⇒ FixtureError LOGIN (fail-closed)', () => {
    const src = read('scripts/care-qa-fixture.mjs')
    const body = src.slice(src.indexOf('export async function loginCookie'), src.indexOf('\n}\n', src.indexOf('export async function loginCookie')))
    expect(body).toContain("page.getByRole('button', { name: /^đăng nhập$/i }).click()")
    expect(src).not.toMatch(/sign in/i)
    expect(read('e2e/auth.setup.ts')).toContain("page.getByRole('button', { name: /^đăng nhập$/i }).click()")
    expect(read('app/(auth)/login/LoginScreen.tsx')).toMatch(/busy \? 'Đang đăng nhập…' : 'Đăng nhập'/)
    expect(body).toMatch(/waitForURL\(\(u\) => !u\.pathname\.startsWith\('\/login'\)/)
    expect(body).toContain("throw new FixtureError('LOGIN', 'không có cookie phiên sau đăng nhập')")
    expect(body).toMatch(/catch \(e\) \{\s*throw e instanceof FixtureError \? e : new FixtureError\('LOGIN'/)
  })
})
