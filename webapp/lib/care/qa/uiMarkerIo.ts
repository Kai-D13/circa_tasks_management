import fs from 'node:fs'
import path from 'node:path'
import {
  CARE_QA_ENV_FILES, CARE_QA_LOCK_FILE, CARE_QA_MARKER_FILE, parseCareQaUiMarker,
  type CareQaUiImportResult,
} from './uiGate'

// CRM-CSKH B6-qa-ui — IO file cho chế độ QA local (marker `.qa-care.json` + khoá import). Không
// `server-only` để test Playwright gọi được; chỉ lib/care/server/qaUi.ts dùng trong app (dev server).
// Định dạng marker do scripts/care-qa-fixture.mjs (prepare/status/down) tạo — cùng file, cùng khoá.

export function readTextOrNull(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw e
  }
}

export function readCareQaEnvFiles(dir: string): { name: string; text: string | null }[] {
  return CARE_QA_ENV_FILES.map((name) => ({ name, text: readTextOrNull(path.join(dir, name)) }))
}

export const careQaMarkerPath = (dir: string) => path.join(dir, CARE_QA_MARKER_FILE)
export const careQaLockPath = (dir: string) => path.join(dir, CARE_QA_LOCK_FILE)

/** Thay nguyên khối (tmp + rename) — không bao giờ để marker ghi dở. */
function writeMarkerAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

/**
 * Bắt đầu import QA: tạo khoá ĐỘC QUYỀN (wx) rồi chuyển marker reserved → importing TRƯỚC lần ghi DB đầu
 * tiên. Marker đổi (batch khác/không còn reserved) giữa lúc kiểm và lúc khoá ⇒ nhả khoá, false.
 */
export function beginCareQaImport(dir: string, batchId: string, nowIso = new Date().toISOString()): boolean {
  const lock = careQaLockPath(dir)
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: nowIso, batchId }), { flag: 'wx' })
  } catch {
    return false
  }
  try {
    const text = readTextOrNull(careQaMarkerPath(dir))
    const m = text === null ? null : parseCareQaUiMarker(JSON.parse(text))
    if (!m || m.phase !== 'reserved' || m.batchId !== batchId) { fs.rmSync(lock, { force: true }); return false }
    writeMarkerAtomic(careQaMarkerPath(dir), { ...m, phase: 'importing' })
    return true
  } catch {
    fs.rmSync(lock, { force: true })
    return false
  }
}

/** Kết thúc import QA (mọi kết cục): marker → imported + kết quả; luôn nhả khoá. Không ném. */
export function finishCareQaImport(dir: string, batchId: string, result: CareQaUiImportResult): void {
  try {
    const text = readTextOrNull(careQaMarkerPath(dir))
    const m = text === null ? null : parseCareQaUiMarker(JSON.parse(text))
    if (m && m.batchId === batchId && m.phase === 'importing') writeMarkerAtomic(careQaMarkerPath(dir), { ...m, phase: 'imported', importResult: result })
  } catch {
    // marker hỏng ⇒ server tự chặn ở lần đọc sau; down xử lý theo DB.
  } finally {
    try { fs.rmSync(careQaLockPath(dir), { force: true }) } catch { /* noop */ }
  }
}
