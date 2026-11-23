// CRM-CSKH B0 — sáu outcome chăm sóc (CONTRACT R1) và tập "kết thúc task".
//
// NGUỒN DUY NHẤT phía TS. SQL `care_is_terminal_outcome(text)` + `care_outcome_requires_date(text)` IMMUTABLE
// (114, bản hiện hành ở 133) và spec parity ép hai nơi khớp nhau — đổi tập kết thúc / tập cần ngày phải sửa CẢ HAI.
//
// Đã chốt: INTERESTED kết thúc task, CALLBACK còn mở + bắt buộc ngày hẹn trong
// tháng task (Q-03/Q-48); REFUSED kết thúc + ghi từ chối theo khách + store
// (Q-54). Phần còn lại là mặc định đề xuất của PM/Dev, dễ đổi tại bảng dưới.
// TODO(Q-02): nhãn/thứ tự sáu giá trị theo bảng mục 4 tài liệu gốc.
// TODO(Q-03): ORDERED kết thúc, UNREACHABLE còn mở + bắt buộc ngày hẹn.
// PM 22/11/2026 (review cskh-hen-tu-choi-ly-do): NO_NEED chuyển sang nhóm "cần liên hệ lại" — còn mở + bắt buộc ngày
// hẹn, CHỈ áp cho lượt ghi mới (mig 133 đổi hai helper SQL; cột is_terminal đã lưu của lượt cũ giữ nguyên).
//
// Module thuần (không IO) — dùng chung server/client/test.

export const CARE_OUTCOMES = [
  'UNREACHABLE',
  'NO_NEED',
  'INTERESTED',
  'CALLBACK',
  'ORDERED',
  'REFUSED',
] as const

export type CareOutcome = (typeof CARE_OUTCOMES)[number]

export interface CareOutcomeMeta {
  label: string
  /** Ghi lượt có outcome này ⇒ task Hoàn thành, chỉ đọc (Q-52). */
  terminal: boolean
  /** Bắt buộc `next_action_date` trong tháng task. */
  requiresNextActionDate: boolean
  /** Ghi từ chối (khách, store của task) — chặn import/chuyển giao vào store đó. */
  recordsStoreRefusal: boolean
}

export const CARE_OUTCOME_META: Record<CareOutcome, CareOutcomeMeta> = {
  UNREACHABLE: { label: 'Không liên hệ được',            terminal: false, requiresNextActionDate: true,  recordsStoreRefusal: false },
  NO_NEED:     { label: 'Đã liên hệ – chưa có nhu cầu', terminal: false, requiresNextActionDate: true,  recordsStoreRefusal: false },
  INTERESTED:  { label: 'Khách quan tâm',                terminal: true,  requiresNextActionDate: false, recordsStoreRefusal: false },
  CALLBACK:    { label: 'Hẹn chăm sóc lại',              terminal: false, requiresNextActionDate: true,  recordsStoreRefusal: false },
  ORDERED:     { label: 'Đã đặt đơn',                    terminal: true,  requiresNextActionDate: false, recordsStoreRefusal: false },
  REFUSED:     { label: 'Từ chối chăm sóc',              terminal: true,  requiresNextActionDate: false, recordsStoreRefusal: true },
}

/** Tập outcome kết thúc task — dẫn xuất từ bảng trên, không khai báo lần hai. */
export const CARE_TERMINAL_OUTCOMES: readonly CareOutcome[] =
  CARE_OUTCOMES.filter((o) => CARE_OUTCOME_META[o].terminal)

export function isCareOutcome(value: unknown): value is CareOutcome {
  return typeof value === 'string' && (CARE_OUTCOMES as readonly string[]).includes(value)
}

/** Outcome lạ ⇒ false (fail-closed: không bao giờ coi giá trị lạ là Hoàn thành). */
export function isTerminalOutcome(value: unknown): boolean {
  return isCareOutcome(value) && CARE_OUTCOME_META[value].terminal
}

export function requiresNextActionDate(outcome: CareOutcome): boolean {
  return CARE_OUTCOME_META[outcome].requiresNextActionDate
}

export function careOutcomeLabel(outcome: CareOutcome): string {
  return CARE_OUTCOME_META[outcome].label
}
