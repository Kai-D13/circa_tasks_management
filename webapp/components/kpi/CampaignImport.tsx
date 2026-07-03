'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { previewCampaignImport, commitCampaignImport } from '@/app/actions/kpiCampaigns'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Download } from 'lucide-react'

// Column guide (business language) + a downloadable sample so ops fills the file
// without asking dev. Keep in sync with the parser (lib/kpi/campaignImport.ts).
const COLUMN_GUIDE: { col: string; meaning: string; example: string; optional?: boolean }[] = [
  { col: 'pos_code', meaning: 'Mã cửa hàng', example: 'POS0059' },
  { col: 'kpi_target', meaning: 'KPI doanh số của Store trong kỳ chiến dịch', example: '450000000' },
  { col: 'store_kpi_group', meaning: 'Phân loại Store theo KPI (nhãn hiển thị)', example: 'Nhỏ hơn 500 triệu' },
  { col: 'tier_1_threshold_pct', meaning: 'Mốc đạt KPI bậc 1 (%)', example: '90' },
  { col: 'tier_1_commission_amount', meaning: 'Commission Store bậc 1 (số tiền)', example: '15000000' },
  { col: 'tier_2_threshold_pct', meaning: 'Mốc đạt KPI bậc 2 (%)', example: '100' },
  { col: 'tier_2_commission_amount', meaning: 'Commission Store bậc 2 (số tiền)', example: '20800000' },
  { col: 'tier_3_threshold_pct', meaning: 'Mốc đạt KPI bậc 3 (%)', example: '105' },
  { col: 'tier_3_commission_amount', meaning: 'Commission Store bậc 3 (số tiền)', example: '26300000' },
  { col: 'pos_name', meaning: 'Tên cửa hàng', example: 'CIRCA TAM VIET', optional: true },
  { col: 'note', meaning: 'Ghi chú', example: 'Demo', optional: true },
]

const SAMPLE_CSV = [
  'pos_code,kpi_target,store_kpi_group,tier_1_threshold_pct,tier_1_commission_amount,tier_2_threshold_pct,tier_2_commission_amount,tier_3_threshold_pct,tier_3_commission_amount,pos_name,note',
  'POS0059,450000000,Nhỏ hơn 500 triệu,90,15000000,100,20800000,105,26300000,CIRCA TAM VIET,Demo',
  'POS0009,250000000,Nhỏ hơn 300 triệu,90,10600000,100,14700000,105,18500000,CIRCA CENTRAL,Demo',
].join('\n')

function downloadTemplate() {
  // BOM so Excel opens the UTF-8 CSV correctly.
  const blob = new Blob(['﻿' + SAMPLE_CSV], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'mau-chien-dich-kpi.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

interface Preview {
  validCount: number
  invalid: { row: number; pos_code: string | null; error: string }[]
  unmatched: string[]
  preview: { pos_code: string; kpi_target: number; store_kpi_group: string; tiers: { threshold_pct: number; commission_amount: number }[] }[]
}

const vnd = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n))

// Reusable XLSX import (upload → preview → confirm). Used by the create wizard
// and the campaign detail re-import. Holds the File client-side so both the
// preview and the confirm re-send it (commit re-parses server-side).
export function CampaignImport({ campaignId, redirectTo }: { campaignId: string; redirectTo?: string }) {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pending, startTransition] = useTransition()

  function doPreview() {
    if (!file) { toast.error('Chưa chọn file'); return }
    const fd = new FormData(); fd.append('file', file)
    startTransition(async () => {
      const r = await previewCampaignImport(fd)
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
      toast.success(
        `Đã nạp ${(r as { upserted?: number }).upserted ?? ''} cửa hàng — kết quả cũ đã được xoá, bấm "Đồng bộ doanh số từ BI" ở tab Kết quả để cập nhật`,
        { duration: 8000 },
      )
      if (redirectTo) router.push(redirectTo)
      else { setFile(null); setPreview(null); router.refresh() }
    })
  }

  const blocked = !preview || preview.invalid.length > 0 || preview.validCount === 0

  return (
    <div className="space-y-3">
      {/* Column guide (collapsible) + sample download — business language */}
      <details open className="rounded-md border bg-muted/20 text-xs">
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
                {COLUMN_GUIDE.map((r) => (
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
          <p className="text-muted-foreground">Lưu ý: <code>kpi_target</code> không được trùng đúng ranh giới nhóm (200/300/500/800 triệu, 1 tỷ).</p>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          aria-label="Chọn file Excel target chiến dịch"
          accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null) }}
          className="text-sm"
        />
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
                    <th className="text-right px-3 py-2">KPI target</th>
                    <th className="text-left px-3 py-2">Bậc (mốc % → Commission)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {preview.preview.map((r) => (
                    <tr key={r.pos_code}>
                      <td className="px-3 py-1.5 font-medium">{r.pos_code}</td>
                      <td className="px-3 py-1.5">{r.store_kpi_group}</td>
                      <td className="px-3 py-1.5 text-right">{vnd(r.kpi_target)}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {r.tiers.map((t) => (
                            <span key={t.threshold_pct} className="inline-flex whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[11px]">
                              {t.threshold_pct}% → {vnd(t.commission_amount)}
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
