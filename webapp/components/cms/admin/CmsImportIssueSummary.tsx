'use client'

import { ListChecks } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import type { CmsImportIssueSummaryItem } from '@/lib/cms/import/issueSummary'
import { cmsImportColumnLabel } from '@/lib/cms/import/simpleColumns'

// F-C (PM spec 17/11 §5) — tóm tắt lỗi file theo (mã, cột): số ô · số dòng · số sản phẩm + tối đa 5 dòng ví dụ. Chỉ trình bày DTO server
// (issueSummary dẫn xuất từ groupsRejected); chi tiết đầy đủ vẫn ở tab "Lỗi & cảnh báo" và file dòng lỗi. Văn bản hiển thị dạng text
// (React escape) — không HTML thô, không hiện công thức / đường dẫn ngoài của ô.

const vn = (n: number) => n.toLocaleString('vi-VN')

export function CmsImportIssueSummary({ items, format, onDetail }: {
  items: CmsImportIssueSummaryItem[]
  format?: 'tiers' | 'simple'
  /** Chuyển sang tab chi tiết lỗi (không tự tick / không đổi gì khác). */
  onDetail?: () => void
}) {
  if (items.length === 0) return null
  return (
    <section data-cms-issue-summary aria-labelledby="cms-issue-summary-title" className="rounded-v2-panel border bg-card p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="cms-issue-summary-title" className="flex items-center gap-2 text-[14px] font-semibold">
          <ListChecks aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          Tóm tắt lỗi theo loại ({items.length})
        </h3>
        {onDetail && (
          <button type="button" onClick={onDetail} data-cms-issue-summary-detail
            className="inline-flex min-h-[44px] items-center rounded-v2-control px-2 text-[13px] font-medium underline-offset-2 hover:underline">
            Xem từng dòng
          </button>
        )}
      </div>
      <ul className="mt-2 divide-y">
        {items.map((it) => {
          const col = cmsImportColumnLabel(it.column, format)
          return (
            <li key={`${it.code}|${it.column ?? ''}`} data-cms-issue-code={it.code} data-cms-issue-column={it.column ?? ''} className="space-y-1 py-2.5 text-[13px]">
              <p className="flex flex-wrap items-center gap-1.5">
                <StatusBadge tone="danger">{vn(it.productCount)} sản phẩm</StatusBadge>
                {col && <span className="font-medium break-all">{col}</span>}
                <span className="min-w-0 break-words">{it.message}</span>
              </p>
              <p data-cms-issue-counts className="text-[12px] text-muted-foreground tabular-nums">
                {vn(it.cellCount)} lần gặp · {vn(it.rowCount)} dòng Excel · {vn(it.productCount)} sản phẩm
                {it.exampleRows.length > 0 && <> · ví dụ dòng {it.exampleRows.join(', ')}{it.rowCount > it.exampleRows.length ? ', …' : ''}</>}
              </p>
              <p className="text-[12px] text-muted-foreground break-words">Cách sửa: {it.fix}</p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
