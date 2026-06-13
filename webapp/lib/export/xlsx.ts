import 'server-only'
import * as XLSX from 'xlsx'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// Build an .xlsx download Response from an array of flat row objects. Keys of
// the first row become the header order (json_to_sheet uses object keys).
// `filename` should NOT include the extension.
export function xlsxResponse(
  rows: Record<string, unknown>[],
  sheetName: string,
  filename: string,
): Response {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '(không có dữ liệu)': '' }])
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31)) // Excel sheet-name limit
  // type:'base64' is the deterministic output — type:'array' returns an
  // ArrayBuffer whose `.length` is undefined (a previous attempt produced
  // 0-byte / corrupt files). Decode the base64 to a plain Uint8Array.
  const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string
  const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
  const body = new Blob([bytes], { type: XLSX_MIME })

  // ASCII-safe filename + RFC 5987 UTF-8 variant for Vietnamese.
  const safe = filename.replace(/[^\w.-]+/g, '_')
  return new Response(body, {
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': `attachment; filename="${safe}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}.xlsx`,
      'Cache-Control': 'no-store',
    },
  })
}

// VN-local timestamp for filenames: YYYYMMDD_HHmm (Asia/Saigon).
export function stampVN(): string {
  const d = new Date(Date.now() + 7 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
}

// Format an ISO timestamp as VN-local "DD/MM/YYYY HH:mm" for cell display.
export function fmtVN(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = new Date(t + 7 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}
