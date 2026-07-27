// r1.1 (audit 28/07 — tactical, chờ RPC set-based per-group là đường bền vững):
// tầng fetch ĐẦY ĐỦ + VERIFY cho mọi query nuôi phân loại/badge của /tasks.
// THUẦN (nhận build callback, không import supabase) → test orchestration được.
//
// Bảo chứng chống các lỗi audit chỉ ra:
//   · Offset pagination cần THỨ TỰ DUY NHẤT — caller PHẢI thêm secondary
//     order `id` (created_at trùng nhau trong cùng transaction; Postgres không
//     đảm bảo thứ tự row bằng nhau → trang trùng/sót).
//   · Dedup theo `id` + verify uniqueIds.size === expected count (dup do
//     ordering lệch → size < expected → FAIL-VISIBLE, không phân loại giả).
//   · Count ĐỔI giữa các trang (dữ liệu thay đổi giữa chừng — staff đang
//     submit) → fail-visible "thử tải lại".
//   · UUID list KHÔNG nhét trăm id vào URL — chia chunk ≤100/request
//     (bài học "URI too long" của Prescriptions).
//   · Vượt FETCH_CAP → error (không âm thầm cắt).

import { fetchedComplete } from '@/lib/tasks/effectiveGroupStatus'

export interface FetchPage<T> {
  data: T[] | null
  error: { message: string } | null
  count: number | null
}

export const FETCH_CHUNK = 1000   // rows/trang (né PostgREST max-rows)
export const FETCH_CAP = 10000    // trần tổng row một nguồn
export const ID_CHUNK = 100       // UUID tối đa mỗi .in() request

export async function fetchAllVerified<T extends { id: string }>(
  build: (from: number, to: number) => PromiseLike<FetchPage<T>>,
): Promise<{ rows: T[]; error: { message: string } | null }> {
  const byId = new Map<string, T>()
  let expected: number | null = null
  for (let from = 0; from < FETCH_CAP; from += FETCH_CHUNK) {
    const { data, error, count } = await build(from, from + FETCH_CHUNK - 1)
    if (error) return { rows: [...byId.values()], error }
    const pageCount = count ?? null
    if (expected === null) {
      expected = pageCount
    } else if (pageCount !== null && pageCount !== expected) {
      // Dữ liệu đổi giữa các trang (vd staff submit trong lúc admin tải).
      return {
        rows: [...byId.values()],
        error: { message: `Dữ liệu thay đổi trong lúc tải (${expected} → ${pageCount} dòng) — tải lại trang để lấy số liệu nhất quán.` },
      }
    }
    for (const r of data ?? []) byId.set(r.id, r)
    if (expected !== null && byId.size >= expected) break
    if ((data ?? []).length < FETCH_CHUNK) break
  }
  if (!fetchedComplete(expected, byId.size)) {
    return {
      rows: [...byId.values()],
      error: { message: `Dữ liệu nhóm chưa tải đủ (${byId.size}/${expected ?? '?'} dòng duy nhất) — thu hẹp bộ lọc (cửa hàng/bộ phận/thời gian) rồi thử lại. Không phân loại từ dữ liệu thiếu.` },
    }
  }
  return { rows: [...byId.values()], error: null }
}

export function chunkIds(ids: string[], size = ID_CHUNK): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

// Fetch theo danh sách id lớn: chia chunk ≤100 id/request (không URI too long),
// mỗi chunk tự verify count riêng; lỗi chunk nào → fail toàn bộ (fail-visible).
export async function fetchAllByIdChunks<T extends { id: string }>(
  ids: string[],
  buildChunk: (idChunk: string[]) => (from: number, to: number) => PromiseLike<FetchPage<T>>,
): Promise<{ rows: T[]; error: { message: string } | null }> {
  const all: T[] = []
  for (const chunk of chunkIds(ids)) {
    const { rows, error } = await fetchAllVerified(buildChunk(chunk))
    if (error) return { rows: all, error }
    all.push(...rows)
  }
  return { rows: all, error: null }
}
