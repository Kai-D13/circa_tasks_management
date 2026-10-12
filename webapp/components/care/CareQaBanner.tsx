'use client'

import { usePathname } from 'next/navigation'
import { FlaskConical } from 'lucide-react'
import { careMyScreen } from '@/lib/care/my'
import { cn } from '@/lib/utils'
import { CareQaNoticeText } from './CareQaNotice'

// Dải báo CHẾ ĐỘ QA của CareLayout (B6-qa-ui; gọn 1 dòng + <details> từ B7-ui). B7-ui r2: trên mobile,
// 3 màn dược sĩ CSKH đã có chip "QA" trong header riêng (mở cùng nội dung) ⇒ dải này ẩn ở đó để
// nhường chỗ màn hình; desktop và các màn /care khác giữ nguyên.
export function CareQaBanner() {
  const pathname = usePathname()
  return (
    <details data-testid="care-qa-banner"
      className={cn('group mx-4 mt-3 rounded-lg border border-status-warning/40 bg-status-warning-bg px-3 text-sm md:mx-6',
        careMyScreen(pathname) && 'max-md:hidden')}>
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <FlaskConical className="size-4 shrink-0 text-status-warning" aria-hidden />
        <strong className="text-status-warning">Chế độ QA</strong>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">dữ liệu giả (is_test)</span>
        <span className="shrink-0 text-xs font-medium text-status-warning underline underline-offset-2 group-open:hidden">Chi tiết</span>
        <span className="hidden shrink-0 text-xs font-medium text-status-warning underline underline-offset-2 group-open:inline">Thu gọn</span>
      </summary>
      <p className="pb-3"><CareQaNoticeText /></p>
    </details>
  )
}
