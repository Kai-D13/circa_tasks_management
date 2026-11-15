// CMS-CALC-RET-2 — capture / làm sạch chuỗi THÔ q / u (thiết kế Dev r2 §4.1; PM D2 / D7). Module THUẦN (không node:*) để classify.ts
// dùng được ở mọi nơi; fp.ts re-export cho tương thích. Cùng hợp đồng SQL migration 130 (`cms__src_clean`, cột *_src / *_src_flag).
//  · capture: trước MỌI làm sạch; NUL ⇒ NULL + cờ NUL (PG text / jsonb không chứa U+0000); > CMS_SRC_MAX code point ⇒ NULL + cờ OVERSIZE.
//  · làm sạch = đúng `text()` của lớp nguồn (source/contract.ts): ký tự điều khiển → space, `String.prototype.trim()`, rỗng ⇒ null.

/** Trần độ dài chuỗi thô lưu được (code point). */
export const CMS_SRC_MAX = 64

export type CmsSrcFlag = 'NUL' | 'OVERSIZE'
export interface CmsSrcCapture { src: string | null; flag: CmsSrcFlag | null }

/** Capture chuỗi thô từ nguồn (BQ CAST AS STRING) — không làm sạch. */
export function cmsCaptureSrc(v: string | null | undefined): CmsSrcCapture {
  if (v === null || v === undefined) return { src: null, flag: null }
  if (v.includes('\u0000')) return { src: null, flag: 'NUL' }
  let n = 0
  for (const _ of v) { if (++n > CMS_SRC_MAX) return { src: null, flag: 'OVERSIZE' } }
  return { src: v, flag: null }
}

/** Hai capture cùng giá trị lưu ở DB (src + cờ) — so ngữ cảnh q / u của dòng gốc như seal N2. */
export function cmsSameCapture(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = cmsCaptureSrc(a)
  const y = cmsCaptureSrc(b)
  return x.src === y.src && x.flag === y.flag
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g
/** Làm sạch như lớp nguồn: điều khiển → space, trim() của JS, rỗng ⇒ null. SQL `cms__src_clean` phải trùng từng ký tự. */
export function cmsSrcClean(v: string | null): string | null {
  if (v === null) return null
  const t = v.replace(CONTROL_RE, ' ').trim()
  return t === '' ? null : t
}
