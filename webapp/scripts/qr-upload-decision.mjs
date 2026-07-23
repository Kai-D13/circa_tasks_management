// P3-H r1 (audit P1 #1) — quyết định upload THUẦN, test khóa ở
// e2e/affiliate-qr-display.spec.ts. Object v1 là IMMUTABLE:
//   · chưa tồn tại           → UPLOAD_NEW (kèm ifGenerationMatch=0 phía caller)
//   · tồn tại + SHA khớp     → SKIP_OK (re-run idempotent, không ghi đè)
//   · tồn tại + SHA khác     → FAIL_DIFFERENT (KHÔNG BAO GIỜ ghi đè — thay QR
//                              phải dùng path v2)
//
// @param {{ exists: boolean, remoteSha?: string, localSha?: string }} p
// @returns {'UPLOAD_NEW' | 'SKIP_OK' | 'FAIL_DIFFERENT'}
export function decideUpload(p) {
  if (!p.exists) return 'UPLOAD_NEW'
  if (p.remoteSha && p.localSha && p.remoteSha === p.localSha) return 'SKIP_OK'
  return 'FAIL_DIFFERENT'
}
