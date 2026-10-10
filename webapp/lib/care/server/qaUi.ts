import 'server-only'
import { headers } from 'next/headers'
import { carePeriodOf } from '@/lib/care/time'
import { CARE_PRODUCTION_SCOPE, type CareDataScope } from '@/lib/care/scope'
import type { CareImportQa } from '@/lib/care/import/handler'
import {
  CARE_QA_OFF, careImportQaMarker, careQaRequestAllowed, evaluateCareQaUi, type CareQaUiState,
} from '@/lib/care/qa/uiGate'
import { beginCareQaImport, careQaMarkerPath, finishCareQaImport, readCareQaEnvFiles, readTextOrNull } from '@/lib/care/qa/uiMarkerIo'

// CRM-CSKH B6-qa-ui — nối cổng QA (lib/care/qa/uiGate.ts) với process thật của dev server.
// Production (NODE_ENV khác development) trả 'off' NGAY, không đọc file nào.
// Đọc lại marker mỗi lần gọi (dev server local, file vài trăm byte) — prepare/down/import đổi pha tức thì.

const logged = new Set<string>()

export function careQaUiState(): CareQaUiState {
  if (process.env.NODE_ENV !== 'development') return CARE_QA_OFF
  // Dev server KHÔNG có cờ vẫn đọc marker: còn lượt QA UI ⇒ blocked NOT_QA_LAUNCH (không chạy production trên file QA).
  const dir = process.cwd()
  let state: CareQaUiState
  try {
    state = evaluateCareQaUi({
      nodeEnv: process.env.NODE_ENV, env: process.env, envFiles: readCareQaEnvFiles(dir),
      markerText: readTextOrNull(careQaMarkerPath(dir)), period: carePeriodOf(new Date()),
    })
  } catch {
    state = { kind: 'blocked', reason: 'MARKER_INVALID' }
  }
  // Log một lần mỗi trạng thái (chỉ mã, không ID) — operator thấy lý do CRM tắt trên terminal dev server.
  const key = state.kind === 'blocked' ? `blocked:${state.reason}` : state.kind
  if (state.kind !== 'off' && !logged.has(key)) { logged.add(key); console.warn(`[care-qa-ui] ${key}`) }
  return state
}

/** Dược sĩ QA trong marker khi QA active (đích chuyển giao hợp lệ); null khi không ở chế độ QA. */
export function careQaStaffIds(): string[] | null {
  const s = careQaUiState()
  return s.kind === 'active' ? s.marker.accounts.staff : null
}

/** Phạm vi dữ liệu cho mọi truy vấn task CRM. QA bị chặn ⇒ ném (CRM vốn đã tắt qua isCareEnabled). */
export function careDataScope(): CareDataScope {
  const s = careQaUiState()
  if (s.kind === 'off') return CARE_PRODUCTION_SCOPE
  if (s.kind === 'blocked') throw new Error('care_qa_blocked')
  return { kind: 'qa', batchId: s.marker.batchId }
}

export const isCareQaActive = () => careQaUiState().kind === 'active'

/** Theo request: production luôn true; QA active ⇒ Host loopback + tài khoản QA trong marker. */
export async function careQaViewerAllowed(userId: string): Promise<boolean> {
  const s = careQaUiState()
  if (s.kind === 'off') return true
  const h = await headers()
  return careQaRequestAllowed(s, { hostHeader: h.get('host'), userId })
}

/** Dependency import QA cho handler; null khi không ở chế độ QA active. */
export function careImportQaDeps(): CareImportQa | null {
  const s = careQaUiState()
  if (s.kind !== 'active') return null
  const dir = process.cwd()
  const batchId = s.marker.batchId
  return {
    marker: careImportQaMarker(s.marker),
    begin: async () => beginCareQaImport(dir, batchId),
    finish: async (result) => finishCareQaImport(dir, batchId, result),
  }
}
