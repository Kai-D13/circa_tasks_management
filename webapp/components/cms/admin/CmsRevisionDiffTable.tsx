'use client'

import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cmsDecimal } from '@/lib/cms/display'
import type { CmsRevisionDiff, CmsRevisionDiffItem } from '@/lib/cms/revision/model'
import {
  CMS_REVISION_ACTION_LABEL, CMS_REVISION_ACTION_TONE, cmsRevisionSameK, cmsRevisionSameTiers, cmsRevisionTiersText,
} from '@/lib/cms/revision/view'

// F-A (spec §2.4) — diff theo ProductID giữa danh mục hiệu lực và file: thêm / thêm lại / đổi / giữ / bỏ, K cũ → mới, thang thưởng
// cũ → mới. Dữ liệu là diff DB trả ở preview (không tự tính lại ở client). SP giữ nguyên ẩn sau nút (không mất khỏi tổng).
const ORDER: Record<CmsRevisionDiffItem['action'], number> = { remove: 0, change: 1, readd: 2, add: 3, keep: 4 }

function Change({ before, after, same }: { before: string; after: string; same: boolean }) {
  if (same) return <span className="text-muted-foreground">{after}</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-muted-foreground line-through decoration-1">{before}</span>
      <ArrowRight aria-label="thành" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="font-semibold">{after}</span>
    </span>
  )
}

export function CmsRevisionDiffTable({ diff }: { diff: CmsRevisionDiff }) {
  const [showKeep, setShowKeep] = useState(false)
  const items = [...diff.items].sort((a, b) => ORDER[a.action] - ORDER[b.action] || (a.productId < b.productId ? -1 : 1))
  const visible = showKeep ? items : items.filter((x) => x.action !== 'keep')
  const chips: [CmsRevisionDiffItem['action'], number][] = [['add', diff.add], ['readd', diff.readd], ['change', diff.change], ['remove', diff.remove], ['keep', diff.keep]]
  return (
    <section data-cms-revision-diff aria-labelledby="cms-rev-diff-title" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="cms-rev-diff-title" className="text-[14px] font-semibold">Thay đổi danh mục theo ProductID</h3>
        <p className="text-[13px] text-muted-foreground tabular-nums">Sau sửa: <b className="text-foreground">{diff.productsAfter}</b> sản phẩm được tính</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chips.filter(([, n]) => n > 0).map(([a, n]) => (
          <StatusBadge key={a} tone={CMS_REVISION_ACTION_TONE[a]}>{CMS_REVISION_ACTION_LABEL[a]} {n}</StatusBadge>
        ))}
      </div>
      <DataTableShell>
        <Table className="min-w-[720px] text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Sản phẩm</TableHead>
              <TableHead>Thay đổi</TableHead>
              <TableHead>K (đơn vị cơ sở / đơn vị CMS)</TableHead>
              <TableHead className="pr-4">Mức CMS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((x) => (
              <TableRow key={x.productId} data-cms-rev-item={x.action} className="align-top">
                <TableCell className="pl-4 max-w-[260px]">
                  <div className="font-mono text-[12px] text-muted-foreground">{x.productId}</div>
                  <div className="line-clamp-2 break-words whitespace-normal">{x.name ?? '—'}</div>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <StatusBadge tone={CMS_REVISION_ACTION_TONE[x.action]}>{CMS_REVISION_ACTION_LABEL[x.action]}</StatusBadge>
                  {x.action === 'remove' && (
                    <p className="mt-1 text-[12px] text-muted-foreground">{x.referenced ? 'Đã có số liệu — ẩn khỏi danh mục, giữ lịch sử' : 'Chưa có số liệu — gỡ khỏi danh mục'}</p>
                  )}
                  {x.action === 'readd' && <p className="mt-1 text-[12px] text-muted-foreground">SP đã bỏ trước đây — bật lại cùng bản ghi</p>}
                  {x.adviceChanged && <p className="mt-1 text-[12px] text-muted-foreground">Nội dung tư vấn đổi</p>}
                </TableCell>
                <TableCell className="tabular-nums whitespace-normal">
                  {x.action === 'add' ? <span className="font-semibold">{cmsDecimal(x.kAfter)}</span>
                    : x.action === 'remove' ? <span className="text-muted-foreground">{cmsDecimal(x.kBefore)}</span>
                    : <Change before={cmsDecimal(x.kBefore)} after={cmsDecimal(x.kAfter)} same={cmsRevisionSameK(x.kBefore, x.kAfter)} />}
                  {x.unitCms && <span className="text-muted-foreground"> · {x.unitCms}</span>}
                </TableCell>
                <TableCell className="pr-4 whitespace-normal tabular-nums">
                  {x.action === 'add' ? <span className="font-semibold">{cmsRevisionTiersText(x.tiersAfter, x.unitCms)}</span>
                    : x.action === 'remove' ? <span className="text-muted-foreground">{cmsRevisionTiersText(x.tiersBefore, x.unitCms)}</span>
                    : <Change before={cmsRevisionTiersText(x.tiersBefore, x.unitCms)} after={cmsRevisionTiersText(x.tiersAfter, x.unitCms)} same={cmsRevisionSameTiers(x.tiersBefore, x.tiersAfter)} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
      {diff.keep > 0 && (
        <Button type="button" variant="ghost" onClick={() => setShowKeep((v) => !v)} aria-expanded={showKeep} className="h-[44px] md:h-[36px] text-[13px]">
          {showKeep ? `Ẩn ${diff.keep} sản phẩm giữ nguyên` : `Hiện ${diff.keep} sản phẩm giữ nguyên`}
        </Button>
      )}
    </section>
  )
}
