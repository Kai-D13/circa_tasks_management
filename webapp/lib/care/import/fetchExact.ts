// CRM-CSKH B2 r1.1 (audit PM B2 P1-1) — tải đủ một truy vấn PostgREST có `count: 'exact'`,
// FAIL-CLOSED: preview không bao giờ được dựng từ lookup thiếu.
//
// Luật:
//   · `count` phải là số nguyên ≥ 0 ở MỌI trang và không đổi giữa các trang
//     (null ⇒ PostgREST không trả đếm — không biết đã đủ hay chưa ⇒ lỗi).
//   · Tiến theo SỐ DÒNG THỰC NHẬN, không theo kích thước trang yêu cầu ⇒ vẫn đúng khi
//     `max-rows` của PostgREST self-host nhỏ hơn PAGE.
//   · Trang rỗng / dữ liệu dừng trước khi đủ `count` / nhận nhiều hơn `count` ⇒ lỗi.
// THUẦN (không import Supabase) để test bằng adapter giả.

export const CARE_LOOKUP_PAGE = 1000

export type CareLookupPage<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null; count: number | null }>

export class CareLookupError extends Error {
  constructor(public readonly reason: 'query_error' | 'count_missing' | 'count_changed' | 'incomplete' | 'too_many') {
    super(`care_import_lookup_${reason}`)
    this.name = 'CareLookupError'
  }
}

export async function fetchExact<T>(build: (from: number, to: number) => CareLookupPage<T>, page = CARE_LOOKUP_PAGE): Promise<T[]> {
  const out: T[] = []
  let expected: number | null = null
  // Trần vòng lặp phòng adapter lỗi trả dữ liệu vô hạn.
  for (let guard = 0; guard < 10_000; guard++) {
    const { data, error, count } = await build(out.length, out.length + page - 1)
    if (error) throw new CareLookupError('query_error')
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new CareLookupError('count_missing')
    if (expected === null) expected = count
    else if (count !== expected) throw new CareLookupError('count_changed')
    const rows = data ?? []
    out.push(...rows)
    if (out.length > expected) throw new CareLookupError('too_many')
    if (out.length === expected) return out
    if (rows.length === 0) throw new CareLookupError('incomplete')
  }
  throw new CareLookupError('incomplete')
}
