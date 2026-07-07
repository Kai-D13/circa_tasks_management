import 'server-only'

// FS product-import parser/validator (module "Quản lý FS" · "Sản phẩm").
// Input = raw rows of ONE chosen sheet (the sample file has one sheet per FS
// store). Columns: product_id, product_name. product_id arrives as a NUMBER in
// Excel (e.g. 2005946) → coerced to a plain integer string. A product_id may not
// repeat within a session → duplicates are flagged (row invalid) so the whole
// import blocks (no partial write, matching UNIQUE(session_id, product_id)).

export interface FsItemInput { product_id: string; product_name: string; import_row: number }
export interface FsImportResult {
  valid: FsItemInput[]
  invalid: { row: number; product_id: string | null; error: string }[]
  duplicates: string[]
}

const canon = (k: string) => k.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

// product_id allows only word chars, dash, underscore (no spaces, dots, sci-
// notation, punctuation) — it becomes part of the GCS object path in F4.
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]+$/

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const t = String(v).trim()
  return t === '' ? null : t
}

// Coerce + validate a product_id. null = empty cell; {error} = present but bad.
function coerceProductId(v: unknown): { id: string } | { error: string } | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return { error: 'product_id không hợp lệ (không được có phần thập phân)' }
    return { id: v.toFixed(0) } // 2005946 → "2005946" (no ".0"/sci-notation)
  }
  const t = String(v).trim()
  if (t === '') return null
  if (!PRODUCT_ID_RE.test(t))
    return { error: 'product_id chứa ký tự không hợp lệ (chỉ cho phép chữ, số, "_" và "-")' }
  return { id: t }
}

export function parseFsRows(rawRows: Record<string, unknown>[]): FsImportResult | { error: string } {
  if (rawRows.length === 0) return { error: 'Sheet không có dòng dữ liệu nào' }
  const headerKeys = new Set(Object.keys(rawRows[0]).map(canon))
  if (!headerKeys.has('productid')) return { error: 'Thiếu cột product_id' }
  if (!headerKeys.has('productname')) return { error: 'Thiếu cột product_name' }

  const valid: FsItemInput[] = []
  const invalid: { row: number; product_id: string | null; error: string }[] = []
  const seen = new Map<string, number>() // product_id → first row it appeared on
  const dupSet = new Set<string>()

  rawRows.forEach((raw, i) => {
    const rowNo = i + 2 // header = row 1
    const lo: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) lo[canon(k)] = v

    const pid = coerceProductId(lo['productid'])
    const productName = str(lo['productname'])
    if (pid === null && !productName) return // fully-empty row → skip

    if (pid === null) { invalid.push({ row: rowNo, product_id: null, error: 'Thiếu product_id' }); return }
    if ('error' in pid) { invalid.push({ row: rowNo, product_id: null, error: pid.error }); return }
    const productId = pid.id
    if (!productName) { invalid.push({ row: rowNo, product_id: productId, error: 'Thiếu product_name' }); return }

    const firstRow = seen.get(productId)
    if (firstRow !== undefined) {
      dupSet.add(productId)
      invalid.push({ row: rowNo, product_id: productId, error: `product_id trùng (đã có ở dòng ${firstRow})` })
      return
    }
    seen.set(productId, rowNo)
    valid.push({ product_id: productId, product_name: productName, import_row: rowNo })
  })

  return { valid, invalid, duplicates: [...dupSet] }
}
