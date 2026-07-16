import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

// Standardized error banner (replaces the ad-hoc red AlertTriangle banners).
// NO retryAction this phase (contract r2): retry = reload for server
// components; a client retry button would force 'use client' into ds/.
// Keep business hints in `hint` (e.g. "migration 073 chưa chạy?").
export function ErrorState({
  message, hint, className,
}: {
  message: string
  hint?: string
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm',
        className,
      )}
    >
      <p className="font-medium text-destructive flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="min-w-0">{message}</span>
      </p>
      {hint && <p className="text-muted-foreground mt-1 pl-6">{hint}</p>}
    </div>
  )
}
