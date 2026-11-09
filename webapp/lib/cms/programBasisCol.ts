// CMS-UNIT (spec PM 09/11 §4 / AC06) — đọc `cms_programs.quantity_basis` (migration 128) cho màn danh mục / kết quả mà app MỚI vẫn chạy
// được trên DB CŨ (trước 128): truy vấn kèm cột; PostgREST báo cột không tồn tại (SQLSTATE 42703) ⇒ chạy lại đúng truy vấn đó không có
// cột và coi chương trình là pos_base (DB cũ chỉ có luật cũ). Trên DB 128 số truy vấn không đổi. Giá trị lạ ⇒ lỗi đọc (không tự chọn
// cơ sở). Thuần (không server-only) để test được.
import { CmsQueryError } from './queryLog'
import { isCmsQuantityBasis, type CmsQuantityBasis } from './unitBasis'

/** Đoạn cột thêm vào select của cms_programs. */
export const CMS_PROGRAM_BASIS_COLS = ', quantity_basis'

type Res = { error: { code?: string } | null }

/** Chạy `run(cột thêm)`; lỗi 42703 (DB trước 128) ⇒ chạy lại với cột thêm rỗng. Lỗi khác ⇒ trả nguyên để caller xử lý. */
export async function cmsSelectWithBasis<R extends Res>(run: (extraCols: string) => PromiseLike<R>): Promise<R> {
  const r = await run(CMS_PROGRAM_BASIS_COLS)
  if (r.error && r.error.code === '42703') return run('')
  return r
}

/** Giá trị cột ⇒ cơ sở: thiếu (DB trước 128) ⇒ pos_base; 'pos_base' / 'cms_unit'; khác ⇒ CmsQueryError (không 0 / không đoán). */
export function cmsProgramBasisOf(v: unknown): CmsQuantityBasis {
  if (v === undefined) return 'pos_base'
  if (isCmsQuantityBasis(v)) return v
  throw new CmsQueryError('BASIS_INVALID')
}
