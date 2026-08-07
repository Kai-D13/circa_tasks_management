'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { updateCampaign } from '@/app/actions/kpiCampaigns'
import { metricEditorState } from '@/lib/kpi/campaignDisplay'
import { Button } from '@/components/ui/button'

// P3-E3 — Metric editor tab Cấu hình (audit): sửa CHỈ khi draft/paused;
// active/ended read-only. Checkbox Affiliate chỉ thao tác được khi
// KPI_AFFILIATE_ENABLED (prop server) — server action vẫn là boundary cuối
// (flag tắt → reject kể cả client cố gửi). Campaign affiliate sẵn có + flag
// tắt → hiển thị read-only, không cho sửa metric (fail-closed như action).
export function CampaignMetricEditor({
  campaignId, status, metricOffline, metricAffiliate, affiliateEnabled, metricType,
}: {
  campaignId: string
  status: string
  metricOffline: boolean
  metricAffiliate: boolean
  affiliateEnabled: boolean
  // Mig 103: campaign Số khách — loại bất biến sau tạo → editor read-only hẳn.
  metricType?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [offline, setOffline] = useState(metricOffline)
  const [affiliate, setAffiliate] = useState(metricAffiliate)

  // r1 P2#1: trạng thái editor từ metricEditorState (contract THUẦN có test) —
  // flag tắt + campaign affiliate → khóa CẢ HAI checkbox lẫn nút lưu (server
  // sẽ reject anyway; UI không được tạo kỳ vọng sửa được).
  const st = metricEditorState({ status, affiliateEnabled, metricAffiliate, metricType })

  // Mig 103: campaign Số khách — hiển thị read-only, không render checkbox
  // (server action cũng từ chối mọi chỉnh metric cho loại này).
  if (metricType === 'affiliate_customer_count') {
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium">Số khách Affiliate</p>
        <p className="text-xs text-muted-foreground">
          Đếm khách duy nhất có đơn Affiliate giao thành công trong kỳ — loại chiến dịch cố định sau khi tạo, không đổi được chỉ số.
        </p>
      </div>
    )
  }
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
        {row(offline, setOffline, !st.editable || pending, 'GMV Offline', '— doanh số bán tại cửa hàng (BI)')}
        {st.showAffiliateControl &&
          row(affiliate, setAffiliate, !st.editable || pending, 'GMV Affiliate', '— doanh số Circa Online ghi nhận theo mã đối tác của cửa hàng')}
      </div>
      {st.metricsLocked ? (
        <p className="text-xs text-muted-foreground">KPI_AFFILIATE_ENABLED đang tắt — chỉ số của chiến dịch affiliate ở chế độ chỉ đọc.</p>
      ) : !st.editable ? (
        <p className="text-xs text-muted-foreground">Chỉ sửa được khi chiến dịch ở trạng thái nháp/tạm dừng.</p>
      ) : null}
      {st.editable && changed && (
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? 'Đang lưu…' : 'Lưu chỉ số'}
        </Button>
      )}
    </div>
  )
}
