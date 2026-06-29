import { Card, CardContent } from '@/components/ui/card'
import { formatDate, formatShiftTime } from '@/lib/dateUtils'
import { ClipboardCheck } from 'lucide-react'

// Business-context panel for an Inventory → TRF task (source_type='inventory_trf').
// Surfaces the Sheet fields that the generic InputDataDisplay doesn't render —
// notably "Người tạo phiếu" (input_data.internal_created_by, from the Sheet),
// which is distinct from the task's created_by (the Cycle Count system owner).
interface Props {
  trfCode: string | null
  posCode: string | null
  posName: string | null
  reason: string | null
  internalCreatedBy: string | null
  deadline: string | null
  completedByName: string | null
  completedAt: string | null
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 font-medium">{children}</span>
    </div>
  )
}

export function TrfInfoPanel({
  trfCode, posCode, posName, reason, internalCreatedBy, deadline, completedByName, completedAt,
}: Props) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="flex items-center gap-1.5 font-semibold text-sm mb-2">
          <ClipboardCheck className="h-4 w-4 text-primary" />
          Thông tin phiếu TRF
        </p>
        <div className="divide-y">
          <Row label="Mã TRF">{trfCode ?? '—'}</Row>
          <Row label="Cửa hàng">
            {posName ?? '—'}{posCode ? ` · ${posCode}` : ''}
          </Row>
          <Row label="Lý do">{reason ?? '—'}</Row>
          <Row label="Người tạo phiếu">{internalCreatedBy ?? '—'}</Row>
          <Row label="Hạn nộp">{deadline ? formatDate(deadline) : '—'}</Row>
          {completedByName && (
            <Row label="Người đã nộp">
              {completedByName}
              {completedAt ? ` · ${formatShiftTime(completedAt, true)}` : ''}
            </Row>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
