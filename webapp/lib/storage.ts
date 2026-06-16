// Build a storage-safe object-key segment from a user-provided filename.
//
// Supabase Storage rejects keys containing non-ASCII / certain characters with
// a 400 "InvalidKey" — Vietnamese diacritics, the en-dash "–", spaces and
// parentheses all break it (e.g. "Hướng Dẫn Sử Dụng – Circa Tasks.pdf"). Use
// this for the KEY only; keep the ORIGINAL filename separately as display
// metadata (attachment.name) so users still see the real name.
//
// Output uses only [a-zA-Z0-9._-]; the caller still prefixes a timestamp/uuid
// so two files that sanitize to the same name never collide.
export function safeStorageName(filename: string): string {
  const trimmed = (filename ?? '').trim()
  const dot = trimmed.lastIndexOf('.')
  const rawBase = dot > 0 ? trimmed.slice(0, dot) : trimmed
  const rawExt  = dot > 0 ? trimmed.slice(dot + 1) : ''

  const clean = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
      .replace(/đ/gi, 'd')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')               // anything else → '-'
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')                    // trim leading/trailing -.

  const base = clean(rawBase).slice(0, 80) || 'file'
  const ext  = clean(rawExt).toLowerCase().slice(0, 12)
  return ext ? `${base}.${ext}` : base
}
