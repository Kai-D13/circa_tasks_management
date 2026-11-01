// CMS P1-b — chặn zip bomb TRƯỚC khi đưa file cho thư viện xlsx (security review P1-b, P1-1). Thuần.
// Đọc End of Central Directory + central directory của ZIP: từ chối ZIP64, quá nhiều entry, hoặc tổng kích thước
// giải nén khai báo vượt trần. Không giải nén gì. Giới hạn còn lại (central directory khai man kích thước) ghi trong
// report P1-b; endpoint chỉ super admin.

export const CMS_ZIP_MAX_ENTRIES = 200
export const CMS_ZIP_MAX_UNCOMPRESSED = 40 * 1024 * 1024

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

export type CmsZipGuardResult = { ok: true; entries: number; uncompressed: number } | { ok: false; reason: 'NOT_ZIP' | 'ZIP64' | 'TOO_MANY_ENTRIES' | 'TOO_LARGE' }

export function cmsZipGuard(bytes: Uint8Array): CmsZipGuardResult {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = bytes.byteLength
  if (n < 22) return { ok: false, reason: 'NOT_ZIP' }
  // EOCD nằm trong 22 + 65.535 byte cuối (comment tối đa 65.535).
  let eocd = -1
  for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) return { ok: false, reason: 'NOT_ZIP' }
  const total = dv.getUint16(eocd + 10, true)
  const cdSize = dv.getUint32(eocd + 12, true)
  const cdOff = dv.getUint32(eocd + 16, true)
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) return { ok: false, reason: 'ZIP64' }
  if (total > CMS_ZIP_MAX_ENTRIES) return { ok: false, reason: 'TOO_MANY_ENTRIES' }
  if (cdOff + cdSize > eocd) return { ok: false, reason: 'NOT_ZIP' }
  let p = cdOff
  let sum = 0
  for (let k = 0; k < total; k++) {
    if (p + 46 > eocd || dv.getUint32(p, true) !== CEN_SIG) return { ok: false, reason: 'NOT_ZIP' }
    const usize = dv.getUint32(p + 24, true)
    if (usize === 0xffffffff) return { ok: false, reason: 'ZIP64' }
    sum += usize
    if (sum > CMS_ZIP_MAX_UNCOMPRESSED) return { ok: false, reason: 'TOO_LARGE' }
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true)
  }
  return { ok: true, entries: total, uncompressed: sum }
}
