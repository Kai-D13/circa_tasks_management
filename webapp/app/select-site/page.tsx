import { redirect } from 'next/navigation'
import { getSiteContext, siteHome } from '@/lib/site/context'
import { SiteChooser } from '@/components/site/SiteChooser'

// Site chooser — shown only to dual-access accounts (super admin / Policy admin,
// or SQL-granted). Single-site users are sent straight to their site. Lives
// OUTSIDE the (dashboard) group so it has no dashboard shell / no site-guard loop.
export default async function SelectSitePage() {
  const { allowed, role } = await getSiteContext()
  if (allowed.size === 0) redirect('/login')
  if (allowed.size === 1) redirect(siteHome([...allowed][0], role))

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-muted/20 p-6">
      <div className="mb-6 flex items-center gap-2">
        <div className="h-9 w-9 rounded-full bg-primary flex items-center justify-center">
          <span className="text-sm font-bold text-primary-foreground">C</span>
        </div>
        <span className="text-lg font-semibold">Circa</span>
      </div>
      <div className="mb-6 text-center">
        <h1 className="text-xl font-semibold">Chọn khu vực làm việc</h1>
        <p className="text-sm text-muted-foreground mt-1">Tài khoản của bạn truy cập được nhiều site — chọn site để tiếp tục.</p>
      </div>
      <div className="w-full max-w-lg">
        <SiteChooser sites={[...allowed]} />
      </div>
    </div>
  )
}
