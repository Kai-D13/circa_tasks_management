import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

// CMS P1-c — stepper A2 (UI §3.2): Thông tin → Upload → Chạy xử lý → Kết quả. Danh sách có aria-current="step".
export const CMS_STEPS = ['Thông tin', 'Upload', 'Chạy xử lý', 'Kết quả'] as const

export function CmsStepper({ current, skipFirst = false }: { current: 0 | 1 | 2 | 3; skipFirst?: boolean }) {
  return (
    <ol aria-label="Các bước tạo chương trình" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
      {CMS_STEPS.map((label, i) => {
        if (skipFirst && i === 0) return null
        const done = i < current
        const active = i === current
        return (
          <li key={label} aria-current={active ? 'step' : undefined} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex size-6 items-center justify-center rounded-full border text-[12px] font-semibold tabular-nums',
                done && 'border-v2-ok bg-v2-ok text-white',
                active && 'border-foreground bg-foreground text-background',
                !done && !active && 'border-input text-muted-foreground',
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : skipFirst ? i : i + 1}
            </span>
            <span className={cn(active ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{label}</span>
            {i < CMS_STEPS.length - 1 && <span aria-hidden="true" className="hidden sm:inline h-px w-6 bg-border" />}
          </li>
        )
      })}
    </ol>
  )
}
