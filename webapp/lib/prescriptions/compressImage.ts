// Client-side image compression for prescription uploads.
//
// Camera photos from phones are routinely 5–10MB, which both upload slowly on
// mobile data and exceed the per-image cap. This downscales large images to a
// sane longest-edge and re-encodes as JPEG before upload. Dependency-free
// (browser canvas APIs only) and defensive: any failure returns the original file
// so an upload is never blocked by compression.

export interface CompressOptions {
  /** Longest edge in px of the output; larger images are scaled down to fit. */
  maxEdge?: number
  /** JPEG quality 0–1. */
  quality?: number
  /** Files at or below this size (bytes) within maxEdge are returned untouched. */
  skipBelowBytes?: number
}

const DEFAULTS: Required<CompressOptions> = {
  maxEdge: 1600,
  quality: 0.8,
  skipBelowBytes: 1.2 * 1024 * 1024, // 1.2MB
}

export async function compressImage(file: File, opts: CompressOptions = {}): Promise<File> {
  const { maxEdge, quality, skipBelowBytes } = { ...DEFAULTS, ...opts }

  // Only images; never touch anything else (helper is best-effort).
  if (!file.type.startsWith('image/')) return file

  // Required browser APIs — if missing (very old browser), skip compression.
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file

  try {
    // imageOrientation: 'from-image' bakes in EXIF rotation so the canvas output
    // is upright (phones store rotation in EXIF rather than rotating pixels).
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const { width, height } = bitmap

    const longest = Math.max(width, height)
    const withinSize = file.size <= skipBelowBytes

    // Small AND already within max dimension → no benefit, keep original.
    if (withinSize && longest <= maxEdge) {
      bitmap.close?.()
      return file
    }

    const scale = longest > maxEdge ? maxEdge / longest : 1
    const targetW = Math.max(1, Math.round(width * scale))
    const targetH = Math.max(1, Math.round(height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close?.()
      return file
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH)
    bitmap.close?.()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality),
    )
    if (!blob) return file

    // Don't keep the result if it somehow ended up larger than the original.
    if (blob.size >= file.size) return file

    const newName = file.name.replace(/\.[^./\\]+$/, '') + '.jpg'
    return new File([blob], newName, { type: 'image/jpeg', lastModified: Date.now() })
  } catch {
    return file
  }
}
