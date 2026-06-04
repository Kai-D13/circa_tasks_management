/**
 * Canvas-based image resize utilities (browser-only).
 * No external dependencies — uses the native Canvas API.
 */

/**
 * Resize a File/Blob so its longest edge ≤ maxEdge px, encode as JPEG/WebP.
 * Returns a Blob at the requested quality. Original aspect ratio is preserved.
 * If the image is already smaller than maxEdge it is re-encoded without upscaling.
 */
export function resizeImageBlob(
  file: File | Blob,
  maxEdge: number,
  quality = 0.82,
  outputType = 'image/jpeg',
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(objectUrl)

      const { naturalWidth: w, naturalHeight: h } = img
      const scale = Math.min(1, maxEdge / Math.max(w, h))
      const dw = Math.round(w * scale)
      const dh = Math.round(h * scale)

      const canvas = document.createElement('canvas')
      canvas.width  = dw
      canvas.height = dh
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas 2D context unavailable')); return }

      ctx.drawImage(img, 0, 0, dw, dh)
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Canvas toBlob returned null')),
        outputType,
        quality,
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Failed to load image for resizing'))
    }

    img.src = objectUrl
  })
}

/** Convenience wrapper: returns width × height of the blob after resizing. */
export function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload  = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to read image dimensions')) }
    img.src = url
  })
}
