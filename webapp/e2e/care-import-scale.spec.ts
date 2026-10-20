import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { CARE_IMPORT_HEADERS, CARE_IMPORT_MAX_ROWS } from '../lib/care/import/contract'

// CRM-CSKH Q-121 — finalize SQL 114 THẬT trên PGlite ở quy mô 20.000 dòng / 8.000 khách: đầu kỳ, nạp lại trùng file,
// file sửa trong kỳ (khách mới, khách vắng, task đã có lượt, task đã chuyển giao), kỳ sau. Dữ liệu GIẢ (QA-SC-…).
// PGlite 0.2.17 khởi động với enable_seqscan=off (prod: on) ⇒ planner chọn nested loop bậc hai, finalize 20.000 dòng mất
// hàng chục giây; test bật lại như prod (thời gian ở đây chỉ là bậc độ lớn — không suy ra prod).

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = path.resolve(__dirname, '..')
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))
const pad = (n: number, w: number) => String(n).padStart(w, '0')

/** Khách c ∈ [1, n]: store ((c−1) mod 25)+1, dược sĩ a/b; c lẻ 3 sản phẩm, chẵn 2 (8.000 khách ⇒ 20.000 dòng). */
function rowsFor(L: any, customers: number[], variant: (c: number) => number = () => 0) {
  const out: Record<string, string>[] = []
  for (const c of customers) {
    const st = ((c - 1) % 25) + 1
    const n = c % 2 ? 3 : 2
    for (let p = 0; p < n; p++) {
      const k = pad(((c * 37 + p * 101 + variant(c) * 7) % 1500) + 1, 4)
      out.push({
        customer_external_id: `QA-SC-${pad(c, 5)}`, customer_name: `KH QA ${pad(c, 5)}`, customer_phone: `03900${pad(c, 5)}`,
        target_store_code: `QAOS${pad(st, 2)}`, assignee_email: L.STORES[st - 1].assigneeEmails[c % 2], reason_type: 'chronic',
        reason_text: `QA tải — nhắc mua lại (${k})`, product_id: `QASC${k}`, product_name: `SP QA ${k}`,
        product_url: `https://cdn-gcs.thuocsi.vn/qa-fixture/QASC${k}.png`,
      })
    }
  }
  return out
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

test.describe('care Q-121 — finalize 114 ở quy mô 20.000 dòng / 8.000 khách (PGlite) @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  test.setTimeout(300_000)

  test('đầu kỳ → trùng file → file sửa trong kỳ (mới/vắng/đã có lượt/đã chuyển giao) → kỳ sau: đếm, sản phẩm hiện hành, lịch sử, owner', async () => {
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const db: any = await L.freshDb(PGlite)
    await db.exec('SET enable_seqscan = on')
    const n = async (sql: string, p: unknown[] = []) => Number(Object.values((await db.query(sql, p)).rows[0])[0])
    /** Staging như route B2: khối 2.000 dòng, row_no = số bản ghi CSV liền mạch; sha theo nội dung (file trùng ⇒ cùng sha). */
    const run = async (rows: Record<string, string>[], today: string) => {
      const period = `${today.slice(0, 7)}-01`
      const id = (await db.query(`INSERT INTO public.care_import_batches (period_month, file_name, file_sha256, row_count, created_by)
        VALUES ($1, 'qa.csv', $2, $3, $4) RETURNING id`, [period, L.sha(JSON.stringify(rows)), rows.length, L.U.mkt])).rows[0].id
      for (let i = 0; i < rows.length; i += 2000) {
        await db.query(`INSERT INTO public.care_import_staging (batch_id, row_no, payload)
          SELECT $1, (x->>'n')::int, x->'p' FROM jsonb_array_elements($2::jsonb) x`,
        [id, JSON.stringify(rows.slice(i, i + 2000).map((p, j) => ({ n: i + j + 2, p: Object.fromEntries(CARE_IMPORT_HEADERS.map((h) => [h, p[h]])) })))])
      }
      return L.finalize(db, id, L.U.mkt, today)
    }
    const OCT = '2026-10-01', D1 = '2026-10-10'
    const tasksIn = (period: string) => n(`SELECT count(*) FROM public.care_tasks WHERE period_month = $1`, [period])
    const currentProducts = (period: string) => n(`SELECT count(*) FROM public.care_task_products p JOIN public.care_tasks t ON t.id = p.task_id
      WHERE p.is_current AND t.period_month = $1`, [period])

    // (1) Đầu kỳ: 8.000 khách / 20.000 dòng.
    const first = rowsFor(L, range(1, 8000))
    // Quy mô mục tiêu Q-121 (DB finalize gọi thẳng — không qua trần dòng của route; trần phát hành hiện ≤ con số này).
    expect(first.length).toBe(20_000)
    expect(CARE_IMPORT_MAX_ROWS).toBeLessThanOrEqual(20_000)
    const r1 = await run(first, D1)
    expect(r1).toMatchObject({ status: 'committed', kind: 'initial', rows: 20_000, customers: 8000, created: 8000, stores: 25, absent_kept: 0 })
    expect([await tasksIn(OCT), await currentProducts(OCT)]).toEqual([8000, 20_000])
    expect(await n(`SELECT count(*) FROM public.care_assignment_events WHERE kind = 'assigned'`)).toBe(8000)
    expect(await n(`SELECT count(*) FROM public.care_import_staging`)).toBe(0)

    // (2) Nạp lại đúng file ⇒ duplicate, không ghi gì.
    expect((await run(first, D1)).status).toBe('duplicate')
    expect([await tasksIn(OCT), await currentProducts(OCT), await n(`SELECT count(*) FROM public.care_task_products`)]).toEqual([8000, 20_000, 20_000])

    // Lượt chăm sóc (khoá task) + chuyển giao (đổi owner) trước file sửa.
    const task = async (c: number) => L.taskOf(db, `QA-SC-${pad(c, 5)}`, OCT)
    const staffOf = (c: number) => L.staffId(((c - 1) % 25) + 1, c % 2 ? 'b' : 'a')
    const t1 = await task(1), t2 = await task(2), t4 = await task(4)
    expect(t1.assignee_id).toBe(staffOf(1))
    await L.record(db, D1, staffOf(1), t1.id, 'CALLBACK', 'hẹn gọi lại', '2026-10-12')
    await L.record(db, D1, staffOf(2), t2.id, 'NO_NEED', 'không cần')
    await L.transfer(db, D1, L.U.super, [t4.id], L.U.C, 'chuyển')
    const t4moved = await task(4)
    expect([t4moved.assignee_id, t4moved.store_id]).toEqual([L.U.C, L.storeId(2)])

    // (3) File sửa cùng kỳ: giữ 1..7.500 (khách chẵn đổi sản phẩm), bỏ 7.501..8.000, thêm 8.001..8.200.
    const second = [...rowsFor(L, range(1, 7500), (c) => (c % 2 ? 0 : 1)), ...rowsFor(L, range(8001, 8200))]
    const r2 = await run(second, D1)
    expect(r2).toMatchObject({
      status: 'committed', kind: 'revision', rows: second.length, customers: 7700, created: 200,
      updated: 3749, unchanged: 3749, skipped_has_interaction: 2, owner_ignored: 1, absent_kept: 500, closed_previous_period: 0,
    })
    expect(await tasksIn(OCT)).toBe(8200)
    // Hiện hành = 20.000 cũ (đổi sản phẩm giữ đúng số dòng/khách) + 500 dòng của 200 khách mới; lịch sử = sản phẩm cũ của 3.749 khách đổi.
    expect(await currentProducts(OCT)).toBe(20_500)
    expect(await n(`SELECT count(*) FROM public.care_task_products WHERE NOT is_current`)).toBe(3749 * 2)
    const pids = async (t: { id: string }) => (await db.query(`SELECT product_id FROM public.care_task_products WHERE task_id = $1 AND is_current ORDER BY product_id`, [t.id])).rows.map((x: any) => x.product_id)
    const oldPids = (c: number) => rowsFor(L, [c]).map((x) => x.product_id).sort()
    const newPids = (c: number) => rowsFor(L, [c], () => 1).map((x) => x.product_id).sort()
    expect(await pids(t2)).toEqual(oldPids(2)) // đã có lượt ⇒ giữ nguyên
    expect(await pids(t4)).toEqual(newPids(4)) // chưa có lượt ⇒ thay sản phẩm…
    const t4after = await task(4)
    expect([t4after.assignee_id, t4after.store_id]).toEqual([L.U.C, L.storeId(2)]) // …nhưng KHÔNG đổi owner (owner_ignored)
    expect((await task(8000)).status).toBe('open') // khách vắng file ⇒ giữ task
    expect(await n(`SELECT count(*) FROM public.care_assignment_events WHERE kind = 'assigned'`)).toBe(8200)
    expect(await n(`SELECT count(*) FROM public.care_import_staging`)).toBe(0)

    // (4) Kỳ sau: đóng task còn mở của kỳ trước, tạo task kỳ mới; dữ liệu kỳ trước không đổi.
    const r3 = await run(first, '2026-11-03')
    expect(r3).toMatchObject({ status: 'committed', kind: 'initial', created: 8000, closed_previous_period: 8199 })
    expect([await tasksIn('2026-11-01'), await currentProducts('2026-11-01')]).toEqual([8000, 20_000])
    expect([await tasksIn(OCT), await currentProducts(OCT)]).toEqual([8200, 20_500])
    expect(await n(`SELECT count(*) FROM public.care_tasks WHERE period_month = $1 AND status = 'closed_unfinished'`, [OCT])).toBe(8199)
    expect(await n(`SELECT count(*) FROM public.care_customers`)).toBe(8200) // khách lặp lại không tạo bản ghi khách mới
    await db.close()
  })
})
