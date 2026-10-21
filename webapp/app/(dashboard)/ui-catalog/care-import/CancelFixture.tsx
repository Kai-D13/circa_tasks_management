'use client'

import { CareImportHistory, type CareImportHistoryRow } from '@/components/care/CareImportHistory'
import type { CareCancelPreview, CareCancelResult } from '@/lib/care/importCancel'

// Bàn thử UI huỷ file import (D1). 100% DỮ LIỆU GIẢ, action giả chạy trong trình duyệt (không gọi mạng / server action).
// ?cancel=ok (mặc định) · has_activity · not_latest — chọn kết quả của action giả; window.__careCancelCalls đếm số lần gọi huỷ.
const OK_ID = '00000000-0000-4000-8000-0000000000c1'

const ROWS: CareImportHistoryRow[] = [
  {
    id: OK_ID, period_month: '2026-10-01', kind: 'revision', status: 'committed', row_count: 120, customer_count: 60,
    created_at: '2026-10-06T03:15:00Z', created_by_name: 'QA Marketing', summary: { created: 4, updated: 6, unchanged: 50, skipped_has_interaction: 0 },
  },
  {
    id: '00000000-0000-4000-8000-0000000000c2', period_month: '2026-10-01', kind: 'initial', status: 'cancelled', row_count: 80, customer_count: 40,
    created_at: '2026-10-03T01:30:00Z', created_by_name: 'QA Marketing', cancelled_at: '2026-10-03T02:10:00Z', cancelled_by_name: 'QA Marketing',
    summary: { created: 40, updated: 0, cancel: { tasks_deleted: 40, tasks_restored: 0, products_deleted: 80, products_restored: 0, events_deleted: 40, customers_deleted: 40 } },
  },
]

const COUNTS = { tasksDeleted: 4, tasksRestored: 6, productsDeleted: 18, productsRestored: 12, eventsDeleted: 4, customersDeleted: 4 }

export function CareImportCancelFixture({ mode }: { mode: 'ok' | 'has_activity' | 'not_latest' | 'off' }) {
  // ?cancel=off — như cờ CARE_IMPORT_CANCEL_ENABLED tắt (vd. sau rollback DB còn batch đã huỷ): lịch sử vẫn hiện "Đã huỷ", không cột Thao tác.
  if (mode === 'off') return <CareImportHistory rows={ROWS} />
  const preview = async (): Promise<CareCancelPreview> => {
    await new Promise((r) => setTimeout(r, 150))
    if (mode === 'has_activity') return { ok: false, code: 'HAS_ACTIVITY' }
    return { ok: true, commitSeq: '9007199254740993', kind: 'revision', counts: COUNTS }
  }
  const cancel = async (input: { batchId: string; expectedCommitSeq: string }): Promise<CareCancelResult> => {
    const w = window as unknown as { __careCancelCalls?: { batchId: string; expectedCommitSeq: string }[] }
    ;(w.__careCancelCalls ??= []).push(input)
    await new Promise((r) => setTimeout(r, 300))
    if (mode === 'not_latest') return { ok: false, code: 'NOT_LATEST' }
    return { ok: true, counts: COUNTS }
  }
  return <CareImportHistory rows={ROWS} cancel={{ batchId: OK_ID, preview, cancel }} />
}
