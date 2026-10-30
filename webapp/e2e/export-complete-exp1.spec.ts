import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  EXPORT_BUDGET_MS, EXPORT_ERR, EXPORT_MAX_ROWS, EXPORT_PAGE_SIZE, SEARCH_PAGE_SIZE, fetchExportRows, fetchSearchExportRows, isExportDay,
} from '../lib/export/fetchExportRows'

// EXP-1 (PM 25/10 `planning/reviews/2026-10-25-next-release-one-plan-pm.md` §2): export Tasks / Logs / Toa phải ĐỦ dòng hoặc
// báo lỗi — PostgREST cắt mọi response ở db-max-rows (prod 1.000) kể cả `.limit(5001)`; RPC tìm toa chặn p_limit ≤ 501.
// Test thuần (nguồn giả, không DB thật) cho helper phân trang + test nguồn khoá 3 route và migration 119.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const ids = (n: number, p = 'r') => Array.from({ length: n }, (_, i) => ({ id: `${p}-${String(i).padStart(6, '0')}` }))
type Row = { id: string }

// Nguồn PostgREST giả: count exact + range, server cắt ở `serverMax` dòng/response (như db-max-rows).
function rest(rows: Row[], o: { serverMax?: number; countAt?: (call: number) => number | null; pageHook?: (call: number, data: Row[]) => Row[]; failPage?: number; failCount?: number } = {}) {
  const calls = { count: 0, page: 0 }
  return {
    calls,
    count: async () => {
      calls.count++
      if (o.failCount === calls.count) return { count: null, error: { message: 'boom' } }
      return { count: rows.length, error: null }
    },
    page: async (from: number, to: number) => {
      calls.page++
      if (o.failPage === calls.page) return { data: null, error: { message: 'boom' }, count: null }
      const end = Math.min(to, from + (o.serverMax ?? 1000) - 1)
      let data = rows.slice(from, end + 1)
      if (o.pageHook) data = o.pageHook(calls.page, data)
      return { data, error: null, count: o.countAt ? o.countAt(calls.page) : rows.length }
    },
  }
}

test.describe('EXP-1 — export đủ dòng hoặc báo lỗi @desktop', () => {
  test('biên 0 / 999 / 1.000 / 1.001 / 5.000: đủ đúng thứ tự, số trang đúng, đếm trước + đếm lại', async () => {
    for (const n of [0, 999, 1000, 1001, 5000]) {
      const src = ids(n)
      const s = rest(src)
      const r = await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'x' })
      expect(r.ok, `n=${n}`).toBe(true)
      if (r.ok) expect(r.rows.map((x) => x.id)).toEqual(src.map((x) => x.id))
      expect(s.calls.page, `n=${n}`).toBe(Math.ceil(n / EXPORT_PAGE_SIZE))
      expect(s.calls.count).toBe(2)
    }
  })

  test('5.001 dòng ⇒ 400 "lọc hẹp hơn" ngay sau lượt đếm, không tải trang nào', async () => {
    const s = rest(ids(EXPORT_MAX_ROWS + 1))
    const r = await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'Quá nhiều dòng' })
    expect(r).toEqual({ ok: false, status: 400, error: 'Quá nhiều dòng' })
    expect(s.calls.page).toBe(0)
  })

  test('server cắt trang nhỏ hơn pageSize (max-rows 300) ⇒ vẫn đủ nhờ tiến theo số dòng thực nhận', async () => {
    const src = ids(2345)
    const s = rest(src, { serverMax: 300 })
    const r = await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'x' })
    expect(r.ok && r.rows.length).toBe(2345)
    expect(s.calls.page).toBe(Math.ceil(2345 / 300))
  })

  test('trùng khoá ở ranh trang (trang 2 lặp 1 dòng trang 1, sót 1 dòng) ⇒ 409, không file', async () => {
    const src = ids(1500)
    const s = rest(src, { pageHook: (call, data) => (call === 2 ? [src[999], ...data.slice(1)] : data) })
    const r = await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'x' })
    expect(r).toEqual({ ok: false, status: 409, error: EXPORT_ERR.changed })
  })

  test('count NULL ở BẤT KỲ trang nào ⇒ lỗi (không dung thứ như fetchAllVerified); count đổi giữa trang ⇒ 409', async () => {
    const src = ids(2500)
    let s = rest(src, { countAt: (c) => (c === 2 ? null : 2500) })
    expect(await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'x' })).toEqual({ ok: false, status: 500, error: EXPORT_ERR.count })
    s = rest(src, { countAt: (c) => (c === 1 ? null : 2500) })
    expect(await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'x' })).toEqual({ ok: false, status: 500, error: EXPORT_ERR.count })
    s = rest(src, { countAt: (c) => (c === 3 ? 2501 : 2500) })
    expect(await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'x' })).toEqual({ ok: false, status: 409, error: EXPORT_ERR.changed })
    const nul = { count: async () => ({ count: null, error: null }), page: s.page }
    expect(await fetchExportRows<Row>({ ...nul, tooMany: 'x' })).toEqual({ ok: false, status: 500, error: EXPORT_ERR.count })
  })

  test('trang 2 lỗi / lượt đếm lỗi ⇒ 500, không trả rows; trang rỗng khi chưa đủ ⇒ 409; dòng thiếu id ⇒ 500', async () => {
    let s = rest(ids(2500), { failPage: 2 })
    expect(await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'x' })).toEqual({ ok: false, status: 500, error: EXPORT_ERR.upstream })
    s = rest(ids(10), { failCount: 1 })
    expect(await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'x' })).toEqual({ ok: false, status: 500, error: EXPORT_ERR.upstream })
    s = rest(ids(2500), { pageHook: (c, d) => (c === 2 ? [] : d) })
    expect(await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'x' })).toEqual({ ok: false, status: 409, error: EXPORT_ERR.changed })
    s = rest(ids(5), { pageHook: (_c, d) => [...d.slice(0, 4), { id: '' }] })
    expect(await fetchExportRows<Row>({ count: s.count, page: s.page, tooMany: 'x' })).toEqual({ ok: false, status: 500, error: EXPORT_ERR.badRow })
  })

  test('quá ngân sách thời gian ⇒ 503 "quá thời gian", không trả rows', async () => {
    let t = 0
    const s = rest(ids(3500))
    const r = await fetchExportRows<Row>({ count: s.count, page: async (f, to) => { t += 30_000; return s.page(f, to) }, tooMany: 'x', now: () => t })
    expect(r).toEqual({ ok: false, status: 503, error: EXPORT_ERR.timeout })
    const q = rpc(1600)
    let t2 = 0
    const r2 = await fetchSearchExportRows({ page: async (o, l) => { t2 += 40_000; return q.page(o, l) }, tooMany: 'x', now: () => t2 })
    expect(r2).toEqual({ ok: false, status: 503, error: EXPORT_ERR.timeout })
  })

  // PM P1 25/10: truy vấn trả về muộn (vượt hạn NGAY TRONG lượt await, không còn trang kế tiếp để kiểm) không được thành file.
  test('quá hạn ngay trong lượt await: đếm đầu / trang cuối / trang duy nhất / đếm lại ⇒ 503; lỗi cùng lúc quá hạn ⇒ vẫn lỗi', async () => {
    // 'đếm đầu' dùng 0 dòng: không có trang nào ⇒ chỉ lần kiểm sau await chặn được (với n > 0 lần kiểm trước trang cũng chặn).
    const cases = [['đếm đầu (0 dòng)', 0, 'count', 1], ['trang cuối (3/3)', 2500, 'page', 3], ['trang duy nhất', 500, 'page', 1],
      ['đếm lại', 2500, 'count', 2], ['đối chứng: không quá hạn', 2500, 'page', 99]] as const
    for (const [name, n, kind, at] of cases) {
      let t = 0
      const s = rest(ids(n))
      const r = await fetchExportRows<Row>({
        count: async () => { const x = await s.count(); if (kind === 'count' && s.calls.count === at) t += EXPORT_BUDGET_MS + 1; return x },
        page: async (f, to) => { const x = await s.page(f, to); if (kind === 'page' && s.calls.page === at) t += EXPORT_BUDGET_MS + 1; return x },
        tooMany: 'x', now: () => t,
      })
      if (at === 99) expect.soft(r.ok && r.rows.length, name).toBe(n)
      else expect.soft(r, name).toEqual({ ok: false, status: 503, error: EXPORT_ERR.timeout })
    }
    let t = 0
    const s = rest(ids(10), { failCount: 2 })
    const r = await fetchExportRows<Row>({
      count: async () => { const x = await s.count(); if (s.calls.count === 2) t += EXPORT_BUDGET_MS + 1; return x },
      page: s.page, tooMany: 'x', now: () => t,
    })
    expect(r).toEqual({ ok: false, status: 500, error: EXPORT_ERR.upstream })
  })

  test('RPC Toa quá hạn ngay trong lượt: RPC đầu / trang cuối / tái kiểm / tái kiểm khi 0 kết quả ⇒ 503', async () => {
    const cases = [['RPC đầu (1 trang)', 300, 1], ['trang cuối (3/3)', 1201, 3], ['tái kiểm cuối lượt', 1201, 4],
      ['tái kiểm khi 0 kết quả', 0, 2], ['đối chứng: không quá hạn', 1201, 99]] as const
    for (const [name, n, at] of cases) {
      let t = 0
      const s = rpc(n)
      const r = await fetchSearchExportRows({
        page: async (o, l) => { const x = await s.page(o, l); if (s.calls.length === at) t += EXPORT_BUDGET_MS + 1; return x },
        tooMany: 'x', now: () => t,
      })
      if (at === 99) expect.soft(r.ok && r.rows.length, name).toBe(n)
      else expect.soft(r, name).toEqual({ ok: false, status: 503, error: EXPORT_ERR.timeout })
    }
  })

  test('log lỗi phía server chỉ có nhãn + loại + mã — không có error.message', async () => {
    const seen: unknown[][] = []
    const orig = console.error
    console.error = (...a: unknown[]) => { seen.push(a) }
    try {
      await fetchExportRows<Row>({
        count: async () => ({ count: null, error: { message: 'SECRET-q=0901234567', code: '57014' } as { message: string } }),
        page: rest([]).page, tooMany: 'x', label: 'logs',
      })
    } finally { console.error = orig }
    expect(seen).toEqual([['[export]', 'logs', 'count', '57014']])
  })

  test('đếm lại sau tải khác lượt đầu ⇒ 409', async () => {
    const src = ids(1200)
    let n = 0
    const r = await fetchExportRows<Row>({
      count: async () => ({ count: ++n === 1 ? 1200 : 1201, error: null }),
      page: rest(src).page, tooMany: 'x',
    })
    expect(r).toEqual({ ok: false, status: 409, error: EXPORT_ERR.changed })
  })

  test('GIỚI HẠN ghi rõ: tập id đổi nhưng tổng giữ nguyên giữa các lượt REST ⇒ không phát hiện (không phải snapshot atomic)', async () => {
    // Trang 1 phục vụ từ tập A; trước trang 2, một dòng ở trang 1 bị xoá và một dòng mới chèn ở cuối ⇒ tổng vẫn 1500.
    const a = ids(1500)
    const b = [...a.slice(0, 10), ...a.slice(11), { id: 'new-000001' }]
    let call = 0
    const r = await fetchExportRows<Row>({
      count: async () => ({ count: 1500, error: null }),
      page: async (from, to) => { call++; const src = call === 1 ? a : b; return { data: src.slice(from, to + 1), error: null, count: 1500 } },
      tooMany: 'x',
    })
    expect(r.ok).toBe(true) // ⇒ helper KHÔNG bảo đảm snapshot; báo cáo / runbook phải nói rõ
    if (r.ok) expect(new Set(r.rows.map((x) => x.id)).has('r-001000')).toBe(false) // dòng trôi lên ranh trang bị bỏ sót
  })
})

// RPC tìm toa giả: mỗi dòng mang total_count; server chặn p_limit ≤ 501 như migration 089 / 119.
function rpc(total: number, o: { failAt?: number; hook?: (call: number, d: { id: string; total_count: number | string }[]) => { id: string; total_count: number | string }[] } = {}) {
  const all: { id: string; total_count: number | string }[] = Array.from({ length: total }, (_, i) => ({ id: `rx-${String(i).padStart(6, '0')}`, total_count: total }))
  const calls: { offset: number; limit: number }[] = []
  return {
    calls,
    page: async (offset: number, limit: number) => {
      calls.push({ offset, limit })
      if (o.failAt === calls.length) return { data: null, error: { message: 'boom' } }
      let d = all.slice(offset, offset + Math.min(Math.max(limit, 1), 501))
      if (o.hook) d = o.hook(calls.length, d)
      return { data: d, error: null }
    },
  }
}

test.describe('EXP-1 — export Toa có từ khoá qua RPC (strict, không hạ cấp) @desktop', () => {
  test('1.201 toa, trang 500 ⇒ đủ đúng thứ tự (3 trang + 1 lượt tái kiểm); total_count dạng chuỗi cũng nhận', async () => {
    const s = rpc(1201)
    const r = await fetchSearchExportRows({ page: s.page, tooMany: 'x' })
    expect(r.ok && r.rows.length).toBe(1201)
    expect(s.calls.map((c) => c.offset)).toEqual([0, 500, 1000, 0])
    expect(s.calls.slice(0, 3).every((c) => c.limit === SEARCH_PAGE_SIZE)).toBe(true)
    const s2 = rpc(700, { hook: (_c, d) => d.map((x) => ({ ...x, total_count: String(x.total_count) })) })
    expect((await fetchSearchExportRows({ page: s2.page, tooMany: 'x' })).ok).toBe(true)
  })

  test('xin 5.001 / lượt nhưng RPC chỉ trả 501 ⇒ vẫn đủ (tiến theo số dòng thực nhận); 5.001 toa ⇒ 400 sau trang đầu', async () => {
    const s = rpc(1600)
    const r = await fetchSearchExportRows({ page: s.page, tooMany: 'x', pageSize: 5001 })
    expect(r.ok && r.rows.length).toBe(1600)
    expect(s.calls.slice(0, 4).map((c) => c.offset)).toEqual([0, 501, 1002, 1503])
    const big = rpc(EXPORT_MAX_ROWS + 1)
    expect(await fetchSearchExportRows({ page: big.page, tooMany: 'Quá nhiều' })).toEqual({ ok: false, status: 400, error: 'Quá nhiều' })
    expect(big.calls.length).toBe(1)
  })

  test('RPC lỗi ở trang đầu / trang sau / lượt tái kiểm ⇒ 503, không gọi thêm đường khác', async () => {
    for (const at of [1, 2, 4]) {
      const s = rpc(1201, { failAt: at })
      expect(await fetchSearchExportRows({ page: s.page, tooMany: 'x' }), `failAt=${at}`).toEqual({ ok: false, status: 503, error: EXPORT_ERR.search })
      expect(s.calls.length).toBe(at)
    }
  })

  test('total đổi / trùng id / trang rỗng giữa chừng ⇒ 409; 0 kết quả ⇒ file rỗng hợp lệ (có tái kiểm)', async () => {
    let s = rpc(1201, { hook: (c, d) => (c === 2 ? d.map((x) => ({ ...x, total_count: 1202 })) : d) })
    expect(await fetchSearchExportRows({ page: s.page, tooMany: 'x' })).toEqual({ ok: false, status: 409, error: EXPORT_ERR.changed })
    s = rpc(1201, { hook: (c, d) => (c === 2 ? [{ id: 'rx-000499', total_count: 1201 }, ...d.slice(1)] : d) })
    expect(await fetchSearchExportRows({ page: s.page, tooMany: 'x' })).toEqual({ ok: false, status: 409, error: EXPORT_ERR.changed })
    s = rpc(1201, { hook: (c, d) => (c === 3 ? [] : d) })
    expect(await fetchSearchExportRows({ page: s.page, tooMany: 'x' })).toEqual({ ok: false, status: 409, error: EXPORT_ERR.changed })
    s = rpc(0)
    expect(await fetchSearchExportRows({ page: s.page, tooMany: 'x' })).toEqual({ ok: true, rows: [] })
    expect(s.calls.length).toBe(2)
  })
})

test.describe('EXP-1 — nguồn 3 route + migration 119 @desktop', () => {
  const tasks = read('app/api/export/tasks/route.ts')
  const logs = read('app/api/export/logs/route.ts')
  const rx = read('app/api/export/prescriptions/route.ts')
  const search = read('lib/prescriptions/search.ts')

  test('3 route dùng helper phân trang + khoá cuối id; không còn một truy vấn .limit(MAX_ROWS + 1); không supabaseAdmin', () => {
    for (const [name, raw] of [['tasks', tasks], ['logs', logs], ['prescriptions', rx]] as const) {
      const src = raw.replace(/\/\/.*$/gm, '') // chỉ xét code, bỏ comment
      expect(src, name).toMatch(/\bfetchExportRows(<[^>]*>)?\(\{/)
      expect(src, name).not.toMatch(/\.limit\(\s*MAX_ROWS\s*\+\s*1\s*\)/)
      expect(src, name).not.toContain('limit(5001)')
      expect(src, name).toContain(".order('id', { ascending: false })")
      expect(src, name).toContain("{ count: 'exact', head }")
      expect(src, name).not.toContain('supabaseAdmin')
      expect(src, name).toContain("from '@/lib/supabase/server'")
    }
    expect(logs).toMatch(/\.order\('created_at', \{ ascending: false \}\)\s*\n\s*\.order\('id', \{ ascending: false \}\)/)
    // Cận trên thời gian = lúc bắt đầu request (tránh 409 giả khi bảng đang được ghi).
    expect(tasks).toContain(".lte('created_at', nowIso)")
    expect(logs).toContain(".lte('created_at', startIso)")
    expect(rx).toContain(".lte('submitted_at', toIso)")
    expect(rx).toContain('dateTo: toIso,')
  })

  test('tham số ngày Toa sai định dạng ⇒ 400 trước mọi truy vấn (không âm thầm bỏ cận ngày)', () => {
    for (const ok of [null, '', '2026-10-25', '2024-02-29']) expect(isExportDay(ok), String(ok)).toBe(true)
    for (const bad of ['2026-10-25T10:00', '2026-2-5', '2026-02-30', '2025-02-29', '25/10/2026', '2026-13-01', 'x'])
      expect(isExportDay(bad), bad).toBe(false)
    const guard = rx.indexOf("if (!isExportDay(p.get('date_from')) || !isExportDay(p.get('date_to')))")
    expect(guard).toBeGreaterThan(rx.indexOf("if (profile?.role !== 'admin')"))
    expect(guard).toBeLessThan(rx.indexOf('const userTo ='))
    expect(rx.slice(guard, guard + 200)).toContain("{ error: 'Khoảng ngày không hợp lệ' }, { status: 400 }")
  })

  test('quyền vai giữ nguyên: Tasks admin + SM, Logs admin + SM, Toa chỉ admin', () => {
    expect(tasks).toContain("if (role !== 'admin' && role !== 'sm')")
    expect(tasks).toContain("if (isSm) query = query.in('store_id', smStoreIds)")
    expect(logs).toContain('if (!isAdmin && !isSm)')
    expect(rx).toContain("if (profile?.role !== 'admin')")
  })

  test('Toa có từ khoá: chỉ đường strict qua RPC, KHÔNG hạ cấp sang ilike(order_code); trang danh sách vẫn có fallback cũ', () => {
    expect(rx).toContain('fetchSearchExportRows<PrescriptionSearchPageRow>(')
    expect(rx).toContain('searchPrescriptionsPageStrict(supabase')
    expect(rx).not.toMatch(/searchPrescriptionsPage\(supabase/)
    expect(rx).not.toContain("ilike('order_code'")
    expect(rx).not.toContain("'fallback'")
    expect(search).toContain("return 'fallback'")
    expect(search).toContain('export async function searchPrescriptionsPageStrict(')
  })

  test('cột file Toa giữ nguyên ở cả 2 nhánh; `id` không vào file', () => {
    const want = ['Mã đơn', 'Cửa hàng', 'Người nộp', 'Đồng bộ đơn', 'Số ảnh', 'Ghi chú', 'Thời gian nộp', 'Có ngày dùng', 'Khách hàng', 'SĐT khách',
      'Ngày bán', 'Số ngày dùng', 'Dự kiến hết thuốc', 'Ngày cần nhắc', 'Trạng thái chăm sóc', 'Link ảnh']
    const keys = [...rx.matchAll(/^\s*'([^']+)':\s/gm)].map((m) => m[1])
    expect(keys).toEqual([...want, ...want])
    expect(rx).not.toMatch(/'(id|ID)':/)
  })

  test('migration 119: chỉ thêm tie-breaker id (CTE paged + SELECT cuối), preflight 118, không GRANT / REVOKE; có rollback', () => {
    const mig = fs.readFileSync(path.join(ROOT, '..', 'supabase', 'migrations', '119_rx_search_page_stable_order.sql'), 'utf8').replace(/\r\n/g, '\n')
    const code = mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).toContain('CREATE OR REPLACE FUNCTION public.rpc_search_prescriptions_page(')
    expect(code).toContain('    ORDER BY match_score DESC, submitted_at DESC, id DESC\n')
    expect(code).toContain('  ORDER BY paged.match_score DESC, paged.submitted_at DESC, paged.id DESC;\n$$;')
    expect(code).toContain("WHERE version = '118'")
    expect(code).not.toMatch(/^\s*(GRANT|REVOKE)\b/m)
    expect(code).toContain('SECURITY INVOKER')
    expect(fs.existsSync(path.join(ROOT, '..', 'supabase', 'migrations', 'rollback', '119_rx_search_page_stable_order_rollback.sql'))).toBe(true)
  })
})
