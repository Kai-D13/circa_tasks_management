'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'

// 'icon' (mặc định) = nút vuông chỉ có icon — Sidebar và các thanh action dùng.
// 'row'  = một HÀNG icon + nhãn + trạng thái hiện tại, cho menu dạng danh sách
//          (account sheet trên MobileHeader). Cả hàng là vùng chạm.
export function ThemeToggle({ className, variant = 'icon' }: { className?: string; variant?: 'icon' | 'row' }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const toggle = () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')

  // Giữ chỗ đúng hình dạng của biến thể để không giật layout lúc hydrate.
  if (!mounted) return <div className={variant === 'row' ? 'min-h-[44px]' : 'w-9 h-9 shrink-0'} />

  const isDark = resolvedTheme === 'dark'

  if (variant === 'row') {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label="Đổi giao diện"
        className={className ?? 'flex items-center gap-3 w-full min-h-[44px] px-2 text-sm text-left'}
      >
        {isDark ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
        <span className="flex-1">Giao diện</span>
        <span className="text-xs text-muted-foreground">{isDark ? 'Tối' : 'Sáng'}</span>
      </button>
    )
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className ?? 'w-9 h-9 px-0'}
      onClick={toggle}
      aria-label="Đổi giao diện"
    >
      {isDark
        ? <Sun className="h-4 w-4" />
        : <Moon className="h-4 w-4" />
      }
    </Button>
  )
}
