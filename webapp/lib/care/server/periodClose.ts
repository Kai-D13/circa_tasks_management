import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  CARE_PERIOD_CLOSE_RPC_TIMEOUT_MS, parseCarePeriodCloseCount, runCarePeriodClose,
  type CarePeriodCloseDeps, type CarePeriodCloseResult,
} from '@/lib/care/periodClose'

// CRM-CSKH B5c — nối deps thật cho cron care-period-close: 2 RPC service_role không tham số của migration 114
// (care_stamp_overdue, care_close_period). Lỗi DB chỉ thành MÃ (periodClose.ts) — không log/trả message thô.

class PeriodCloseDbError extends Error {}

const rpcSignal = () => AbortSignal.timeout(CARE_PERIOD_CLOSE_RPC_TIMEOUT_MS)

const realDeps: CarePeriodCloseDeps = {
  async stampOverdue() {
    const { data, error } = await supabaseAdmin.rpc('care_stamp_overdue').abortSignal(rpcSignal())
    if (error) throw new PeriodCloseDbError('stamp_overdue')
    return parseCarePeriodCloseCount(data)
  },
  async closePeriod() {
    const { data, error } = await supabaseAdmin.rpc('care_close_period').abortSignal(rpcSignal())
    if (error) throw new PeriodCloseDbError('close_period')
    return parseCarePeriodCloseCount(data)
  },
  now: () => Date.now(),
}

export function closeCarePeriod(): Promise<CarePeriodCloseResult> {
  return runCarePeriodClose(realDeps)
}
