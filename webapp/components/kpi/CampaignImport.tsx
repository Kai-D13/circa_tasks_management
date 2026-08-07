'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { previewCampaignImport, commitCampaignImport } from '@/app/actions/kpiCampaigns'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Download, FileUp, X } from 'lucide-react'

// Mig 103 r1 (audit P1): guide/template/format theo LOẠI chiến dịch từ
// lib/kpi/campaignImportGuide (thuần, spec khóa — GMV byte-equal cũ; customer
// target SỐ KHÁCH, không rule biên tiền). metricType do page/wizard truyền
// (server-trusted); parser + RPC vẫn là boundary cuối.
import { campaignImportGuide } from '@/lib/kpi/campaignImportGuide'

interface Preview {
  validCount: number
  invalid: { row: number; pos_code: string | null; error: string }[]
  unmatched: string[]
  preview: { pos_code: string; kpi_target: number; store_kpi_group: string; tiers: { threshold_pct: number; commission_amount: number }[] }[]
}

// Commission LUÔN VNĐ (mọi loại campaign).
const vndMoney = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n))

// Reusable XLSX import (upload → preview → confirm). Used by the create wizard
// and the campaign detail re-import. Holds the File client-side so both the
// preview and the confirm re-send it (commit re-parses server-side).
export function CampaignImport({
  campaignId, redirectTo, guideDefaultOpen = true, metricType,
}: {
  campaignId: string
  redirectTo?: string
  /** Pass false when the campaign already has targets — the format guide then
      starts collapsed instead of dominating the config tab. */
  guideDefaultOpen?: boolean
  /** Mig 103: 'affiliate_customer_count' → guide/template/preview đơn vị KHÁCH. */
  metricType?: string
}) {
  const guide = campaignImportGuide(metricType)
  function downloadTemplate() {
    // BOM so Excel opens the UTF-8 CSV correctly.
    const blob = new Blob(['﻿' + guide.sampleCsv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = guide.sampleFileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [guideOpen, setGuideOpen] = useState(guideDefaultOpen)
  const [pending, startTransition] = useTransition()

  function doPreview() {
    if (!file) { toast.error('Chưa chọn file'); return }
    const fd = new FormData(); fd.append('file', file)
    startTransition(async () => {
      const r = await previewCampaignImport(campaignId, fd)
      if ('error' in r && r.error) { toast.error(r.error); setPreview(null); return }
      setPreview(r as unknown as Preview)
    })
  }

  function doCommit() {
    if (!file) return
    const fd = new FormData(); fd.append('file', file)
    startTransition(async () => {
      const r = await commitCampaignImport(campaignId, fd)
      if ('error' in r && r.error) { toast.error(r.error); return }
      // Import clears previous actuals server-side (stale vs new targets) — tell
      // the admin the next step explicitly.
      toast.success(guide.commitToast((r as { upserted?: number }).upserted ?? ''), { duration: 8000 })
      if (redirectTo) router.push(redirectTo)
      else { setFile(null); setPreview(null); router.refresh() }
    })
  }

  const blocked = !preview || preview.invalid.length > 0 || preview.validCount === 0

  return (
    <div className="space-y-3">
      {/* Column guide (collapsible) + sample download — business language */}
      <details
        open={guideOpen}
        onToggle={(e) => setGuideOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="rounded-md border bg-muted/20 text-xs"
      >
        <summary className="cursor-pointer px-3 py-2 font-medium select-none">
          Hướng dẫn định dạng file Excel
        </summary>
        <div className="px-3 pb-3 space-y-2">
          <p className="text-muted-foreground">File cần các cột sau (một dòng = một cửa hàng):</p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Cột</th>
                  <th className="py-1 pr-3 font-medium">Ý nghĩa</th>
                  <th className="py-1 font-medium">Ví dụ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {guide.columns.map((r) => (
                  <tr key={r.col}>
                    <td className="py-1 pr-3 whitespace-nowrap"><code>{r.col}</code>{r.optional && <span className="text-muted-foreground"> (tuỳ chọn)</span>}</td>
                    <td className="py-1 pr-3">{r.meaning}</td>
                    <td className="py-1 text-muted-foreground">{r.example}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground">Thêm cặp cột <code>tier_4_threshold_pct</code> / <code>tier_4_commission_amount</code>… nếu cần tăng bậc.</p>
          {guide.boundaryWarning && <p className="text-muted-foreground">{guide.boundaryWarning}</p>}
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        {/* Native file input stays for a11y but hidden — the browser's English
            "Choose File / No file chosen" broke the Vietnamese-only screen. */}
        <input
          id={`campaign-file-${campaignId}`}
          type="file"
          aria-label="Chọn file Excel target chiến dịch"
          accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          onClick={(e) => { (e.currentTarget as HTMLInputElement).value = '' }}
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null) }}
          className="sr-only"
        />
        <label
          htmlFor={`campaign-file-${campaignId}`}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'cursor-pointer gap-1.5')}
        >
          <FileUp className="h-3.5 w-3.5" /> Chọn file Excel/CSV
        </label>
        {file && (
          <span className="inline-flex items-center gap-1 rounded-full bg-secondary text-secondary-foreground text-xs font-medium pl-2.5 pr-1 py-1 max-w-[240px]">
            <span className="truncate">{file.name}</span>
            <button
              type="button"
              aria-label="Bỏ chọn file"
              onClick={() => { setFile(null); setPreview(null) }}
              className="rounded-full p-0.5 hover:bg-primary/10"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={downloadTemplate} className="gap-1.5">
          <Download className="h-3.5 w-3.5" /> Tải file mẫu CSV
        </Button>
        <Button size="sm" variant="outline" onClick={doPreview} disabled={pending || !file}>
          {pending ? 'Đang đọc…' : 'Xem trước'}
        </Button>
        <Button size="sm" onClick={doCommit} disabled={pending || blocked}>
          Xác nhận nạp
        </Button>
      </div>

      {preview && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <span className="text-xs px-2 py-0.5 rounded font-medium bg-green-100 text-green-700">Hợp lệ {preview.validCount}</span>
            {preview.invalid.length > 0 && <span className="text-xs px-2 py-0.5 rounded font-medium bg-red-100 text-red-700">Lỗi {preview.invalid.length}</span>}
            {preview.unmatched.length > 0 && <span className="text-xs px-2 py-0.5 rounded font-medium bg-amber-100 text-amber-700">POS không khớp {preview.unmatched.length}</span>}
          </div>

          {preview.invalid.length > 0 && (
            <div className="rounded border border-red-200 bg-red-50 p-2 max-h-48 overflow-y-auto">
              <p className="text-xs font-medium text-red-700 mb-1">Sửa hết các dòng lỗi rồi nạp lại (không ghi từng phần):</p>
              <ul className="text-xs text-red-700 space-y-0.5">
                {preview.invalid.slice(0, 50).map((e, i) => (
                  <li key={i}>Dòng {e.row}{e.pos_code ? ` (${e.pos_code})` : ''}: {e.error}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.preview.length > 0 && (
            <div className="rounded border overflow-x-auto max-h-72">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left px-3 py-2">POS</th>
                    <th className="text-left px-3 py-2">Phân loại</th>
                    <th className="text-right px-3 py-2">{guide.targetHeaderLabel}</th>
                    <th className="text-left px-3 py-2">Bậc (mốc % → Commission)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {preview.preview.map((r) => (
                    <tr key={r.pos_code}>
                      <td className="px-3 py-1.5 font-medium">{r.pos_code}</td>
                      <td className="px-3 py-1.5">{r.store_kpi_group}</td>
                      <td className="px-3 py-1.5 text-right">{guide.formatTarget(r.kpi_target)}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {r.tiers.map((t) => (
                            <span key={t.threshold_pct} className="inline-flex whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[11px]">
                              {t.threshold_pct}% → {vndMoney(t.commission_amount)}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.validCount > preview.preview.length && (
            <p className={cn('text-xs text-muted-foreground')}>… và {preview.validCount - preview.preview.length} dòng hợp lệ khác.</p>
          )}
        </div>
      )}
    </div>
  )
}
