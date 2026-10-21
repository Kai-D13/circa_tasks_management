import { History } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { EmptyState } from '@/components/ds/EmptyState'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { CareImportCancelButton } from '@/components/care/CareImportCancelButton'
import type { CareCancelPreview, CareCancelResult } from '@/lib/care/importCancel'
import { formatDateTime } from '@/lib/dateUtils'

// Lịch sử import CRM (SPEC B2 §3). Chỉ metadata batch: kỳ, trạng thái, số đếm,
// mã lỗi — KHÔNG có file gốc (không lưu) hay tên/SĐT khách.
// D1: trạng thái "Đã huỷ" + nút "Huỷ file" CHỈ trên dòng server chỉ định (cờ ON + quyền import + batch committed mới nhất
// của kỳ hiện tại). Không tự đoán ở client; RPC 115 kiểm lại mọi điều kiện.

export interface CareImportCancelSlot {
  batchId: string
  preview: (input: { batchId: string }) => Promise<CareCancelPreview>
  cancel: (input: { batchId: string; expectedCommitSeq: string }) => Promise<CareCancelResult>
}

export interface CareImportHistoryRow {
  id: string
  period_month: string
  kind: 'initial' | 'revision' | null
  status: 'staged' | 'committed' | 'rejected' | 'duplicate' | 'cancelled'
  row_count: number
  customer_count: number | null
  created_at: string
  summary: Record<string, unknown> | null
  created_by_name: string | null
  /** D1 — chỉ có khi cờ huỷ ON (cột 115). */
  cancelled_at?: string | null
  cancelled_by_name?: string | null
}

const STATUS: Record<CareImportHistoryRow['status'], { tone: StatusTone; label: string }> = {
  committed: { tone: 'success', label: 'Đã import' },
  duplicate: { tone: 'neutral', label: 'Trùng file — không tạo mới' },
  rejected: { tone: 'danger', label: 'Bị từ chối' },
  staged: { tone: 'warning', label: 'Đang xử lý' },
  cancelled: { tone: 'neutral', label: 'Đã huỷ' },
}

function cancelNote(row: CareImportHistoryRow): string {
  const summary = row.summary
  const c = summary && typeof summary.cancel === 'object' && summary.cancel ? (summary.cancel as Record<string, unknown>) : null
  const t = c && typeof c.tasks_deleted === 'number' ? c.tasks_deleted : null
  const r = c && typeof c.tasks_restored === 'number' ? c.tasks_restored : null
  const by = [row.cancelled_by_name, row.cancelled_at ? formatDateTime(row.cancelled_at) : null].filter(Boolean).join(' · ')
  const what = t === null ? 'Đã huỷ file' : `Đã huỷ — xoá ${t.toLocaleString('vi-VN')} task${r ? `, hoàn nguyên ${r.toLocaleString('vi-VN')}` : ''}`
  return by ? `${what} (${by})` : what
}

const num = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('vi-VN') : '—')
const monthLabel = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`

function errorSummary(summary: Record<string, unknown> | null): string | null {
  if (!summary) return null
  if (summary.reason === 'stale_staging') return 'Hết hạn xử lý — tải lại file'
  const count = summary.error_count
  const errors = Array.isArray(summary.errors) ? (summary.errors as { code?: string }[]) : []
  if (typeof count !== 'number' || count === 0) return null
  const codes = [...new Set(errors.map((e) => e.code).filter(Boolean))].slice(0, 3).join(', ')
  return `${count.toLocaleString('vi-VN')} lỗi${codes ? ` (${codes})` : ''}`
}

export function CareImportHistory({ rows, cancel = null }: { rows: CareImportHistoryRow[]; cancel?: CareImportCancelSlot | null }) {
  if (rows.length === 0) {
    return <EmptyState icon={History} title="Chưa có lần import nào" hint="Các lần tải file sẽ hiện ở đây, kể cả file bị từ chối." />
  }
  return (
    <DataTableShell>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Thời gian</TableHead>
            <TableHead>Kỳ</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead className="text-right">Dòng</TableHead>
            <TableHead className="text-right">Khách</TableHead>
            <TableHead className="text-right">Tạo mới</TableHead>
            <TableHead className="text-right">Cập nhật</TableHead>
            <TableHead className="text-right">Giữ (đã có lượt)</TableHead>
            <TableHead>Ghi chú</TableHead>
            <TableHead>Người nạp</TableHead>
            {cancel && <TableHead className="text-right">Thao tác</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const s = r.summary ?? {}
            // Trạng thái lạ (DB mới hơn app) ⇒ nhãn trung tính, không vỡ trang (PM D1 r1 P1-2: rollback giữ batch cancelled).
            const st = STATUS[r.status] ?? { tone: 'neutral' as const, label: 'Không xác định' }
            const note = r.status === 'rejected' ? errorSummary(r.summary)
              : r.status === 'committed' ? (r.kind === 'revision' ? 'File sửa trong kỳ' : 'File đầu kỳ')
              : r.status === 'duplicate' ? 'Đã import file này trong kỳ'
              : r.status === 'cancelled' ? cancelNote(r) : null
            return (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap">{formatDateTime(r.created_at)}</TableCell>
                <TableCell>{monthLabel(r.period_month)}</TableCell>
                <TableCell><StatusBadge tone={st.tone}>{st.label}</StatusBadge></TableCell>
                <TableCell className="text-right tabular-nums">{num(r.row_count)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(r.customer_count)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(s.created)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(s.updated)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(s.skipped_has_interaction)}</TableCell>
                <TableCell className="max-w-[240px] truncate text-muted-foreground" title={note ?? undefined}>{note ?? '—'}</TableCell>
                <TableCell className="max-w-[180px] truncate">{r.created_by_name ?? '—'}</TableCell>
                {cancel && (
                  <TableCell className="text-right">
                    {cancel.batchId === r.id ? <CareImportCancelButton batchId={r.id} preview={cancel.preview} cancel={cancel.cancel} /> : null}
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </DataTableShell>
  )
}
