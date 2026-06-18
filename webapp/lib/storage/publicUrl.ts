// Browser-facing storage URLs must ALWAYS use the public Supabase origin.
// Server-side clients may talk to Kong over the internal docker network
// (SUPABASE_INTERNAL_URL) — calling .getPublicUrl() on those clients would
// leak internal hostnames into stored attachments / rendered <img> tags.
//
// Mirrors storage-js getPublicUrl exactly:
//   encodeURI(`${base}/storage/v1/object/public/${bucket}/${path}`)
const PUBLIC_ORIGIN = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '')

export function publicStorageUrl(bucket: string, path: string): string {
  const clean = path.replace(/^\/+/, '')
  // GCS-stored files (task_uploaded_files.bucket = 'gcs') live in the public GCS
  // bucket, not Supabase — build the GCS public URL (used by export routes).
  if (bucket === 'gcs') {
    const gcsBase = (process.env.GCS_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '')
    return encodeURI(`${gcsBase}/${clean}`)
  }
  return encodeURI(`${PUBLIC_ORIGIN}/storage/v1/object/public/${bucket}/${clean}`)
}
