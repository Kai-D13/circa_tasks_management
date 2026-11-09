'use client'

import { useMemo, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { cmsVnd } from '@/lib/cms/display'
import { cmsWhatIf } from '@/lib/cms/resultView'
import { CMS_UNIT_RULE_NOTE, type CmsUiTier } from '@/lib/cms/resultUi'
import type { CmsQuantityBasis } from '@/lib/cms/unitBasis'

// CMS P2-c (I3) · D2 "Nếu bán thêm" (UI §4.2 mục 6; U13 / U19). Ước tính CHỈ ở client, không lưu, không gọi máy chủ.
// Dùng CÙNG hàm bậc engine (cmsWhatIf ⇒ cmsProgressiveAmount) trên lượng cơ sở của snapshot. Gate chưa đạt ⇒ số là
// "khi đạt target" (không ước tính GMV theo giá: snapshot không có đơn vị của giá tham khảo). QLCH không render khối này.
// CMS-UNIT (spec PM 09/11 §4): run cms_unit ⇒ lượng hiện tại = Q của snapshot (đúng ĐV), +N là N đơn vị ĐÚNG ĐV tính CMS; bán thêm
// đơn vị khác không tăng số lượng tính CMS (ghi rõ dưới khối).
const MAX_EXTRA = 9999

export function CmsWhatIf({ baseQuantity, perUnit, tiers, unit, gateMet, defaultExtra, quantityBasis = 'pos_base', cmsQuantity }: {
  baseQuantity: string
  perUnit: string
  /** Cơ sở của run (dòng kết quả); cms_unit cần `cmsQuantity` (Q snapshot). */
  quantityBasis?: CmsQuantityBasis
  cmsQuantity?: string
  tiers: CmsUiTier[]
  unit: string
  gateMet: boolean
  defaultExtra: number
}) {
  const [n, setN] = useState(Math.min(MAX_EXTRA, Math.max(1, defaultExtra)))
  const r = useMemo(() => {
    try {
      return cmsWhatIf({ baseQuantity, perUnit, tiers, extraUnits: n, quantityBasis, cmsQuantity })
    } catch {
      return null
    }
  }, [baseQuantity, perUnit, tiers, n, quantityBasis, cmsQuantity])
  const unitLabel = quantityBasis === 'cms_unit' ? `${unit} đúng ĐV` : unit
  if (!r) return null
  return (
    <section data-cms-what-if className="space-y-3 rounded-v2-panel border bg-card p-4">
      <h2 className="text-[14px] font-semibold">Nếu bán thêm</h2>
      <div className="flex items-center justify-center gap-4">
        <button type="button" aria-label={`Bớt 1 ${unit}`} disabled={n <= 1} onClick={() => setN((x) => Math.max(1, x - 1))}
          className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-v2-control border bg-card disabled:opacity-40">
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>
        <output aria-live="polite" data-cms-what-if-n className="min-w-[96px] text-center text-[18px] font-bold tabular-nums">{n} {unitLabel}</output>
        <button type="button" aria-label={`Thêm 1 ${unit}`} disabled={n >= MAX_EXTRA} onClick={() => setN((x) => Math.min(MAX_EXTRA, x + 1))}
          className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-v2-control border bg-card disabled:opacity-40">
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-muted-foreground">{gateMet ? 'CMS ước tính' : 'CMS ước tính khi đạt target'}</span>
        <span className="text-right">
          <b data-cms-what-if-after className="text-[16px] tabular-nums">{cmsVnd(r.amountAfterVnd)}</b>
          <span data-cms-what-if-delta className="ml-1.5 tabular-nums text-status-success">+{cmsVnd(r.deltaVnd)}</span>
        </span>
      </div>
      <p className="text-[12px] text-muted-foreground">Ước tính theo thang bậc hiện tại, chưa phải số ghi nhận.{gateMet ? '' : ' CMS chỉ được tính khi GMV đạt target.'}</p>
      {quantityBasis === 'cms_unit' && <p data-cms-what-if-unit className="text-[12px] text-muted-foreground">{CMS_UNIT_RULE_NOTE} — bán thêm theo đơn vị khác không tăng số {unit} tính CMS.</p>}
    </section>
  )
}
