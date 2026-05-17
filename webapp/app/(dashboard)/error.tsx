'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center space-y-4">
        <p className="text-muted-foreground text-sm">Đã xảy ra lỗi khi tải trang</p>
        <Button onClick={reset} variant="outline" size="sm">Thử lại</Button>
      </div>
    </div>
  )
}
