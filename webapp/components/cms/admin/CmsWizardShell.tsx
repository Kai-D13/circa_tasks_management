import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

// CMS P1-c — khung trang A2 / sửa / import / revision. Dùng chung route + fixture.
// CMS-IMPORT-UI-1 (PM 22/11 §3.1): gốc FLUID — dùng hết vùng <main> sau sidebar (không cap / không căn giữa); lề 16px mobile, 24px từ md;
// khoảng cách nhóm 16 / 24px — giá trị PIXEL (root 15px ⇒ p-4 / p-6 không phải 16 / 24px). `@container/cms-wizard`: các bước bên trong
// chia hai cột theo CHIỀU RỘNG NỘI DUNG (≥ 960px), không theo viewport ⇒ sidebar mở / thu đều đúng, không JS resize.
export function CmsWizardShell({ title, subtitle, backHref, backLabel, kind, children }: {
  title: string
  subtitle?: string
  backHref: string
  backLabel: string
  kind: 'new' | 'edit' | 'import' | 'revision'
  children: React.ReactNode
}) {
  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-cms-wizard={kind} className="w-full min-w-0 p-[16px] md:p-[24px] space-y-[16px] md:space-y-[24px]">
      <div className="min-w-0">
        <Link href={backHref} className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> {backLabel}
        </Link>
        <div className="space-y-1">
          <h1 className="text-[20px] md:text-[22px] font-bold leading-tight break-words">{title}</h1>
          {subtitle && <p className="text-[13px] text-muted-foreground break-words">{subtitle}</p>}
        </div>
      </div>
      <div data-cms-wizard-body className="@container/cms-wizard min-w-0 space-y-[16px] md:space-y-[24px]">
        {children}
      </div>
    </div>
  )
}
