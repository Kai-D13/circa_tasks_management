'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { createCampaign } from '@/app/actions/kpiCampaigns'
import { useFixtureActionBlocked } from '@/components/kpi/KpiFixtureBoundary'
import { CampaignImport } from '@/components/kpi/CampaignImport'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { Panel } from '@/components/ds/Panel'
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
// UI v2 Phase 2 · K-3 (canvas K4): stepper 2 thẻ, form trong Panel, loại chiến dịch = thẻ chọn (aria-pressed),
// "Áp dụng cho" = segmented (Từng dược sĩ vẫn khoá "Sắp có"). Chỉ trình bày — state, validation (toast),
// createCampaign, CampaignImport và chữ giữ nguyên. Route gắn data-ui-v2 nên dùng thẳng token v2.
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
  const fixtureBlocked = useFixtureActionBlocked()

  function submitInfo() {
    if (!name.trim()) { toast.error('Nhập tên chiến dịch'); return }
    if (!start || !end) { toast.error('Chọn thời gian áp dụng'); return }
    if (end < start) { toast.error('Ngày kết thúc phải sau ngày bắt đầu'); return }
    if (!isCustomer && !isOrderAov && !metricOffline && !metricAffiliate) { toast.error('Chọn ít nhất một chỉ số doanh số'); return }
    if (fixtureBlocked()) return
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
      <CampaignWizardSteps step={step} />

      {step === 1 && (
        <Panel bodyClassName="space-y-4 md:space-y-5">
            <div className="space-y-1.5">
              <label htmlFor="campaign-name" className="text-[13px] font-semibold">Tên chiến dịch</label>
              <input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full h-[44px] md:h-[40px] px-3 rounded-v2-control border border-input bg-card text-[16px] md:text-[14px] outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/30" placeholder="VD: Chạy doanh số tháng 7" />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="campaign-start" className="text-[13px] font-semibold">Từ ngày</label>
                <input id="campaign-start" type="date" aria-label="Từ ngày" value={start} onChange={(e) => setStart(e.target.value)} className="w-full h-[44px] md:h-[40px] px-3 rounded-v2-control border border-input bg-card text-[16px] md:text-[14px] outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/30 tabular-nums" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="campaign-end" className="text-[13px] font-semibold">Đến ngày</label>
                <input id="campaign-end" type="date" aria-label="Đến ngày" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full h-[44px] md:h-[40px] px-3 rounded-v2-control border border-input bg-card text-[16px] md:text-[14px] outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/30 tabular-nums" />
              </div>
            </div>
            {showTypePicker && (
              <div className="space-y-1.5">
                <p id="campaign-type-label" className="text-[13px] font-semibold">Loại chiến dịch</p>
                <div role="group" aria-labelledby="campaign-type-label" className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {typeOptions.map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={campaignType === v}
                      data-campaign-type={v}
                      onClick={() => setCampaignType(v as typeof campaignType)}
                      className={cn(
                        'flex min-h-[48px] items-center gap-2.5 rounded-v2-control border px-3.5 text-left text-[14px] font-semibold transition-colors',
                        campaignType === v
                          ? 'border-v2-selected-line bg-accent text-foreground'
                          : 'bg-card text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <span aria-hidden="true" className={cn(
                        'inline-flex size-4 shrink-0 items-center justify-center rounded-full border-2',
                        campaignType === v ? 'border-primary' : 'border-input',
                      )}>
                        {campaignType === v && <span className="size-2 rounded-full bg-primary" />}
                      </span>
                      {label}
                    </button>
                  ))}
                </div>
                {isCustomer && (
                  <p className="text-[12px] text-muted-foreground">
                    Đếm khách duy nhất có đơn Affiliate giao thành công trong kỳ — mỗi khách tính 1 lần, target nhập theo SỐ KHÁCH.
                  </p>
                )}
                {isOrderAov && (
                  <p className="text-[12px] text-muted-foreground">
                    Đánh giá đồng thời SỐ ĐƠN và AOV, mỗi chỉ số có mục tiêu riêng. Đạt KPI khi CẢ HAI cùng chạm mục tiêu — không có tỷ trọng, không có sàn.
                  </p>
                )}
              </div>
            )}
            {!isCustomer && (
            <div className="space-y-1.5">
              <p className="text-[13px] font-semibold">Chỉ số doanh số</p>
              <div className="flex flex-col gap-1.5">
                <label className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 py-2 text-sm min-h-[44px] md:flex md:min-h-0 md:py-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={metricOffline}
                    onChange={(e) => setMetricOffline(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="font-medium">{REVENUE_LABELS.offline}</span>
                  <span className="col-start-2 text-xs text-muted-foreground">— doanh số bán tại cửa hàng (BI)</span>
                </label>
                {affiliateEnabled && (
                  <label className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 py-2 text-sm min-h-[44px] md:flex md:min-h-0 md:py-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={metricAffiliate}
                      onChange={(e) => setMetricAffiliate(e.target.checked)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="font-medium">{REVENUE_LABELS.affiliate}</span>
                    <span className="col-start-2 text-xs text-muted-foreground">— doanh số Circa Online ghi nhận theo mã đối tác của cửa hàng</span>
                  </label>
                )}
              </div>
            </div>
            )}
            <div className="space-y-1.5">
              <p className="text-[13px] font-semibold">Áp dụng cho</p>
              {/* Chỉ HIỂN THỊ phạm vi (như cũ): Cửa hàng là phạm vi duy nhất; "Từng dược sĩ" khoá, chưa có chức năng. */}
              <div data-campaign-scope className="inline-flex gap-1 rounded-v2-control bg-muted p-1">
                <span className="inline-flex min-h-[36px] items-center rounded-[8px] border border-input bg-card px-3.5 text-[13px] font-semibold text-foreground">Cửa hàng</span>
                <span aria-disabled="true" className="inline-flex min-h-[36px] cursor-not-allowed items-center rounded-[8px] px-3.5 text-[13px] text-v2-text-3" title="Sắp có">Từng dược sĩ · Sắp có</span>
              </div>
            </div>
            <div className="flex justify-end border-t pt-4">
              <Button onClick={submitInfo} disabled={pending} className="h-[44px] px-5 text-[14px] font-semibold md:h-[40px]">{pending ? 'Đang tạo…' : 'Tiếp →'}</Button>
            </div>
        </Panel>
      )}

      {step === 2 && campaignId && (
        <CampaignWizardImportStep campaignId={campaignId} metricType={isCustomer ? 'affiliate_customer_count' : isOrderAov ? 'offline_order_aov' : 'gmv'} />
      )}
    </div>
  )
}

// Khung trang /targets/campaigns/new (gốc v2, cột giữa max-w-3xl — centered như cũ): back-link + tiêu đề. Route thật và
// fixture /ui-catalog/kpi-v2/new dùng chung.
export function CampaignNewFrame({ children }: { children: React.ReactNode }) {
  return (
    <div data-ui-v2="page" data-layout-width="centered" data-campaign-new className="p-4 md:p-6 max-w-3xl mx-auto space-y-4 md:space-y-[18px]">
      <div>
        <Link href="/targets/campaigns" className="inline-flex min-h-[44px] items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground md:min-h-0">
          <ChevronLeft className="h-3.5 w-3.5" /> Chiến dịch KPI
        </Link>
        <h1 className="mt-1 text-[22px] font-bold leading-tight tracking-[-0.01em] md:text-[24px]">Tạo chiến dịch KPI</h1>
      </div>
      {children}
    </div>
  )
}

// Thanh bước — bước hiện tại nổi (accent), bước đã qua giữ màu chính, bước sau trung tính. Export để fixture dựng bước 2
// mà không phải gọi createCampaign (ghi DB).
export function CampaignWizardSteps({ step }: { step: 1 | 2 }) {
  return (
    <ol aria-label="Các bước tạo chiến dịch" className="grid grid-cols-2 gap-2.5">
      {[['1', 'Thông tin'], ['2', 'Nạp target']].map(([n, label]) => {
        const current = step === Number(n)
        const done = step > Number(n)
        return (
          <li
            key={n}
            data-step={n}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'flex min-h-[48px] items-center gap-2.5 rounded-v2-control border px-3.5 text-[14px] font-medium',
              current ? 'border-v2-selected-line bg-accent font-semibold text-foreground' : 'bg-card text-muted-foreground',
            )}
          >
            <span aria-hidden="true" className={cn(
              'inline-flex size-[26px] shrink-0 items-center justify-center rounded-full text-[13px] font-bold',
              current || done ? 'bg-primary text-primary-foreground' : 'border border-input text-muted-foreground',
            )}>{n}</span>
            {label}
          </li>
        )
      })}
    </ol>
  )
}

// Bước 2: nạp target cho chiến dịch nháp vừa tạo (CampaignImport dùng chung tab Cấu hình), xong chuyển sang chi tiết.
export function CampaignWizardImportStep({ campaignId, metricType }: { campaignId: string; metricType: string }) {
  return (
    <Panel title="Nạp file target + bậc commission">
      <CampaignImport campaignId={campaignId} redirectTo={`/targets/campaigns/${campaignId}`} metricType={metricType} />
    </Panel>
  )
}
