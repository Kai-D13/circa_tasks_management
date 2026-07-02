import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { Card, CardContent } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { CampaignStatusButton } from '@/components/kpi/CampaignStatusButton'
import { STATUS_META } from '@/lib/kpi/status'
import { formatDate } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Plus, Megaphone } from 'lucide-react'

const drange = (s: string, e: string) => `${formatDate(s)} – ${formatDate(e)}`

export default async function CampaignsPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email) && isKpiCampaignEnabled())) notFound()

  const supabase = await createClient()
  const [{ data: campaigns }, { data: targets }] = await Promise.all([
    supabase.from('kpi_campaigns')
      .select('id, name, start_date, end_date, status, is_test, updated_at')
      .order('created_at', { ascending: false }),
    supabase.from('kpi_campaign_store_targets').select('campaign_id'),
  ])
  const countByCampaign = new Map<string, number>()
  for (const t of (targets ?? [])) countByCampaign.set(t.campaign_id as string, (countByCampaign.get(t.campaign_id as string) ?? 0) + 1)

  const list = (campaigns ?? []) as { id: string; name: string; start_date: string; end_date: string; status: string; is_test: boolean; updated_at: string }[]

  return (
    <div className="p-4 md:p-6 max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Chiến dịch KPI</h1>
        </div>
        <Link href="/targets/campaigns/new" className={cn(buttonVariants({ size: 'sm' }))}>
          <Plus className="h-4 w-4 mr-1" /> Tạo chiến dịch
        </Link>
      </div>

      {list.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Chưa có chiến dịch nào. Bấm “Tạo chiến dịch” để bắt đầu.</CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2.5">Tên</th>
                  <th className="text-left px-4 py-2.5">Khoảng ngày</th>
                  <th className="text-left px-4 py-2.5">Trạng thái</th>
                  <th className="text-right px-4 py-2.5">Cửa hàng</th>
                  <th className="text-left px-4 py-2.5">Cập nhật</th>
                  <th className="text-right px-4 py-2.5"><span className="sr-only">Thao tác</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.map((c) => {
                  const s = STATUS_META[c.status] ?? STATUS_META.draft
                  return (
                    <tr key={c.id} className="hover:bg-muted/30">
                      <td className="px-4 py-2.5 font-medium">
                        <Link href={`/targets/campaigns/${c.id}`} className="hover:text-primary hover:underline">{c.name}</Link>
                        {c.is_test && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">TEST</span>}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{drange(c.start_date, c.end_date)}</td>
                      <td className="px-4 py-2.5"><span className={cn('text-xs px-2 py-0.5 rounded font-medium', s.cls)}>{s.label}</span></td>
                      <td className="px-4 py-2.5 text-right">{countByCampaign.get(c.id) ?? 0}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">{formatDate(c.updated_at)}</td>
                      <td className="px-4 py-2.5"><div className="flex justify-end"><CampaignStatusButton id={c.id} status={c.status} /></div></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
