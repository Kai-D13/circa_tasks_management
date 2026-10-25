import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { fetchAllByIdChunks, FETCH_CAP, FETCH_CHUNK, type FetchPage } from '../lib/tasks/fetchAll'
import { buildImportBatchGroups, type ImportBatchMember, type ImportBatchViewRow } from '../lib/tasks/importBatchGroups'

// T1-A (PM 24/10 `planning/reviews/2026-10-24-tasks-integrity-lag-brief-pm.md`): badge done/total của nhóm import trên /tasks
// tính từ tập thành viên ĐỦ. Test thuần (không DB): nguồn trang giả theo range + count exact như các test fetchAll sẵn có,
// ghép kết quả vào buildImportBatchGroups thật. Lưu ý: FETCH_CAP của fetchAllByIdChunks áp cho MỖI chunk batchIds, không
// phải trần tổng của cả trang /tasks.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')

type Member = { id: string; import_batch_id: string; status: string }
const members = (batchId: string, n: number, done: number): Member[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${batchId}-${String(i).padStart(5, '0')}`, import_batch_id: batchId, status: i < done ? 'done' : 'todo' }))

type Source = (idChunk: string[]) => (from: number, to: number) => Promise<FetchPage<Member>>
// Nguồn: lọc theo chunk batchIds rồi trả trang theo range + count exact (giống PostgREST có phân trang).
const pagedSource = (all: Member[]): Source => (idChunk) => (from, to) => {
  const rows = all.filter((m) => idChunk.includes(m.import_batch_id))
  return Promise.resolve({ data: rows.slice(from, to + 1), error: null, count: rows.length })
}

const view = (batchId: string): ImportBatchViewRow => ({
  id: `${batchId}-view`, import_batch_id: batchId, title: 'Import QA', category: null, status: 'todo', created_at: '2026-10-24T00:00:00Z',
  deadline: null, overdue_at: null, completed_at: null, storeName: null, department: null, creator: null,
})

// Giống page: lỗi / thiếu ⇒ allMembers = null; đủ ⇒ map về ImportBatchMember.
async function membersFor(all: Member[], batchIds: string[], src: Source = pagedSource(all)): Promise<ImportBatchMember[] | null> {
  const { rows, error } = await fetchAllByIdChunks<Member>(batchIds, src)
  return error ? null : rows.map((r) => ({ import_batch_id: r.import_batch_id, status: r.status }))
}

test.describe('tasks T1-A — badge nhóm import đủ số @desktop', () => {
  test('1.001 thành viên (qua 2 trang 1.000) ⇒ badge 1001 / done đúng; 999 và 1.000 cũng đúng', async () => {
    for (const [n, done] of [[999, 10], [1000, 500], [1001, 1001]] as const) {
      const all = members('B1', n, done)
      const g = buildImportBatchGroups([view('B1')], await membersFor(all, ['B1']))
      expect(g[0].total, `n=${n}`).toBe(n)
      expect(g[0].done, `n=${n}`).toBe(done)
    }
  })

  test('lỗi cũ: chỉ nhận 1.000 dòng đầu (bị cắt) thì badge ra 1000 — vì vậy KHÔNG được dùng query không phân trang', async () => {
    const all = members('B1', 1001, 0)
    const truncated = all.slice(0, FETCH_CHUNK).map((r) => ({ import_batch_id: r.import_batch_id, status: r.status }))
    expect(buildImportBatchGroups([view('B1')], truncated)[0].total).toBe(1000)
    expect(buildImportBatchGroups([view('B1')], await membersFor(all, ['B1']))[0].total).toBe(1001)
  })

  test('trang sau lỗi ⇒ allMembers null ⇒ badge "—/—" (total / done null), không hiện 1000', async () => {
    const all = members('B1', 1001, 0)
    const failSecondPage: Source = () => (from, to) => from === 0
      ? Promise.resolve({ data: all.slice(from, to + 1), error: null, count: all.length })
      : Promise.resolve({ data: null, error: { message: 'trang 2 lỗi' }, count: null })
    const m = await membersFor(all, ['B1'], failSecondPage)
    expect(m).toBeNull()
    const g = buildImportBatchGroups([view('B1')], m)
    expect(g[0].total).toBeNull()
    expect(g[0].done).toBeNull()
  })

  test('count đổi giữa hai trang ⇒ badge "—/—"', async () => {
    const all = members('B1', 1001, 0)
    const changing: Source = () => (from, to) =>
      Promise.resolve({ data: all.slice(from, to + 1), error: null, count: from === 0 ? 1001 : 1002 })
    expect(buildImportBatchGroups([view('B1')], await membersFor(all, ['B1'], changing))[0].total).toBeNull()
  })

  test('nhiều batch (> 100 batchIds ⇒ nhiều chunk) ⇒ mỗi badge đúng số của batch đó', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `B${i}`)
    const all = [...members('B0', 1001, 3), ...ids.slice(1).flatMap((b) => members(b, 5, 1))]
    const g = buildImportBatchGroups(ids.map(view), await membersFor(all, ids))
    const byId = new Map(g.map((x) => [x.batchId, x]))
    expect(byId.get('B0')?.total).toBe(1001)
    expect(byId.get('B0')?.done).toBe(3)
    expect(byId.get('B149')?.total).toBe(5)
  })

  test('trùng ID giữa hai trang (nguồn trả lặp dòng) ⇒ thiếu dòng duy nhất ⇒ badge "—/—"', async () => {
    const all = members('B1', 1001, 0)
    const dup: Source = () => (from, to) =>
      Promise.resolve({ data: from === 0 ? all.slice(0, to + 1) : [all[0]], error: null, count: all.length })
    expect(buildImportBatchGroups([view('B1')], await membersFor(all, ['B1'], dup))[0].total).toBeNull()
  })

  test(`FETCH_CAP (${FETCH_CAP}) áp cho MỖI chunk batchIds: vượt trong một chunk ⇒ "—/—"; hai chunk khác nhau mỗi chunk dưới trần ⇒ đúng`, async () => {
    // Một batch vượt trần ⇒ không tính badge từ 10.000 dòng đầu.
    const big = members('B1', FETCH_CAP + 1, 0)
    expect(buildImportBatchGroups([view('B1')], await membersFor(big, ['B1']))[0].total).toBeNull()
    // Hai batch 6.000 cùng chunk (12.000 > trần) ⇒ "—/—" cho cả trang.
    const same = [...members('B0', 6000, 1), ...members('B1', 6000, 2)]
    expect(await membersFor(same, ['B0', 'B1'])).toBeNull()
    // Cùng hai cỡ nhưng rơi vào hai chunk (B0 ở chunk 1, B100 ở chunk 2) ⇒ mỗi chunk ≤ trần ⇒ đúng (không có rào tổng).
    const ids = Array.from({ length: 101 }, (_, i) => `B${i}`)
    const split = [...members('B0', 6000, 1), ...members('B100', 6000, 2)]
    const g = new Map(buildImportBatchGroups(ids.map(view), await membersFor(split, ids)).map((x) => [x.batchId, x]))
    expect(g.get('B0')?.total).toBe(6000)
    expect(g.get('B100')?.total).toBe(6000)
    expect(g.get('B100')?.done).toBe(2)
  })

  test('nguồn: page dùng fetchAllByIdChunks, giữ bộ lọc, select có id + count exact, order id, range; lỗi ⇒ null', () => {
    const p = read('app/(dashboard)/tasks/page.tsx')
    const i = p.indexOf("const { rows: memberRows, error: memberErr } = await fetchAllByIdChunks")
    expect(i).toBeGreaterThan(0)
    const block = p.slice(i, p.indexOf('const importGroups = buildImportBatchGroups', i))
    expect(block).toContain(".select('id, import_batch_id, status', { count: 'exact' })")
    expect(block).toContain(".in('import_batch_id', idChunk)")
    expect(block).toContain(".is('archived_at', null)")
    for (const f of ['priority', 'store_id', 'category', 'department_id']) expect(block).toContain(`mq = mq.eq('${f}', params.${f})`)
    expect(block).toContain(".order('id', { ascending: true }).range(from, to)")
    expect(block).toMatch(/if \(memberErr\) \{[\s\S]*?importMembers = null/)
  })
})
