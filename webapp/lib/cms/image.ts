// CMS — allow-list ảnh sản phẩm (SPEC §8.2, PM PR-0): chỉ HTTPS đúng host
// cdn-gcs.thuocsi.vn, pathname dưới /thuocsi-live/images/ — khớp remotePatterns
// của Next Image (P1-c). URL khác (javascript:, data:, http:, host khác, có
// credential, quá dài) ⇒ null ⇒ UI dùng ảnh dự phòng + cảnh báo import cho
// operator kiểm nguồn. Hàm thuần, không I/O.

export const CMS_IMAGE_HOST = 'cdn-gcs.thuocsi.vn'
export const CMS_IMAGE_PATH_PREFIX = '/thuocsi-live/images/'
const MAX_URL = 2000

export function cmsSafeImageUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const s = raw.trim()
  if (s === '' || s.length > MAX_URL) return null
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (u.protocol !== 'https:' || u.hostname !== CMS_IMAGE_HOST || u.port !== '') return null
  if (u.username || u.password) return null
  if (!u.pathname.startsWith(CMS_IMAGE_PATH_PREFIX) || u.pathname.includes('/../')) return null
  return u.toString()
}
