import Image from 'next/image'
import { cmsSafeImageUrl } from '@/lib/cms/image'
import { cn } from '@/lib/utils'

// CMS — ảnh sản phẩm (SPEC §8.2, U10): Next Image + remotePatterns đúng host / prefix `cdn-gcs.thuocsi.vn/thuocsi-live/
// images/**`. URL khác host / prefix (hoặc thiếu) ⇒ ô chữ cái đầu tên SP — KHÔNG dùng thẻ ảnh thô để né allowlist.
export function CmsProductImage({ url, name, size, className }: {
  url: string | null | undefined
  name: string
  size: number
  className?: string
}) {
  const safe = cmsSafeImageUrl(url)
  const box = cn('relative shrink-0 overflow-hidden rounded-[8px] bg-muted', className)
  if (!safe) {
    const initial = (name.trim()[0] ?? '?').toUpperCase()
    return (
      <span
        data-cms-image="fallback"
        aria-hidden="true"
        className={cn(box, 'inline-flex items-center justify-center font-semibold text-muted-foreground')}
        style={{ width: size, height: size, fontSize: Math.max(12, Math.round(size * 0.4)) }}
      >
        {initial}
      </span>
    )
  }
  return (
    <span data-cms-image="cdn" className={box} style={{ width: size, height: size }}>
      <Image src={safe} alt={name} fill sizes={`${size}px`} className="object-cover" />
    </span>
  )
}
