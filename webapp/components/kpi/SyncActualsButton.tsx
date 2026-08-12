'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { syncCampaignActuals } from '@/app/actions/kpiCampaigns'
import { syncedSubjectLabel } from '@/lib/kpi/campaignDisplay'
import { Button } from '@/components/ui/button'
import { RefreshCw } from 'lucide-react'

// Manual actual sync (super admin) — same lib the 2h cron uses.
// Mig 103 r1 (audit P2 copy): label theo loại chiến dịch — campaign Số khách
// hiện "Đồng bộ số khách" (nguồn Supabase, không BigQuery).
export function SyncActualsButton({ campaignId, metricType }: { campaignId: string; metricType?: string }) {
  const label = metricType === 'affiliate_customer_count' ? 'Đồng bộ số khách' : 'Đồng bộ doanh số'
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function handleSync() {
    startTransition(async () => {
      const r = await syncCampaignActuals(campaignId)
      if (r && 'error' in r && r.error) { toast.error(r.error); return }
      if (r && 'preserved' in r && r.preserved) {
        // Nguồn chưa sẵn sàng (stale/đang chạy/unmatched…) — số cũ được GIỮ,
        // không ghi đè 0. Hiện lý do để super admin xử lý nguồn.
        toast.info(`Giữ số liệu hiện tại — ${r.reason}`, { duration: 8000 })
        return
      }
      const ok = r as { upserted?: number; unmatched?: string[]; warnings?: string[] }
      const unmatched = ok.unmatched ?? []
      // 105 r1.3.1 (audit P1): degrade chỉ số phụ — tiền ĐÃ ghi nhưng Order/AOV
      // của một số POS bị ẩn. Toast riêng, giữ đủ lâu để đọc được POS + lý do.
      const warnings = ok.warnings ?? []
      if (warnings.length > 0) {
        // r1.1 (audit P2): nhãn theo LOẠI chiến dịch — không hard-code "GMV".
        toast.warning(
          `${syncedSubjectLabel(metricType)}. ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} cảnh báo khác)` : ''}`,
          { duration: 10000 },
        )
      }
      if (unmatched.length > 0) {
        // A store has a target but ZERO BigQuery rows in the range — surface it
        // so admin doesn't read a silent 0 as a clean sync.
        toast.warning(
          `Đồng bộ ${ok.upserted ?? 0} cửa hàng — ${unmatched.length} POS chưa có dữ liệu Offline (BigQuery) trong kỳ: ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? '…' : ''}`,
          { duration: 8000 },
        )
      } else if (warnings.length === 0) {
        // Chỉ báo "thành công trơn" khi KHÔNG có cảnh báo nào — tránh toast
        // success đè lên cảnh báo degrade phía trên.
        toast.success(`Đã đồng bộ ${ok.upserted ?? 0} cửa hàng`)
      }
      router.refresh()
    })
  }

  return (
    <Button size="sm" variant="outline" onClick={handleSync} disabled={pending} className="gap-1.5">
      <RefreshCw className={pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
      {pending ? 'Đang đồng bộ…' : label}
    </Button>
  )
}
