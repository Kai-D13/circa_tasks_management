import { test, expect } from '@playwright/test'
import { fetchAllVerified, fetchAllByIdChunks, chunkIds, FETCH_CHUNK, FETCH_CAP, ID_CHUNK } from '../lib/tasks/fetchAll'

// r1.1 (audit P2#4) — orchestration test cho tầng fetch THẬT (fake page
// builders, không DB): ghép đủ nhiều trang, dedup id, count đổi giữa trang,
// vượt cap, lỗi trang sau, chunk UUID ≤100 chống URI-too-long.

type Row = { id: string }
const rows = (prefix: string, n: number, start = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${start + i}` }))

// Fake nguồn: danh sách row cố định + count exact — trả trang theo range.
const sourceOf = (all: Row[]) => (from: number, to: number) =>
  Promise.resolve({ data: all.slice(from, to + 1), error: null, count: all.length })

test.describe('tasks fetchAll orchestration @desktop', () => {
  test('ghép đủ 3 trang (2500 row, chunk 1000) — không trùng, không mất, không error', async () => {
    const all = rows('c', 2500)
    const r = await fetchAllVerified(sourceOf(all))
    expect(r.error).toBeNull()
    expect(r.rows).toHaveLength(2500)
    expect(new Set(r.rows.map((x) => x.id)).size).toBe(2500)
  })

  test('ORDERING LỆCH tạo id trùng giữa 2 trang → unique < expected → FAIL-VISIBLE (không phân loại giả)', async () => {
    // created_at trùng nhau + không có secondary order → page 2 lặp lại row của
    // page 1 và bỏ sót row khác; count == rows.length vẫn đúng nhưng unique thiếu.
    const p1 = rows('d', FETCH_CHUNK)
    const p2 = [...rows('d', 999, 1), { id: 'd-1' }] // lặp d-1, sót d-1999... mô phỏng
    const build = (from: number) =>
      Promise.resolve({ data: from === 0 ? p1 : p2, error: null, count: 2000 })
    const r = await fetchAllVerified((from) => build(from))
    expect(r.error).not.toBeNull()
    expect(r.error!.message).toContain('chưa tải đủ')
  })

  test('COUNT ĐỔI giữa các trang (staff submit giữa chừng) → error "thay đổi trong lúc tải"', async () => {
    const build = (from: number) =>
      Promise.resolve({ data: rows('e', FETCH_CHUNK, from), error: null, count: from === 0 ? 2000 : 2100 })
    const r = await fetchAllVerified((from) => build(from))
    expect(r.error).not.toBeNull()
    expect(r.error!.message).toContain('thay đổi trong lúc tải')
  })

  test('VƯỢT FETCH_CAP → error, không âm thầm cắt', async () => {
    const build = (from: number) =>
      Promise.resolve({ data: rows('f', FETCH_CHUNK, from), error: null, count: FETCH_CAP + 5000 })
    const r = await fetchAllVerified((from) => build(from))
    expect(r.error).not.toBeNull()
    expect(r.error!.message).toContain('chưa tải đủ')
  })

  test('trang sau LỖI → propagate ngay (không classify phần đã tải)', async () => {
    const build = (from: number) =>
      from === 0
        ? Promise.resolve({ data: rows('g', FETCH_CHUNK), error: null, count: 1500 })
        : Promise.resolve({ data: null, error: { message: 'db timeout' }, count: null })
    const r = await fetchAllVerified((from) => build(from))
    expect(r.error).toEqual({ message: 'db timeout' })
  })

  test('chunkIds: 250 UUID → [100,100,50] (không request nào mang >100 id — chống URI too long); rỗng → []', () => {
    const chunks = chunkIds(rows('h', 250).map((r) => r.id))
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50])
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(ID_CHUNK)
    expect(chunkIds([])).toEqual([])
  })

  test('fetchAllByIdChunks: gọi đúng từng chunk, gộp đủ kết quả; chunk giữa lỗi → dừng + propagate', async () => {
    const ids = rows('p', 250).map((r) => r.id)
    const calledChunks: number[] = []
    const ok = await fetchAllByIdChunks(ids, (idChunk) => {
      calledChunks.push(idChunk.length)
      const chunkRows = idChunk.map((id) => ({ id: `child-of-${id}` }))
      return () => Promise.resolve({ data: chunkRows, error: null, count: chunkRows.length })
    })
    expect(ok.error).toBeNull()
    expect(ok.rows).toHaveLength(250)
    expect(calledChunks).toEqual([100, 100, 50])

    let calls = 0
    const bad = await fetchAllByIdChunks(ids, () => {
      calls++
      return () => calls === 2
        ? Promise.resolve({ data: null, error: { message: 'chunk 2 fail' }, count: null })
        : Promise.resolve({ data: [{ id: `x-${calls}` }], error: null, count: 1 })
    })
    expect(bad.error).toEqual({ message: 'chunk 2 fail' })
    expect(calls).toBe(2) // dừng ngay, không gọi chunk 3
  })
})
