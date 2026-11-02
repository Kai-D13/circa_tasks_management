'use client'

import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

// CMS P1-d — "Sao chép" nội dung tư vấn (UI §4.2 mục 7): chỉ clipboard của trình duyệt, không gọi máy chủ.
export function CmsCopyButton({ text }: { text: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Đã sao chép')
    } catch {
      toast.error('Không sao chép được — chọn và sao chép thủ công')
    }
  }
  return (
    <Button type="button" variant="outline" onClick={copy} data-cms-copy className="h-[44px] md:h-[32px] gap-1.5 text-[13px]">
      <Copy className="h-4 w-4" /> Sao chép
    </Button>
  )
}
