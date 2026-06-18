import { createUploadUrl, type CreateUploadUrlInput } from '@/app/actions/uploads'

// Client helper: try uploading a file straight to GCS via a server-minted
// resumable session. The STORAGE_PROVIDER flag is server-side only — when it's
// off, createUploadUrl returns GCS_DISABLED and this returns 'fallback' so the
// caller runs its existing Supabase upload (prod behavior unchanged until the
// flag is flipped).
//
// Returns:
//   { url, key }  — uploaded to GCS; persist `url` (same DB shape as before)
//   'fallback'    — GCS disabled; caller should use its Supabase path
//   { error }     — a real failure (authz/size/network); surface to the user
type GcsInput = Omit<CreateUploadUrlInput, 'filename' | 'contentType' | 'size'> & {
  filename: string
  contentType?: string
}

export async function uploadViaGcs(
  file: File | Blob,
  input: GcsInput,
): Promise<{ url: string; key: string } | 'fallback' | { error: string }> {
  const contentType = input.contentType || (file as File).type || 'application/octet-stream'
  const res = await createUploadUrl({ ...input, contentType, size: file.size })
  if ('error' in res) {
    return res.error === 'GCS_DISABLED' ? 'fallback' : { error: res.error }
  }
  const put = await fetch(res.sessionUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: file,
  })
  if (!put.ok) return { error: `Tải lên GCS thất bại (${put.status})` }
  return { url: res.publicUrl, key: res.key }
}
