'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { createCampaign } from '@/app/actions/kpiCampaigns'
import { CampaignImport } from '@/components/kpi/CampaignImport'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Create wizard: Step 1 campaign info → creates a DRAFT campaign → Step 2 import
// targets (reusable CampaignImport) → redirect to detail. Store scope only (Staff
// shown disabled "Sắp có").
export function CampaignWizard() {
  const [step, setStep] = useState<1 | 2>(1)
  const [campaignId, setCampaignId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [pending, startTransition] = useTransition()

  function submitInfo() {
    if (!name.trim()) { toast.error('Nhập tên chiến dịch'); return }
    if (!start || !end) { toast.error('Chọn thời gian áp dụng'); return }
    if (end < start) { toast.error('Ngày kết thúc phải sau ngày bắt đầu'); return }
    startTransition(async () => {
      const r = await createCampaign({ name: name.trim(), start_date: start, end_date: end })
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
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Loại chỉ số</label>
              <div className="flex gap-2">
                <span className="text-xs px-3 py-1.5 rounded-md border border-primary bg-primary/5 text-primary font-medium">GMV (doanh số)</span>
                <span className="text-xs px-3 py-1.5 rounded-md border text-muted-foreground/60 cursor-not-allowed" title="Sắp có">Loại khác · Sắp có</span>
              </div>
            </div>
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
            <CampaignImport campaignId={campaignId} redirectTo={`/targets/campaigns/${campaignId}`} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
