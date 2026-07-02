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
  { col: 'final_target', meaning: 'Target doanh số toàn chiến dịch', example: '100000000' },
  { col: 'tier_1_threshold_pct', meaning: 'Mốc đạt target bậc 1 (%)', example: '90' },
  { col: 'tier_1_commission', meaning: 'Tiền thưởng bậc 1 (số tiền)', example: '1000000' },
  { col: 'tier_2_threshold_pct', meaning: 'Mốc đạt target bậc 2 (%)', example: '100' },
  { col: 'tier_2_commission', meaning: 'Tiền thưởng bậc 2 (số tiền)', example: '2000000' },
  { col: 'tier_3_threshold_pct', meaning: 'Mốc đạt target bậc 3 (%)', example: '105' },
  { col: 'tier_3_commission', meaning: 'Tiền thưởng bậc 3 (số tiền)', example: '3000000' },
  { col: 'pos_name', meaning: 'Tên cửa hàng', example: 'CIRCA TAM VIET', optional: true },
  { col: 'note', meaning: 'Ghi chú', example: 'Demo', optional: true },
]

const SAMPLE_CSV = [
  'pos_code,final_target,tier_1_threshold_pct,tier_1_commission,tier_2_threshold_pct,tier_2_commission,tier_3_threshold_pct,tier_3_commission,pos_name,note',
  'POS0059,100000000,90,1000000,100,2000000,105,3000000,CIRCA TAM VIET,Demo',
  'POS0009,80000000,90,1000000,100,2000000,105,3000000,CIRCA CENTRAL,Demo',
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
  preview: { pos_code: string; final_target: number; tiers: { threshold_pct: number; commission_amount: number }[] }[]
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
      toast.success(`Đã nạp ${(r as { upserted?: number }).upserted ?? ''} cửa hàng`)
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
          <p className="text-muted-foreground">Cần thêm bậc? Thêm cặp cột <code>tier_4_threshold_pct</code> / <code>tier_4_commission_pct</code>… (mốc phải tăng dần).</p>
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
                    <th className="text-right px-3 py-2">Target</th>
                    <th className="text-left px-3 py-2">Bậc (mốc % → tiền thưởng)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {preview.preview.map((r) => (
                    <tr key={r.pos_code}>
                      <td className="px-3 py-1.5 font-medium">{r.pos_code}</td>
                      <td className="px-3 py-1.5 text-right">{vnd(r.final_target)}</td>
                      <td className="px-3 py-1.5">{r.tiers.map((t) => `${t.threshold_pct}% → ${vnd(t.commission_amount)}`).join('  ·  ')}</td>
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
