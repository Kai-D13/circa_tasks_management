'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { updateCampaign } from '@/app/actions/kpiCampaigns'
import { Button } from '@/components/ui/button'

// P3-E3 — Metric editor tab Cấu hình (audit): sửa CHỈ khi draft/paused;
// active/ended read-only. Checkbox Affiliate chỉ thao tác được khi
// KPI_AFFILIATE_ENABLED (prop server) — server action vẫn là boundary cuối
// (flag tắt → reject kể cả client cố gửi). Campaign affiliate sẵn có + flag
// tắt → hiển thị read-only, không cho sửa metric (fail-closed như action).
export function CampaignMetricEditor({
  campaignId, status, metricOffline, metricAffiliate, affiliateEnabled,
}: {
  campaignId: string
  status: string
  metricOffline: boolean
  metricAffiliate: boolean
  affiliateEnabled: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [offline, setOffline] = useState(metricOffline)
  const [affiliate, setAffiliate] = useState(metricAffiliate)

  const editable = status === 'draft' || status === 'paused'
  // Flag tắt: không cho đụng metric của campaign affiliate (server sẽ reject) —
  // hiển thị read-only để không tạo kỳ vọng sai.
  const affiliateLocked = !affiliateEnabled
  const changed = offline !== metricOffline || affiliate !== metricAffiliate

  function save() {
    if (!offline && !affiliate) { toast.error('Chọn ít nhất một chỉ số doanh số'); return }
    startTransition(async () => {
      const r = await updateCampaign(campaignId, { metric_offline: offline, metric_affiliate: affiliate })
      if (r?.error) { toast.error(r.error); return }
      toast.success('Đã cập nhật chỉ số doanh số')
      router.refresh()
    })
  }

  const row = (checked: boolean, onChange: (v: boolean) => void, disabled: boolean, label: string, sub: string) => (
    <label className={`inline-flex items-center gap-2 text-sm min-h-[44px] md:min-h-0 md:py-1 ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-4 w-4 accent-primary"
      />
      <span className="font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </label>
  )

  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-0.5">
        {row(offline, setOffline, !editable || pending, 'GMV Offline', '— doanh số bán tại cửa hàng (BI)')}
        {(affiliateEnabled || metricAffiliate) &&
          row(affiliate, setAffiliate, !editable || pending || affiliateLocked, 'GMV Affiliate', '— doanh số Circa Online ghi nhận theo mã đối tác của cửa hàng')}
      </div>
      {!editable && (
        <p className="text-xs text-muted-foreground">Chỉ sửa được khi chiến dịch ở trạng thái nháp/tạm dừng.</p>
      )}
      {editable && affiliateLocked && metricAffiliate && (
        <p className="text-xs text-muted-foreground">KPI_AFFILIATE_ENABLED đang tắt — không sửa được chỉ số của chiến dịch affiliate.</p>
      )}
      {editable && changed && (
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? 'Đang lưu…' : 'Lưu chỉ số'}
        </Button>
      )}
    </div>
  )
}
