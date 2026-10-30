// EXP-1 (PM 25/10 `planning/reviews/2026-10-25-next-release-one-plan-pm.md` §2): export XLSX phải ĐỦ dòng hoặc báo lỗi —
// không bao giờ phát file thiếu. PostgREST cắt mọi response ở `db-max-rows` (prod 1.000) kể cả khi gọi `.limit(5001)`, nên
// export phải phân trang và tự kiểm đủ. THUẦN (nhận callback, không import supabase) để test orchestration được.
//
// Bảo chứng:
//   · Đếm TRƯỚC (count exact, cùng bộ lọc): null / lỗi ⇒ lỗi; > trần ⇒ 400 ngay, không tải trang nào.
//   · Mỗi trang: count exact KHÁC null và BẰNG số đếm đầu; id không rỗng, không trùng; trang rỗng khi chưa đủ ⇒ thiếu.
//     Caller PHẢI sắp xếp theo khoá nghiệp vụ + `id` (khoá cuối duy nhất) để offset ổn định.
//   · Tiến offset theo số dòng THỰC nhận (đúng cả khi server cắt trang nhỏ hơn pageSize).
//   · Đếm LẠI sau khi tải: khác ⇒ 409. Chỉ trả rows khi mọi kiểm đạt.
//   · Ngân sách thời gian (mặc định 60 s) cho cả lượt ⇒ quá hạn 503, không phát file. Kiểm TRƯỚC mỗi trang và SAU mọi
//     lượt await (đếm đầu, từng trang kể cả trang cuối, đếm lại, tái kiểm RPC) + ngay trước mọi đường trả thành công ⇒ truy
//     vấn trả về muộn không bao giờ thành file (không huỷ truy vấn đang chạy). Có `error` cùng lúc quá hạn ⇒ báo lỗi upstream.
//   · Caller nên chốt cận trên thời gian = lúc bắt đầu request (created_at / submitted_at ≤ startIso) để dòng mới chèn trong lúc
//     xuất không làm đổi count ⇒ tránh 409 giả trên bảng đang ghi liên tục (task_logs).
//   · Giới hạn (cố ý ghi rõ): các request REST là riêng lẻ, KHÔNG phải snapshot transaction — nếu tập id đổi mà tổng giữ
//     nguyên giữa các lượt (vd. một dòng ra, một dòng vào ở phía sau con trỏ), kiểm tra không phát hiện được.
//   · Log lỗi phía server chỉ ghi nhãn route + loại lỗi + mã SQLSTATE — không ghi `q`, `error.message` hay dữ liệu dòng.

export const EXPORT_MAX_ROWS = 5000
export const EXPORT_PAGE_SIZE = 1000   // ≤ db-max-rows prod
export const SEARCH_PAGE_SIZE = 500    // ≤ trần p_limit 501 của rpc_search_prescriptions_page
export const EXPORT_BUDGET_MS = 60_000

// Tham số ngày của export (`YYYY-MM-DD`, ngày có thật). Rỗng / thiếu = không lọc; sai định dạng ⇒ caller trả 400 — không được
// âm thầm bỏ cận (file rộng hơn bộ lọc người dùng thấy) hay đẩy chuỗi hỏng xuống PostgREST / RPC.
export function isExportDay(s: string | null): boolean {
  if (!s) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = Date.parse(s + 'T00:00:00Z')
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s
}

export type ExportResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; status: 400 | 409 | 500 | 503; error: string }

type DbError = { message: string } | null

export const EXPORT_ERR = {
  changed: 'Dữ liệu thay đổi trong lúc xuất — chưa tạo file. Vui lòng xuất lại.',
  count: 'Không đếm được số dòng cần xuất — chưa tạo file. Vui lòng thử lại.',
  upstream: 'Không tải được dữ liệu xuất — chưa tạo file. Vui lòng thử lại.',
  badRow: 'Dữ liệu xuất không hợp lệ — chưa tạo file. Vui lòng thử lại.',
  search: 'Tìm kiếm toa đang lỗi — chưa tạo file. Vui lòng thử lại sau.',
  timeout: 'Xuất dữ liệu quá thời gian — chưa tạo file. Vui lòng lọc hẹp hơn rồi thử lại.',
} as const

const fail = <T>(status: 400 | 409 | 500 | 503, error: string): ExportResult<T> => ({ ok: false, status, error })
const validCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0
const logUpstream = (label: string | undefined, kind: string, error: DbError) =>
  console.error('[export]', label ?? '-', kind, (error as { code?: string } | null)?.code ?? '')

type Common = { tooMany: string; max?: number; pageSize?: number; label?: string; budgetMs?: number; now?: () => number }

export async function fetchExportRows<T extends { id: string }>(o: Common & {
  count: () => PromiseLike<{ count: number | null; error: DbError }>
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: DbError; count: number | null }>
}): Promise<ExportResult<T>> {
  const max = o.max ?? EXPORT_MAX_ROWS
  const size = o.pageSize ?? EXPORT_PAGE_SIZE
  const now = o.now ?? Date.now
  const deadline = now() + (o.budgetMs ?? EXPORT_BUDGET_MS)
  const late = () => now() > deadline
  const first = await o.count()
  if (first.error) { logUpstream(o.label, 'count', first.error); return fail(500, EXPORT_ERR.upstream) }
  if (late()) return fail(503, EXPORT_ERR.timeout)
  if (!validCount(first.count)) return fail(500, EXPORT_ERR.count)
  const total = first.count
  if (total > max) return fail(400, o.tooMany)

  const rows: T[] = []
  const seen = new Set<string>()
  let from = 0
  while (seen.size < total) {
    if (late()) return fail(503, EXPORT_ERR.timeout)
    const res = await o.page(from, from + size - 1)
    if (res.error) { logUpstream(o.label, 'page', res.error); return fail(500, EXPORT_ERR.upstream) }
    if (late()) return fail(503, EXPORT_ERR.timeout)
    if (!validCount(res.count)) return fail(500, EXPORT_ERR.count)
    if (res.count !== total) return fail(409, EXPORT_ERR.changed)
    const data = res.data ?? []
    if (data.length === 0) return fail(409, EXPORT_ERR.changed)
    for (const r of data) {
      if (typeof r.id !== 'string' || r.id === '') return fail(500, EXPORT_ERR.badRow)
      if (seen.has(r.id)) return fail(409, EXPORT_ERR.changed)
      seen.add(r.id)
      rows.push(r)
    }
    from += data.length
  }
  if (rows.length !== total) return fail(409, EXPORT_ERR.changed)

  const again = await o.count()
  if (again.error) { logUpstream(o.label, 'recount', again.error); return fail(500, EXPORT_ERR.upstream) }
  if (late()) return fail(503, EXPORT_ERR.timeout)
  if (!validCount(again.count)) return fail(500, EXPORT_ERR.count)
  if (again.count !== total) return fail(409, EXPORT_ERR.changed)
  return late() ? fail(503, EXPORT_ERR.timeout) : { ok: true, rows }
}

// Nhánh Toa có từ khoá: rpc_search_prescriptions_page phân trang bằng p_offset, mỗi dòng mang total_count của cả tập.
// Thứ tự duy nhất do migration 119 (… , id DESC). RPC lỗi ⇒ 503 — KHÔNG hạ cấp sang tìm theo mã đơn cho export.
export async function fetchSearchExportRows<T extends { id: string; total_count: number | string }>(o: Common & {
  page: (offset: number, limit: number) => PromiseLike<{ data: T[] | null; error: DbError }>
}): Promise<ExportResult<T>> {
  const max = o.max ?? EXPORT_MAX_ROWS
  const size = o.pageSize ?? SEARCH_PAGE_SIZE
  const now = o.now ?? Date.now
  const deadline = now() + (o.budgetMs ?? EXPORT_BUDGET_MS)
  const late = () => now() > deadline
  const totalOf = (r: T) => (typeof r.total_count === 'string' ? Number(r.total_count) : r.total_count)

  const first = await o.page(0, size)
  if (first.error) { logUpstream(o.label, 'search', first.error); return fail(503, EXPORT_ERR.search) }
  if (late()) return fail(503, EXPORT_ERR.timeout)
  const firstRows = first.data ?? []
  if (firstRows.length === 0) {
    // Không có dòng khớp ⇒ file rỗng hợp lệ; tái kiểm một lượt để không nhầm "trang rỗng do lỗi tạm".
    const re = await o.page(0, 1)
    if (re.error) { logUpstream(o.label, 'search', re.error); return fail(503, EXPORT_ERR.search) }
    if (late()) return fail(503, EXPORT_ERR.timeout)
    return (re.data ?? []).length === 0 ? { ok: true, rows: [] } : fail(409, EXPORT_ERR.changed)
  }
  const total = totalOf(firstRows[0])
  if (!validCount(total) || total < firstRows.length) return fail(500, EXPORT_ERR.count)
  if (total > max) return fail(400, o.tooMany)

  const rows: T[] = []
  const seen = new Set<string>()
  const take = (data: T[]): ExportResult<T> | null => {
    for (const r of data) {
      if (totalOf(r) !== total) return fail(409, EXPORT_ERR.changed)
      if (typeof r.id !== 'string' || r.id === '') return fail(500, EXPORT_ERR.badRow)
      if (seen.has(r.id)) return fail(409, EXPORT_ERR.changed)
      seen.add(r.id)
      rows.push(r)
    }
    return null
  }
  const bad0 = take(firstRows)
  if (bad0) return bad0
  let offset = firstRows.length
  while (seen.size < total) {
    if (late()) return fail(503, EXPORT_ERR.timeout)
    const res = await o.page(offset, size)
    if (res.error) { logUpstream(o.label, 'search', res.error); return fail(503, EXPORT_ERR.search) }
    if (late()) return fail(503, EXPORT_ERR.timeout)
    const data = res.data ?? []
    if (data.length === 0) return fail(409, EXPORT_ERR.changed)
    const bad = take(data)
    if (bad) return bad
    offset += data.length
  }
  if (rows.length !== total) return fail(409, EXPORT_ERR.changed)

  const re = await o.page(0, 1)
  if (re.error) { logUpstream(o.label, 'search', re.error); return fail(503, EXPORT_ERR.search) }
  if (late()) return fail(503, EXPORT_ERR.timeout)
  const reRows = re.data ?? []
  if (reRows.length === 0 || totalOf(reRows[0]) !== total) return fail(409, EXPORT_ERR.changed)
  return late() ? fail(503, EXPORT_ERR.timeout) : { ok: true, rows }
}
