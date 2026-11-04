'use client'

import { useLayoutEffect, useRef, useState } from 'react'

// CMS-UI-1 (PM 04/11 §4.1) — tiêu đề chương trình tối đa 2 dòng; chỉ khi chữ bị cắt mới có nút "Xem đầy đủ" (đo sau khi
// hiển thị — server render luôn ở dạng 2 dòng, không nháy bố cục). Không tooltip (mobile đọc được bằng chạm / bàn phím).
export function CmsClampTitle({ text }: { text: string }) {
  const ref = useRef<HTMLHeadingElement>(null)
  const [cut, setCut] = useState(false)
  const [full, setFull] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || full) return
    const check = () => setCut(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [full])
  return (
    <div className="min-w-0">
      <h1 ref={ref} data-cms-title className={`text-[20px] md:text-[22px] font-bold leading-tight break-words ${full ? '' : 'line-clamp-2'}`}>{text}</h1>
      {(cut || full) && (
        <button type="button" aria-expanded={full} onClick={() => setFull((v) => !v)}
          className="mt-0.5 inline-flex min-h-[44px] md:min-h-[28px] items-center text-[13px] font-medium text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          {full ? 'Thu gọn tên' : 'Xem đầy đủ tên'}
        </button>
      )}
    </div>
  )
}
