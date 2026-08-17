'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { createCampaign } from '@/app/actions/kpiCampaigns'
import { CampaignImport } from '@/components/kpi/CampaignImport'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { REVENUE_LABELS } from '@/lib/kpi/campaignDisplay'

// Create wizard: Step 1 campaign info → creates a DRAFT campaign → Step 2 import
// targets (reusable CampaignImport) → redirect to detail. Store scope only (Staff
// shown disabled "Sắp có").
// P3-D: chỉ số = 2 checkbox thật. GMV Affiliate CHỈ render khi affiliateEnabled
// (KPI_AFFILIATE_ENABLED — prop server, không NEXT_PUBLIC); server action vẫn
// là người gác cuối khi flag tắt.
// Mig 103: segmented "Loại chiến dịch" (Doanh số | Số khách Affiliate) CHỈ
// render khi customerEnabled (KPI_AFFILIATE_CUSTOMER_ENABLED — prop server);
// flag tắt → UI y hệt cũ. Chọn Số khách → ẩn 2 checkbox (contract cột cố
// định server-side), gửi metric_type cho createCampaign.
export function CampaignWizard({ affiliateEnabled = false, customerEnabled = false, orderAovEnabled = false }: {
  affiliateEnabled?: boolean
  customerEnabled?: boolean
  // Mig 106: KPI_ORDER_AOV_CAMPAIGN_ENABLED (prop server — KHÔNG NEXT_PUBLIC).
  orderAovEnabled?: boolean
}) {
  const [step, setStep] = useState<1 | 2>(1)
  const [campaignId, setCampaignId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [metricOffline, setMetricOffline] = useState(true)
  const [metricAffiliate, setMetricAffiliate] = useState(false)
  const [campaignType, setCampaignType] =
    useState<'gmv' | 'affiliate_customer_count' | 'offline_order_aov'>('gmv')
  const isCustomer = customerEnabled && campaignType === 'affiliate_customer_count'
  const isOrderAov = orderAovEnabled && campaignType === 'offline_order_aov'
  // Chỉ hiện segmented khi có ÍT NHẤT 1 loại ngoài GMV được bật.
  const showTypePicker = customerEnabled || orderAovEnabled
  const typeOptions: [string, string][] = [
    ['gmv', 'Doanh số'],
    ...(customerEnabled ? [['affiliate_customer_count', 'Số khách Affiliate'] as [string, string]] : []),
    ...(orderAovEnabled ? [['offline_order_aov', 'Chất lượng bán hàng'] as [string, string]] : []),
  ]
  const [pending, startTransition] = useTransition()

  function submitInfo() {
    if (!name.trim()) { toast.error('Nhập tên chiến dịch'); return }
    if (!start || !end) { toast.error('Chọn thời gian áp dụng'); return }
    if (end < start) { toast.error('Ngày kết thúc phải sau ngày bắt đầu'); return }
    if (!isCustomer && !isOrderAov && !metricOffline && !metricAffiliate) { toast.error('Chọn ít nhất một chỉ số doanh số'); return }
    startTransition(async () => {
      const r = await createCampaign(isCustomer
        ? { name: name.trim(), start_date: start, end_date: end, metric_type: 'affiliate_customer_count' }
        : isOrderAov
        // Chỉ số do LOẠI quy định (offline=true/affiliate=false) — server ép lại.
        ? { name: name.trim(), start_date: start, end_date: end, metric_type: 'offline_order_aov' }
        : {
            name: name.trim(), start_date: start, end_date: end,
            metric_offline: metricOffline,
            metric_affiliate: affiliateEnabled ? metricAffiliate : false,
          })
      if ('error' in r && r.error) { toast.error(r.error); return }
      setCampaignId((r as { id: string }).id)
      setStep(2)
      toast.success('Đã tạo nháp — nạp file target')
    })
  }

  return (
    <div className="space-y-4">
      {/* Step indicator */}
      <div className="flex items-center gap-2 text-xs">
        {[['1', 'Thông tin'], ['2', 'Nạp target']].map(([n, label]) => (
          <span key={n} className={cn(
            'px-2.5 py-1 rounded-full font-medium',
            step >= Number(n) ? 'bg-primary text-white' : 'bg-muted text-muted-foreground',
          )}>{n}. {label}</span>
        ))}
      </div>

      {step === 1 && (
        <Card>
          <CardContent className="p-4 space-y-3 max-w-md">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Tên chiến dịch</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full h-9 px-3 rounded-md border bg-background text-sm" placeholder="VD: Chạy doanh số tháng 7" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Từ ngày</label>
                <input type="date" aria-label="Từ ngày" value={start} onChange={(e) => setStart(e.target.value)} className="w-full h-9 px-3 rounded-md border bg-background text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Đến ngày</label>
                <input type="date" aria-label="Đến ngày" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full h-9 px-3 rounded-md border bg-background text-sm" />
              </div>
            </div>
            {showTypePicker && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Loại chiến dịch</label>
                <div className="flex flex-wrap gap-2">
                  {typeOptions.map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setCampaignType(v as typeof campaignType)}
                      className={cn(
                        'text-xs px-3 rounded-md border font-medium min-h-[44px] md:min-h-0 md:py-1.5',
                        campaignType === v
                          ? 'border-primary bg-primary/5 text-primary'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {isCustomer && (
                  <p className="text-xs text-muted-foreground">
                    Đếm khách duy nhất có đơn Affiliate giao thành công trong kỳ — mỗi khách tính 1 lần, target nhập theo SỐ KHÁCH.
                  </p>
                )}
                {isOrderAov && (
                  <p className="text-xs text-muted-foreground">
                    Đánh giá đồng thời SỐ ĐƠN và AOV, mỗi chỉ số có mục tiêu riêng. Đạt KPI khi CẢ HAI cùng chạm mục tiêu — không có tỷ trọng, không có sàn.
                  </p>
                )}
              </div>
            )}
            {!isCustomer && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Chỉ số doanh số</label>
              <div className="flex flex-col gap-1.5">
                <label className="inline-flex items-center gap-2 text-sm min-h-[44px] md:min-h-0 md:py-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={metricOffline}
                    onChange={(e) => setMetricOffline(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="font-medium">{REVENUE_LABELS.offline}</span>
                  <span className="text-xs text-muted-foreground">— doanh số bán tại cửa hàng (BI)</span>
                </label>
                {affiliateEnabled && (
                  <label className="inline-flex items-center gap-2 text-sm min-h-[44px] md:min-h-0 md:py-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={metricAffiliate}
                      onChange={(e) => setMetricAffiliate(e.target.checked)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="font-medium">{REVENUE_LABELS.affiliate}</span>
                    <span className="text-xs text-muted-foreground">— doanh số Circa Online ghi nhận theo mã đối tác của cửa hàng</span>
                  </label>
                )}
              </div>
            </div>
            )}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Áp dụng cho</label>
              <div className="flex gap-2">
                <span className="text-xs px-3 py-1.5 rounded-md border border-primary bg-primary/5 text-primary font-medium">Cửa hàng</span>
                <span className="text-xs px-3 py-1.5 rounded-md border text-muted-foreground/60 cursor-not-allowed" title="Sắp có">Từng dược sĩ · Sắp có</span>
              </div>
            </div>
            <Button size="sm" onClick={submitInfo} disabled={pending}>{pending ? 'Đang tạo…' : 'Tiếp →'}</Button>
          </CardContent>
        </Card>
      )}

      {step === 2 && campaignId && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium mb-3">Nạp file target + bậc commission</p>
            <CampaignImport campaignId={campaignId} redirectTo={`/targets/campaigns/${campaignId}`} metricType={isCustomer ? 'affiliate_customer_count' : isOrderAov ? 'offline_order_aov' : 'gmv'} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
