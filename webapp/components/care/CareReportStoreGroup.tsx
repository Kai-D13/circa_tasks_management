'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { TableCell, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

// PM 22/10 U2: một nhóm POS của bảng /care/reports — dòng tổng POS LUÔN hiện; dòng dược sĩ thu gọn / mở NGAY TRONG BẢNG
// (không popup). Island CHỈ giữ state mở: mọi dòng / ô do server dựng sẵn (props ReactNode, careReportGroups ở server) ⇒ mở /
// đóng không gọi RPC / action, không đổi query hay export. Hai <tbody> CÙNG CẤP (dòng POS · vùng dược sĩ), hàng Tổng ở <tbody>
// riêng của trang — không lồng tbody. Không lưu URL / localStorage; đổi bộ lọc ⇒ trang đặt `key` mới ⇒ về trạng thái mặc định.
export function CareReportStoreGroup({ groupId, label, title, count, defaultOpen, storeCells, assigneeRows }: {
  /** ID ổn định (theo store) — `aria-controls` trỏ vào vùng dòng dược sĩ. */
  groupId: string
  label: React.ReactNode
  title?: string
  /** Số dòng dược sĩ của POS; 0 ⇒ không có nút mở. */
  count: number
  defaultOpen: boolean
  storeCells: React.ReactNode
  assigneeRows: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen && count > 0)
  const rowsId = `${groupId}-rows`
  return (
    <>
      <tbody data-testid="care-report-group">
        <TableRow className="bg-muted/30" data-testid="care-report-store">
          <TableCell className="font-semibold whitespace-nowrap" title={title}>
            <span className="inline-flex items-center gap-2">
              <span>{label}</span>
              {count > 0 && (
                <button type="button" aria-expanded={open} aria-controls={rowsId} onClick={() => setOpen((o) => !o)} data-testid="care-report-toggle"
                  className="inline-flex min-h-[44px] items-center gap-1 rounded px-[6px] text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-[28px]">
                  {open ? 'Ẩn dược sĩ' : `Xem ${count} dược sĩ`}
                  <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
                </button>
              )}
            </span>
          </TableCell>
          {storeCells}
        </TableRow>
      </tbody>
      {count > 0 && <tbody id={rowsId} hidden={!open} data-testid="care-report-group-rows">{assigneeRows}</tbody>}
    </>
  )
}
