'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { previewCampaignImport, commitCampaignImport } from '@/app/actions/kpiCampaigns'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Preview {
  validCount: number
  invalid: { row: number; pos_code: string | null; error: string }[]
  unmatched: string[]
  preview: { pos_code: string; final_target: number; tiers: { threshold_pct: number; commission_pct: number }[] }[]
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
      <p className="text-xs text-muted-foreground">
        Cột yêu cầu: <code>pos_code</code>, <code>final_target</code>, và các cặp bậc{' '}
        <code>tier_1_threshold_pct</code> / <code>tier_1_commission_pct</code>, <code>tier_2_…</code> (linh hoạt). Tuỳ chọn: <code>pos_name</code>, <code>note</code>.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null) }}
          className="text-sm"
        />
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
                    <th className="text-left px-3 py-2">Bậc (threshold% → commission%)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {preview.preview.map((r) => (
                    <tr key={r.pos_code}>
                      <td className="px-3 py-1.5 font-medium">{r.pos_code}</td>
                      <td className="px-3 py-1.5 text-right">{vnd(r.final_target)}</td>
                      <td className="px-3 py-1.5">{r.tiers.map((t) => `${t.threshold_pct}%→${t.commission_pct}%`).join('  ·  ')}</td>
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
