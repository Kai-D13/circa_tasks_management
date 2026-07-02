import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { Card, CardContent } from '@/components/ui/card'
import { CampaignStatusButton } from '@/components/kpi/CampaignStatusButton'
import { CampaignImport } from '@/components/kpi/CampaignImport'
import { STATUS_META } from '@/lib/kpi/status'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { ChevronLeft } from 'lucide-react'

const vnd = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n))

interface TierRow { tier_order: number; threshold_pct: number; commission_amount: number }
interface TargetRow {
  id: string; pos_code: string | null; final_target: number
  stores: { name: string } | null
  kpi_campaign_store_tiers: TierRow[]
}

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email) && isKpiCampaignEnabled())) notFound()

  const supabase = await createClient()
  const { data: c } = await supabase
    .from('kpi_campaigns').select('id, name, start_date, end_date, status, is_test, updated_at').eq('id', id).single()
  if (!c) notFound()

  const [{ data: targetsRaw }, { data: runs }] = await Promise.all([
    supabase
      .from('kpi_campaign_store_targets')
      .select('id, pos_code, final_target, stores(name), kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
      .eq('campaign_id', id)
      .order('pos_code'),
    supabase
      .from('kpi_campaign_import_runs')
      .select('file_name, row_count, success_count, created_at')
      .eq('campaign_id', id).order('created_at', { ascending: false }).limit(5),
  ])
  const targets = (targetsRaw ?? []) as unknown as TargetRow[]
  const s = STATUS_META[c.status] ?? STATUS_META.draft
  const canImport = c.status === 'draft' || c.status === 'paused'

  return (
    <div className="p-4 md:p-6 max-w-4xl space-y-4">
      <div>
        <Link href="/targets/campaigns" className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1">
          <ChevronLeft className="h-3.5 w-3.5" /> Chiến dịch KPI
        </Link>
        <div className="flex items-center justify-between gap-3 flex-wrap mt-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold">{c.name}</h1>
            <span className={cn('text-xs px-2 py-0.5 rounded font-medium', s.cls)}>{s.label}</span>
            {c.is_test && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">TEST</span>}
          </div>
          <CampaignStatusButton id={c.id} status={c.status} />
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          {formatDate(c.start_date)} – {formatDate(c.end_date)} · {targets.length} cửa hàng · Cập nhật {formatDate(c.updated_at)}
        </p>
      </div>

      {canImport && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium mb-2">Nạp / cập nhật target (thay toàn bộ)</p>
            <CampaignImport campaignId={c.id} />
          </CardContent>
        </Card>
      )}

      {targets.length > 0 ? (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2.5">Cửa hàng</th>
                  <th className="text-right px-4 py-2.5">Target</th>
                  <th className="text-left px-4 py-2.5">Bậc (mốc % → tiền thưởng)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {targets.map((t) => (
                  <tr key={t.id} className="hover:bg-muted/30">
                    <td className="px-4 py-2.5 font-medium">{t.stores?.name ?? '—'}{t.pos_code ? ` · ${t.pos_code}` : ''}</td>
                    <td className="px-4 py-2.5 text-right">{vnd(t.final_target)}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {[...t.kpi_campaign_store_tiers].sort((a, b) => a.tier_order - b.tier_order)
                        .map((tier) => `${tier.threshold_pct}% → ${vnd(tier.commission_amount)}`).join('  ·  ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Chưa có target. Nạp file để thêm.</CardContent></Card>
      )}

      {(runs ?? []).length > 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium mb-2">Lịch sử nạp file</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              {(runs ?? []).map((r, i) => (
                <li key={i}>{formatDateTime(r.created_at as string)} · {r.file_name ?? '—'} · {r.success_count}/{r.row_count} dòng</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
