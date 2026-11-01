import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

// CMS P1-c — khung trang A2 / sửa / import (gốc v2, cột giữa max-w-4xl mx-auto theo luật width). Dùng chung route + fixture.
export function CmsWizardShell({ title, subtitle, backHref, backLabel, kind, children }: {
  title: string
  subtitle?: string
  backHref: string
  backLabel: string
  kind: 'new' | 'edit' | 'import'
  children: React.ReactNode
}) {
  return (
    <div data-ui-v2="page" data-layout-width="centered" data-cms-wizard={kind} className="mx-auto max-w-4xl p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <Link href={backHref} className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {backLabel}
      </Link>
      <div className="space-y-1">
        <h1 className="text-[20px] md:text-[22px] font-bold leading-tight break-words">{title}</h1>
        {subtitle && <p className="text-[13px] text-muted-foreground break-words">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}
