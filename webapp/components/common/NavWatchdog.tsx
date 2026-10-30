'use client'

import { useEffect, useRef } from 'react'
import { useLinkStatus } from 'next/link'
import { ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NAV_WATCHDOG_MS, internalTarget, isAtTarget } from '@/lib/nav/watchdog'

/**
 * NAV-1: link đang pending (đã chạm, URL chưa đổi) quá `ms` trong lúc trang hiển thị ⇒ `location.assign(href)` đúng MỘT lần.
 * Huỷ khi: hết pending (điều hướng xong / người dùng chạm link khác — Next chỉ giữ pending cho link chạm sau cùng), URL đã tới
 * đích, unmount, tab ẩn (hiện lại thì đếm lại từ đầu). Chỉ nhận href nội bộ cùng origin. Tải cứng đi qua proxy như mọi lượt tải
 * trang: phiên hết hạn thật ⇒ /login, không tự lặp (chỉ kích hoạt từ một lần chạm).
 * CHỈ gắn cho link rời một trang KHÔNG có dữ liệu đang nhập dở (tải cứng làm mất state của trang hiện tại).
 */
export function useNavWatchdog(href: string, pending: boolean, ms: number = NAV_WATCHDOG_MS) {
  const fired = useRef(false)
  useEffect(() => {
    if (!pending) return
    const target = internalTarget(href, window.location.origin)
    if (!target) return
    let timer: number | undefined
    const arm = () => {
      window.clearTimeout(timer)
      if (document.visibilityState !== 'visible') return
      timer = window.setTimeout(() => {
        if (fired.current || document.visibilityState !== 'visible' || isAtTarget(target, window.location)) return
        fired.current = true
        window.location.assign(target.href)   // URL tuyệt đối đã kiểm cùng origin
      }, ms)
    }
    const onVisibility = () => (document.visibilityState === 'visible' ? arm() : window.clearTimeout(timer))
    arm()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [href, pending, ms])
}

/** Watchdog không hiển thị gì — đặt bên trong `<Link>` (useLinkStatus chỉ chạy trong con cháu của Link). */
export function NavWatchdog({ href, ms }: { href: string; ms?: number }) {
  const { pending } = useLinkStatus()
  useNavWatchdog(href, pending, ms)
  return null
}

/**
 * Mũi tên cuối thẻ kiêm watchdog: khi pending, mũi tên mờ đi và vòng quay hiện tại CHỖ (cùng ô 16px, chỉ đổi opacity ⇒ không
 * dịch bố cục). Đặt bên trong `<Link href={href}>`.
 */
export function NavChevron({ href, className, ms }: { href: string; className?: string; ms?: number }) {
  const { pending } = useLinkStatus()
  useNavWatchdog(href, pending, ms)
  return (
    <span aria-hidden data-nav-pending={pending ? '' : undefined} className={cn('relative h-4 w-4 shrink-0 text-muted-foreground', className)}>
      <ChevronRight className={cn('absolute inset-0 h-4 w-4 transition-opacity', pending && 'opacity-0')} />
      <Loader2 className={cn('absolute inset-0 h-4 w-4 animate-spin opacity-0 transition-opacity', pending && 'opacity-100')} />
    </span>
  )
}
