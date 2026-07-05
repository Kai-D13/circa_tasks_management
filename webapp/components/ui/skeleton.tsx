import { cn } from '@/lib/utils'

// Loading placeholder block. Compose into route loading.tsx shells so
// navigation feels instant on the staff mobile hot paths.
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  )
}

export { Skeleton }
