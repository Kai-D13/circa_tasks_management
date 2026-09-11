// Lõi THUẦN của scripts/qa-race-112.mjs (idiom lib-customer-proof.mjs): tách
// ra để e2e/qa-tooling-gates.spec.ts test được verdict cleanup + gate host mà
// KHÔNG cần DB. Script chính chỉ còn phần kết nối/side-effect.

/** Hostname của Postgres URL; null nếu không parse được. */
export function parseDbHost(dbUrl) {
  try { return new URL(dbUrl).hostname || null } catch { return null }
}

/**
 * Cleanup chỉ được coi là XONG khi: DELETE trả đúng 1 dòng, KHÔNG lỗi, và hậu
 * kiểm cả campaign lẫn target của fixture đều = 0. Bất kỳ điều gì khác ⇒ FAIL
 * (script phải exit ≠ 0 và GIỮ marker để dọn tay) — không bao giờ để "ALL PASS"
 * che một fixture is_test còn sót trên production.
 */
export function judgeCleanup({ deleted, campaignsLeft, targetsLeft, error }) {
  if (error) return { ok: false, reason: `cleanup lỗi: ${error}` }
  if (deleted !== 1) return { ok: false, reason: `DELETE trả ${deleted} dòng (phải đúng 1)` }
  if (campaignsLeft !== 0) return { ok: false, reason: `hậu kiểm: campaign còn ${campaignsLeft} dòng` }
  if (targetsLeft !== 0) return { ok: false, reason: `hậu kiểm: target còn ${targetsLeft} dòng` }
  return { ok: true, reason: 'fixture đã xoá, hậu kiểm 0/0' }
}

/** Dòng kết luận cuối — ALL PASS CHỈ khi cả test lẫn cleanup đều sạch. */
export function finalVerdict({ testsFailed, cleanupOk }) {
  return testsFailed || !cleanupOk ? 'RACE 112: FAIL' : 'RACE 112: ALL PASS'
}
