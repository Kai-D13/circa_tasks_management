// CRM-CSKH B5c — điều phối MỘT lượt cron đóng kỳ (THUẦN, IO tiêm qua deps) theo SPEC §B5c, plan §2.8:
//   1. care_stamp_overdue(): ghi mốc trễ hẹn (first_overdue_on, một lần) cho task đang mở đã quá hẹn.
//   2. care_close_period(): đóng mọi task còn mở của kỳ TRƯỚC (ghi mốc trễ nếu có ngay trước khi đóng).
// Hai RPC idempotent (chạy lặp ⇒ 0 dòng) và tự lấy "hôm nay" theo giờ VN trong DB (care_vn_today()).
// Luôn gọi lần lượt CẢ HAI: đóng kỳ độc lập với bước 1 (tự ghi mốc trễ bằng COALESCE trước khi đóng) ⇒ bước 1
// lỗi kéo dài không được chặn đóng kỳ (security-reviewer P2). Bước nào lỗi ⇒ ok=false (route 500), code = lỗi
// ĐẦU TIÊN, trạng thái từng bước giữ nguyên để operator thấy; lượt sau hoàn tất phần còn thiếu.
// Kết quả chỉ có số đếm/mã — không ID task, không lỗi thô.

export type CarePeriodCloseCode = 'DB_STAMP_OVERDUE_FAILED' | 'DB_CLOSE_PERIOD_FAILED'
export type CarePeriodCloseStepStatus = 'ok' | 'failed' | 'skipped'

/** Trần phía app cho mỗi RPC (chống treo mạng/Kong); timeout DB 8 s của prod vẫn là chốt chính. */
export const CARE_PERIOD_CLOSE_RPC_TIMEOUT_MS = 30_000

export interface CarePeriodCloseDeps {
  stampOverdue(): Promise<number>
  closePeriod(): Promise<number>
  now(): number
}

export interface CarePeriodCloseStep { status: CarePeriodCloseStepStatus; rows: number | null }

export interface CarePeriodCloseResult {
  ok: boolean
  code?: CarePeriodCloseCode
  /** Số task vừa được ghi mốc trễ hẹn. */
  stampOverdue: CarePeriodCloseStep
  /** Số task kỳ trước vừa được đóng (Không hoàn thành). */
  closePeriod: CarePeriodCloseStep
  elapsedMs: number
}

export async function runCarePeriodClose(deps: CarePeriodCloseDeps): Promise<CarePeriodCloseResult> {
  const t0 = deps.now()
  const res: CarePeriodCloseResult = {
    ok: false,
    stampOverdue: { status: 'skipped', rows: null },
    closePeriod: { status: 'skipped', rows: null },
    elapsedMs: 0,
  }
  const finish = () => { res.elapsedMs = deps.now() - t0; return res }

  try {
    res.stampOverdue = { status: 'ok', rows: await deps.stampOverdue() }
  } catch {
    res.stampOverdue = { status: 'failed', rows: null }
    res.code = 'DB_STAMP_OVERDUE_FAILED'
  }
  try {
    res.closePeriod = { status: 'ok', rows: await deps.closePeriod() }
  } catch {
    res.closePeriod = { status: 'failed', rows: null }
    res.code ??= 'DB_CLOSE_PERIOD_FAILED'
  }
  res.ok = res.stampOverdue.status === 'ok' && res.closePeriod.status === 'ok'
  return finish()
}

/** Giá trị trả về của RPC (integer số dòng) ⇒ số; sai dạng ⇒ throw (fail-closed, không báo 0 giả). */
export function parseCarePeriodCloseCount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new Error('care_period_close_count_malformed')
  return raw
}
