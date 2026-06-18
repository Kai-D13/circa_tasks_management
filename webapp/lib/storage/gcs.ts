import 'server-only'
import { getAccessToken, loadServiceAccount, type ServiceAccount } from '@/lib/google/auth'

// Google Cloud Storage client (no SDK) — direct-to-GCS uploads. The browser
// uploads straight to GCS via a server-minted resumable session, bypassing the
// Supabase storage stack. Public bucket → files served from GCS_PUBLIC_BASE_URL.
// Server-only (uses the service-account key). See docs/plan-gcs-storage.md.
//
// Env:
//   STORAGE_PROVIDER     — 'gcs' to route NEW uploads to GCS (else Supabase).
//   GCS_BUCKET           — bucket name (e.g. duocsi-circa-vn).
//   GCS_SA_KEY           — service-account JSON (raw or base64).
//   GCS_PUBLIC_BASE_URL  — public base, e.g. https://storage.googleapis.com/duocsi-circa-vn
//                          (swap to a Cloud CDN domain later — env-only change).

const RW_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write'
const TIMEOUT_MS = 15_000

export function isGcsEnabled(): boolean {
  return process.env.STORAGE_PROVIDER === 'gcs'
}

function bucket(): string {
  const b = process.env.GCS_BUCKET
  if (!b) throw new Error('GCS_BUCKET chưa cấu hình')
  return b
}

function loadGcsSA(): ServiceAccount {
  const sa = loadServiceAccount('GCS_SA_KEY')
  if (!sa) throw new Error('GCS_SA_KEY chưa hợp lệ (cần JSON service account, raw hoặc base64)')
  return sa
}

// Public URL for an object key in the (public) bucket.
export function publicUrlForKey(key: string): string {
  const base = (process.env.GCS_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '')
  if (!base) throw new Error('GCS_PUBLIC_BASE_URL chưa cấu hình')
  // Keys are produced by safeStorageName + timestamp → already URL-safe; keep '/'.
  return `${base}/${key}`
}

// Start a resumable upload session and return the session URL the browser PUTs to.
// The session is bound to `origin` so the cross-origin browser PUT passes CORS.
export async function createResumableUploadSession(
  key: string,
  contentType: string,
  origin: string,
  contentLength?: number,
): Promise<string> {
  const sa = loadGcsSA()
  const token = await getAccessToken(sa, RW_SCOPE)
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket())}/o`
    + `?uploadType=resumable&name=${encodeURIComponent(key)}`

  const headers: Record<string, string> = {
    'Authorization':         `Bearer ${token}`,
    'Content-Type':          'application/json; charset=UTF-8',
    'X-Upload-Content-Type': contentType || 'application/octet-stream',
    'Origin':                origin,
  }
  // Bind the declared size: GCS then requires the PUT to deliver exactly this many
  // bytes, so a client can't declare a small size to pass the server limit then
  // PUT a larger file.
  if (typeof contentLength === 'number' && contentLength > 0) {
    headers['X-Upload-Content-Length'] = String(contentLength)
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`GCS resumable init failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  const session = res.headers.get('location')
  if (!session) throw new Error('GCS không trả về session URL (Location header)')
  return session
}

// Delete an object (best-effort caller). Returns true on 2xx/404.
export async function deleteObject(key: string): Promise<boolean> {
  const sa = loadGcsSA()
  const token = await getAccessToken(sa, RW_SCOPE)
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket())}/o/${encodeURIComponent(key)}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return res.ok || res.status === 404
}

// Download an object's bytes (server-side, e.g. Excel import parsing).
export async function getObjectBytes(key: string): Promise<Buffer> {
  const sa = loadGcsSA()
  const token = await getAccessToken(sa, RW_SCOPE)
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket())}/o/${encodeURIComponent(key)}?alt=media`
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) throw new Error(`GCS download failed (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}
