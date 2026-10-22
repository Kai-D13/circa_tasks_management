import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { pgliteGateway, type Filter } from './careQaPglite'

// CRM-CSKH D1 — `scripts/care-qa-fixture.mjs cancel-qa` (marker v3) trên PGlite với migration 114 + 115 THẬT. Mọi lệnh
// `svc` chạy dưới SET ROLE service_role (đúng ma trận quyền 115: không UPDATE batch, không đọc journal) như đường prod.
// Kiểm: vòng đời initial + revision → huỷ revision (khôi phục chính xác) → huỷ initial → status → down sạch (journal
// CASCADE); crash ở từng bước ⇒ marker giữ đúng pha, down dọn sạch; cổng chặn TRƯỚC khi ghi; marker sai ⇒ dừng;
// dữ liệu thật cùng kỳ không đổi; staging chia khối 2.000; output không ID/PII.

const ROOT = path.resolve(__dirname, '..')
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))

/* eslint-disable @typescript-eslint/no-explicit-any */
const HOST = 'db.example.test'
const ENV_BASE = { NEXT_PUBLIC_SUPABASE_URL: `https://${HOST}`, E2E_CARE_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: HOST }
const SIMULATED = () => { const e: any = new Error('giả lập process chết'); e.code = 'SIMULATED'; return e }

test.describe('care D1 — cancel-qa (marker v3) trên PGlite 114 + 115 @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  test.setTimeout(300_000)

  async function setup(opts: { failOn?: (op: string, name: string) => boolean } = {}) {
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const F: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'care-qa-fixture.mjs')).href)
    const db: any = await L.freshDb(PGlite, { through: '115' })
    await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('114', 'care_crm_foundation') ON CONFLICT DO NOTHING`)
    const env = { ...ENV_BASE, E2E_STAFF_EMAIL: L.EA, E2E_SUPER_EMAIL: L.SUPER_EMAIL }
    const gw: any = pgliteGateway(db, L, { staff: L.U.A, super: L.U.super }, { failOn: opts.failOn })
    // svc = service_role thật của PGlite (không phải superuser/owner).
    const asSvc = (f: any) => (...a: any[]) => L.as(db, null, () => f(...a), 'service_role')
    gw.svc = { select: asSvc(gw.svc.select), count: asSvc(gw.svc.count), rpc: asSvc(gw.svc.rpc), insert: asSvc(gw.svc.insert), del: asSvc(gw.svc.del) }
    const markerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'care-d1-qa-')), '.qa-care.json')
    const ctx = { gw, env, envFileText: 'NEXT_PUBLIC_SUPABASE_URL=x\n', markerPath, nowMs: Date.parse('2026-10-15T05:00:00Z') }
    const n = async (sql: string) => Number((await db.query(sql)).rows[0].n)
    const totalTest = () => n(`SELECT
      (SELECT count(*) FROM public.care_import_batches WHERE is_test) + (SELECT count(*) FROM public.care_customers WHERE is_test)
      + (SELECT count(*) FROM public.care_tasks WHERE is_test) + (SELECT count(*) FROM public.care_assignment_events WHERE is_test)
      + (SELECT count(*) FROM public.care_task_products p JOIN public.care_tasks t ON t.id = p.task_id WHERE t.is_test)
      + (SELECT count(*) FROM public.care_import_staging) + (SELECT count(*) FROM public.care_import_revision_journal)
      + (SELECT count(*) FROM public.care_cancel_tokens) AS n`)
    const realSnapshot = async () => (await db.query(`SELECT
      (SELECT count(*)::int FROM public.care_import_batches WHERE NOT is_test AND status = 'committed') AS batches,
      (SELECT count(*)::int FROM public.care_customers WHERE NOT is_test) AS customers,
      (SELECT md5(string_agg(t.id::text || t.customer_name || t.status, ',' ORDER BY t.id)) FROM public.care_tasks t WHERE NOT t.is_test) AS tasks,
      (SELECT md5(string_agg(p.id::text || p.is_current::text, ',' ORDER BY p.id)) FROM public.care_task_products p
         JOIN public.care_tasks t ON t.id = p.task_id WHERE NOT t.is_test) AS products`)).rows[0]
    return { db, L, F, gw, env, ctx, markerPath, n, totalTest, realSnapshot }
  }

  test('vòng đời: initial + revision ⇒ huỷ revision (khôi phục chính xác) ⇒ huỷ initial ⇒ status ⇒ down sạch; dữ liệu thật cùng kỳ không đổi; output không ID/PII', async () => {
    const { db, L, F, ctx, markerPath, n, totalTest, realSnapshot } = await setup()
    // Dữ liệu THẬT cùng kỳ (import của Marketing) — QA is_test là initial riêng, không chạm dòng thật.
    const { period, today } = F.vnToday()
    const realRows = [L.row('THAT-1', 'QAOS01', L.EA, 'P1'), L.row('THAT-1', 'QAOS01', L.EA, 'P2'), L.row('THAT-2', 'QAOS01', L.EB, 'P1')]
    expect((await L.finalize(db, await L.stage(db, realRows, { period }), L.U.mkt, today)).status).toBe('committed')
    const real0 = await realSnapshot()
    expect(await totalTest()).toBe(0)

    const out = await F.cmdCancelQa(ctx)
    expect(out).toMatchObject({
      ok: true, kind: 'cancel-qa', period, customers: 4, rows: 8, revision: { created: 1, updated: 4 },
      // revision: 5 khách × 8 dòng (2,2,2,1 trên 4 task cũ + 1 trên khách mới); bộ trước = 8 dòng initial (2/khách).
      cancel_revision: { tasks_deleted: 1, tasks_restored: 4, products_deleted: 8, products_restored: 8, events_deleted: 1, customers_deleted: 1 },
      cancel_initial: { tasks_deleted: 4, tasks_restored: 0, products_deleted: 8, products_restored: 0, events_deleted: 4, customers_deleted: 4 },
    })
    for (const k of ['finalize_initial', 'finalize_revision', 'preview_revision', 'cancel_revision', 'preview_initial', 'cancel_initial']) {
      expect(Number.isInteger(out.timings_ms[k]) && out.timings_ms[k] >= 0, k).toBe(true)
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    expect(marker).toMatchObject({ v: 3, kind: 'cancel', phase: 'cancelled', host: HOST, customerIds: [], taskIds: [] })
    expect(await n(`SELECT count(*) n FROM public.care_import_batches WHERE is_test AND status = 'cancelled'`)).toBe(2)
    expect(await n(`SELECT count(*) n FROM public.care_import_revision_journal`)).toBe(0) // huỷ đã xoá journal của batch
    expect(await realSnapshot()).toEqual(real0)

    const st = await F.cmdStatus(ctx)
    expect(st).toMatchObject({ ok: true, marker: true, kind: 'cancel', phase: 'cancelled' })
    expect(st.counts).toMatchObject({ care_import_batches: 2, care_customers: 0, care_tasks: 0, care_task_products: 0, care_import_staging: 0, care_orders: 0 })
    await expect(F.cmdVerify(ctx)).rejects.toMatchObject({ code: 'PHASE' })
    await expect(F.cmdCancelQa(ctx)).rejects.toMatchObject({ code: 'GATE' }) // marker còn ⇒ không chạy chồng

    const down = await F.cmdDown(ctx)
    expect(down).toMatchObject({ ok: true, remaining: 0, deleted: { care_import_batches: 2, care_tasks: 0, care_customers: 0 } })
    expect(fs.existsSync(markerPath)).toBe(false)
    expect(await totalTest()).toBe(0)
    expect(await realSnapshot()).toEqual(real0)
    expect(JSON.stringify([out, st, down])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|@example|0390\d|QA-D1-|KH QA/)
    await db.close()
  })

  test('crash ở từng bước (finalize revision / huỷ revision / huỷ initial / sau huỷ initial) ⇒ marker đúng pha, status thấy đúng dòng, down dọn sạch (journal CASCADE), dữ liệu thật không đổi', async () => {
    const points: [string, number, string][] = [
      ['rpc:care_import_finalize', 2, 'reserved'], ['rpc:care_import_cancel', 1, 'imported'], ['rpc:care_import_cancel', 2, 'imported'],
      ['select:care_import_batches', -1, 'imported'],
    ]
    for (const [point, nth, phase] of points) {
      const [op, name] = point.split(':')
      let seen = 0
      let armed = nth > 0
      const { db, L, F, ctx, markerPath, totalTest, realSnapshot, n } = await setup({
        failOn: (o, t) => { if (armed && o === op && t === name && ++seen === nth) { armed = false; return true } return false },
      })
      const { period, today } = F.vnToday()
      expect((await L.finalize(db, await L.stage(db, [L.row('THAT-9', 'QAOS01', L.EA, 'P1')], { period }), L.U.mkt, today)).status).toBe('committed')
      const real0 = await realSnapshot()
      if (nth < 0) {
        // Chết sau huỷ initial, trước khi marker ghi pha cancelled (đếm batch cancelled là lệnh đọc cuối).
        const orig = ctx.gw.svc.count
        ctx.gw.svc.count = async (t: string, f: Filter[]) => { if (t === 'care_import_batches' && f.some(([c, , v]) => c === 'status' && v === 'cancelled')) throw SIMULATED(); return orig(t, f) }
      }
      await expect(F.cmdCancelQa(ctx), point).rejects.toBeTruthy()
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).phase, point).toBe(phase)
      const st = await F.cmdStatus(ctx)
      expect(st.counts.care_import_batches, point).toBe(2)
      if (nth === 1 && name === 'care_import_cancel') expect(st.counts.care_tasks, point).toBe(5) // chưa huỷ gì: 4 + 1
      if (nth === 2 && name === 'care_import_cancel') expect(st.counts.care_tasks, point).toBe(4) // đã huỷ revision
      if (nth > 0 && name === 'care_import_cancel') expect(await n(`SELECT count(*) n FROM public.care_import_revision_journal`), point).toBe(nth === 1 ? 4 : 0)
      expect(await F.cmdDown(ctx), point).toMatchObject({ ok: true, remaining: 0 })
      expect(fs.existsSync(markerPath), point).toBe(false)
      expect(await totalTest(), point).toBe(0)
      expect(await realSnapshot(), point).toEqual(real0)
      await db.close()
    }
  })

  test('phép kiểm không rỗng: RPC huỷ trả "cancelled" mà không khôi phục ⇒ RESTORE_MISMATCH; preview lệch số ⇒ PREVIEW_UNEXPECTED; down vẫn dọn sạch', async () => {
    for (const fake of ['cancel', 'preview'] as const) {
      const { db, F, ctx, markerPath, totalTest } = await setup()
      const orig = ctx.gw.svc.rpc
      ctx.gw.svc.rpc = async (fn: string, args: any) => {
        if (fake === 'cancel' && fn === 'care_import_cancel') return { status: 'cancelled', tasks_deleted: 1, tasks_restored: 4, customers_deleted: 1 }
        if (fake === 'preview' && fn === 'care_import_cancel_preview') { const r = await orig(fn, args); return { ...r, tasks_restored: r.tasks_restored + 1 } }
        return orig(fn, args)
      }
      await expect(F.cmdCancelQa(ctx), fake).rejects.toMatchObject({ code: fake === 'cancel' ? 'RESTORE_MISMATCH' : 'PREVIEW_UNEXPECTED' })
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).phase, fake).toBe('imported')
      ctx.gw.svc.rpc = orig
      expect(await F.cmdDown(ctx), fake).toMatchObject({ ok: true, remaining: 0 })
      expect(await totalTest(), fake).toBe(0)
      await db.close()
    }
  })

  test('import-only: dừng sau initial + revision (pha imported) ⇒ journal_rows = summary.updated = số dòng journal (điều kiện V6); down dọn sạch', async () => {
    const { db, F, ctx, markerPath, n, totalTest } = await setup()
    const out = await F.cmdCancelQa({ ...ctx, importOnly: true })
    expect(out).toMatchObject({ ok: true, mode: 'import-only', revision: { created: 1, updated: 4 } })
    expect(Object.keys(out.timings_ms).sort()).toEqual(['finalize_initial', 'finalize_revision'])
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).phase).toBe('imported')
    const rows = (await db.query(`SELECT b.kind, b.journal_rows, (b.summary->>'updated')::int upd,
      (SELECT count(*)::int FROM public.care_import_revision_journal j WHERE j.batch_id = b.id) jn
      FROM public.care_import_batches b WHERE b.is_test AND b.status = 'committed' ORDER BY b.commit_seq`)).rows
    expect(rows).toEqual([{ kind: 'initial', journal_rows: 0, upd: 0, jn: 0 }, { kind: 'revision', journal_rows: 4, upd: 4, jn: 4 }])
    expect(await n(`SELECT count(*) n FROM public.care_import_batches WHERE status = 'cancelled'`)).toBe(0)
    expect(await F.cmdDown(ctx)).toMatchObject({ ok: true, remaining: 0, deleted: { care_import_batches: 2, care_tasks: 5, care_customers: 5 } })
    expect(await totalTest()).toBe(0)
    await db.close()
  })

  test('hồi quy §8.6: fixture B6 cũ (marker v1) up ⇒ down dưới service_role trên DB 115 — guard INSERT batch staged, khách có created_batch_id dọn trước batch', async () => {
    const { db, F, ctx, markerPath, n, totalTest } = await setup()
    expect(await F.cmdUp(ctx)).toMatchObject({ ok: true, customers: 3, tasks: 3 })
    expect(await n(`SELECT count(*) n FROM public.care_customers WHERE is_test AND created_batch_id IS NOT NULL`)).toBe(3)
    expect(await F.cmdDown(ctx)).toMatchObject({ ok: true, remaining: 0, deleted: { care_import_batches: 1, care_customers: 3, care_tasks: 3 } })
    expect(fs.existsSync(markerPath)).toBe(false)
    expect(await totalTest()).toBe(0)
    await db.close()
  })

  test('down lỗi giữa chừng ⇒ marker tearing_down, chạy lại xong', async () => {
    const { db, F, ctx, markerPath, totalTest } = await setup()
    await F.cmdCancelQa(ctx)
    const origDel = ctx.gw.svc.del
    let once = true
    ctx.gw.svc.del = async (t: string, f: Filter[]) => { if (once && t === 'care_import_staging') { once = false; throw SIMULATED() } return origDel(t, f) }
    await expect(F.cmdDown(ctx)).rejects.toBeTruthy()
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).phase).toBe('tearing_down')
    expect(await F.cmdDown(ctx)).toMatchObject({ ok: true, remaining: 0 })
    expect(await totalTest()).toBe(0)
    await db.close()
  })

  test('cổng: cỡ sai / thiếu cờ / sai host / cờ trong .env.local / marker còn / khoá còn / chưa có 115 / còn batch-task test kỳ này ⇒ từ chối TRƯỚC khi ghi', async () => {
    const { db, L, F, ctx, markerPath, totalTest } = await setup()
    for (const [c, r] of [[1, 8], [4, 4], [4, 17], [10_000, 10_001], [4.5, 8], [Number.NaN, 8]] as const) {
      await expect(F.cmdCancelQa({ ...ctx, customers: c, rows: r }), `${c}/${r}`).rejects.toMatchObject({ code: 'LOAD_SIZE' })
    }
    expect(fs.existsSync(markerPath)).toBe(false)
    const variants: [string, any][] = [
      ['thiếu E2E_CARE_WRITE_QA', { ...ctx, env: { ...ctx.env, E2E_CARE_WRITE_QA: undefined } }],
      ['sai host', { ...ctx, env: { ...ctx.env, E2E_EXPECTED_SUPABASE_HOST: 'prod.khac.vn' } }],
      ['cờ trong .env.local', { ...ctx, envFileText: 'E2E_CARE_WRITE_QA=YES\n' }],
    ]
    for (const [name, c] of variants) await expect(F.cmdCancelQa(c), name).rejects.toMatchObject({ code: 'GATE' })
    fs.writeFileSync(markerPath, '{}')
    await expect(F.cmdCancelQa(ctx), 'marker còn').rejects.toMatchObject({ code: 'GATE' })
    fs.rmSync(markerPath)
    fs.writeFileSync(`${markerPath}.lock`, '{}')
    await expect(F.cmdCancelQa(ctx), 'khoá còn').rejects.toMatchObject({ code: 'GATE' })
    fs.rmSync(`${markerPath}.lock`)
    await db.query(`DELETE FROM public.app_migrations WHERE version = '115'`)
    await expect(F.cmdCancelQa(ctx)).rejects.toMatchObject({ code: 'NO_115' })
    await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('115', 'care_import_cancel')`)
    // Lượt QA khác chưa dọn (batch test committed kỳ này) ⇒ initial sẽ thành revision ⇒ dừng.
    const { period, today } = F.vnToday()
    const other = await L.stage(db, [L.row('QA-KHAC-1', 'QAOS01', L.EA, 'P1')], { period, isTest: true })
    expect((await L.finalize(db, other, L.U.mkt, today)).status).toBe('committed')
    const before = await totalTest()
    await expect(F.cmdCancelQa(ctx)).rejects.toMatchObject({ code: 'TEST_TASKS_EXIST' })
    expect(fs.existsSync(markerPath)).toBe(false)
    expect(await totalTest()).toBe(before) // không ghi thêm dòng nào
    await db.close()
  })

  test('marker v3 sai định dạng ⇒ MARKER_INVALID; marker trỏ batch của lượt khác ⇒ SCOPE_MISMATCH trước mọi DELETE; staging chia khối 2.000', async () => {
    const { db, F, ctx, markerPath, n } = await setup()
    const good = { v: 3, kind: 'cancel', runId: 'deadbeef', host: HOST, createdAt: 'x', period: F.vnToday().period, phase: 'imported',
      batchIds: ['00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000d002'], actorId: '00000000-0000-4000-8000-00000000d003',
      externalIds: F.cancelQaExternalIds('deadbeef', 3) }
    expect(F.validCancelMarker(good)).toBe(true)
    const bad: [string, any][] = [
      ['runId', { ...good, runId: 'XYZ' }], ['phase', { ...good, phase: 'ready' }], ['batch trùng', { ...good, batchIds: [good.batchIds[0], good.batchIds[0]] }],
      ['1 batch', { ...good, batchIds: [good.batchIds[0]] }], ['ID không suy ra từ runId', { ...good, externalIds: ['QA-D1-deadbeef-00001', 'X', 'Y'] }],
      ['ít khách', { ...good, externalIds: F.cancelQaExternalIds('deadbeef', 2) }], ['customerIds sai', { ...good, customerIds: ['nope'] }],
    ]
    for (const [name, m] of bad) {
      expect(F.validCancelMarker(m), name).toBe(false)
      fs.writeFileSync(markerPath, JSON.stringify(m))
      await expect(F.cmdStatus(ctx), name).rejects.toMatchObject({ code: 'MARKER_INVALID' })
      await expect(F.cmdDown(ctx), name).rejects.toMatchObject({ code: 'MARKER_INVALID' })
    }
    fs.rmSync(markerPath)

    // Lượt A thật (cancel-qa) chạy xong tới cancelled; marker B (runId khác) trỏ đúng batch của A ⇒ sha/tên lệch ⇒ dừng.
    const inserts: Record<string, number> = {}
    const origInsert = ctx.gw.svc.insert
    ctx.gw.svc.insert = async (t: string, rows: any[]) => { inserts[t] = (inserts[t] ?? 0) + 1; return origInsert(t, rows) }
    await F.cmdCancelQa({ ...ctx, customers: 600, rows: 2001 })
    expect(inserts.care_import_staging).toBe(4) // 2 batch × ⌈2001/2000⌉
    const a = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    fs.writeFileSync(markerPath, JSON.stringify({ ...good, phase: 'cancelled', batchIds: a.batchIds }))
    await expect(F.cmdDown(ctx)).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
    expect(await n(`SELECT count(*) n FROM public.care_import_batches WHERE is_test AND status = 'cancelled'`)).toBe(2) // không xoá gì
    fs.writeFileSync(markerPath, JSON.stringify(a))
    expect(await F.cmdDown(ctx)).toMatchObject({ ok: true, remaining: 0 })
    await db.close()
  })

  test('nguồn: cancel-qa gọi đúng RPC 115 qua service role với commit_seq dạng chuỗi; không UPDATE batch / không ghi journal-token; có trong CLI', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'care-qa-fixture.mjs'), 'utf8').replace(/\r\n/g, '\n')
    const body = src.slice(src.indexOf('export async function cmdCancelQa'), src.indexOf('/** Năm tài khoản QA browser'))
    expect(body).toContain("gw.svc.rpc('care_import_cancel', { p_batch_id: batchIds[1], p_actor: actor.id, p_expected_commit_seq: p2.commit_seq })")
    expect(body).toContain("typeof p2.commit_seq === 'string'")
    expect(body).not.toMatch(/Number\(p[12]\.commit_seq|BigInt\(|parseInt\(/)
    expect(src).not.toMatch(/(insert|del|update)\('care_(import_revision_journal|cancel_tokens)'/)
    expect(src).not.toMatch(/\.update\(\{/) // không UPDATE qua PostgREST (115 thu hồi UPDATE batch của service_role)
    expect(src).toMatch(/'load', 'cancel-qa'\]\.includes\(cmd\)/)
    expect(body.indexOf('createMarkerExclusive(markerPath, m)')).toBeLessThan(body.indexOf("gw.svc.insert('care_import_batches'"))
  })
})
