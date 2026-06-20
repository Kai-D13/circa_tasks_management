import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Gift } from 'lucide-react'

export interface ReferralItem {
  referred_phone: string | null
  status:         string | null
  referral_date:  string | null
  same_day_order: boolean
}

// Staff-facing referral campaign card, shown under "Doanh số". Data comes from
// staff_referrals (uploaded by super admin). Voucher = số thành công.
export function ReferralCard({ total, success, sameDay, noOrder, items }: {
  total: number; success: number; sameDay: number; noOrder: number; items: ReferralItem[]
}) {
  const tiles = [
    { label: 'Giới thiệu được',      value: total,   tint: 'text-foreground' },
    { label: 'Thành công',           value: success, tint: 'text-green-700' },
    { label: 'Voucher đã nhận',      value: success, tint: 'text-primary' },
    { label: 'Đơn cùng ngày',        value: sameDay, tint: 'text-green-700' },
    { label: 'Không phát sinh đơn',  value: noOrder, tint: 'text-amber-600' },
  ]
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <p className="flex items-center gap-1.5 font-semibold text-sm uppercase tracking-wide">
          <Gift className="h-4 w-4 text-primary" /> Giới thiệu bạn bè
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-lg border p-2 text-center">
              <p className={cn('text-xl font-bold leading-tight', t.tint)}>{t.value}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{t.label}</p>
            </div>
          ))}
        </div>

        {items.length > 0 ? (
          <div className="divide-y rounded-lg border max-h-72 overflow-y-auto">
            {items.map((it, i) => (
              <div key={i} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="font-mono text-xs">{it.referred_phone}</span>
                <span className="text-xs text-muted-foreground shrink-0">{it.referral_date ?? ''}</span>
                <span className={cn(
                  'text-[11px] px-2 py-0.5 rounded shrink-0',
                  it.same_day_order ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700',
                )}>
                  {it.same_day_order ? 'Có đơn cùng ngày' : 'Chưa có đơn'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Bạn chưa giới thiệu ai trong chương trình.</p>
        )}

        <p className="text-[11px] text-muted-foreground">* Thành công khi người được giới thiệu phát sinh giao dịch mua hàng.</p>
      </CardContent>
    </Card>
  )
}
