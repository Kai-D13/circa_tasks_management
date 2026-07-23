import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isReferralEnabled } from '@/lib/affiliate/flags'
import { isSuperAdminEmail } from '@/lib/authz'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ReferralUploadForm } from '@/components/referral/ReferralUploadForm'
import { formatDateTime } from '@/lib/dateUtils'
import { Gift } from 'lucide-react'

// Campaign "Giới thiệu bạn bè" — super-admin uploads the BigQuery export; this
// page shows the aggregate per staff. Staff see their own card under /targets.

interface ReferralRow {
  phone_number: string
  full_name: string | null
  store_code: string | null
  store_name: string | null
  status: string | null
  referred_phone: string | null
  same_day_order: boolean
  uploaded_at: string
}

interface Agg {
  phone: string; full_name: string | null; store_code: string | null; store_name: string | null
  total: number; success: number; sameDay: number; noOrder: number
}

export default async function GioiThieuPage() {
  // Chương trình referral đã ngưng — flag off chặn cả truy cập URL trực tiếp
  // (entry cuối cùng còn hở sau khi action upload + cron đã gate).
  if (!isReferralEnabled()) redirect('/targets')
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) redirect('/targets')

  const { data, error } = await supabase
    .from('staff_referrals')
    .select('phone_number, full_name, store_code, store_name, status, referred_phone, same_day_order, uploaded_at')
  const rows = (data ?? []) as ReferralRow[]

  const byPhone = new Map<string, Agg>()
  for (const r of rows) {
    const a = byPhone.get(r.phone_number) ?? {
      phone: r.phone_number, full_name: r.full_name, store_code: r.store_code, store_name: r.store_name,
      total: 0, success: 0, sameDay: 0, noOrder: 0,
    }
    if (r.referred_phone) {
      a.total++
      if ((r.status ?? '').toUpperCase() === 'SUCCESS') a.success++
      if (r.same_day_order) a.sameDay++; else a.noOrder++
    }
    byPhone.set(r.phone_number, a)
  }
  const staff = [...byPhone.values()].sort(
    (a, b) => b.total - a.total || (a.store_code ?? '').localeCompare(b.store_code ?? ''),
  )
  const uploadedAt = rows[0]?.uploaded_at
  const totalRef = staff.reduce((s, x) => s + x.total, 0)
  const totalSuccess = staff.reduce((s, x) => s + x.success, 0)

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl">
      <div className="flex items-center gap-2">
        <Gift className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Giới thiệu bạn bè</h1>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Nạp dữ liệu (tự động từ Google Sheet · upload JSON dự phòng)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">
            Dữ liệu được đồng bộ tự động từ Google Sheet theo lịch. Có thể nạp tay bằng file JSON khi cần.
          </p>
          <ReferralUploadForm />
          {error && <p className="text-sm text-destructive mt-2">Lỗi đọc dữ liệu: {error.message} — đã chạy migration 059 chưa?</p>}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        {staff.length > 0
          ? `${staff.length} nhân viên · ${totalRef} giới thiệu · ${totalSuccess} thành công · cập nhật ${formatDateTime(uploadedAt ?? '')}`
          : 'Chưa có dữ liệu — nạp file export từ BigQuery ở trên.'}
      </p>

      {staff.length > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2.5 font-medium">Cửa hàng</th>
                  <th className="text-left px-4 py-2.5 font-medium">Nhân viên</th>
                  <th className="text-left px-4 py-2.5 font-medium">SĐT</th>
                  <th className="text-right px-4 py-2.5 font-medium">Giới thiệu</th>
                  <th className="text-right px-4 py-2.5 font-medium">Thành công</th>
                  <th className="text-right px-4 py-2.5 font-medium">Voucher</th>
                  <th className="text-right px-4 py-2.5 font-medium">Đơn cùng ngày</th>
                  <th className="text-right px-4 py-2.5 font-medium">Không phát sinh đơn</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {staff.map((s) => (
                  <tr key={s.phone} className="hover:bg-muted/30">
                    <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{s.store_name ?? s.store_code ?? '—'}</td>
                    <td className="px-4 py-2.5 font-medium">{s.full_name ?? '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{s.phone}</td>
                    <td className="px-4 py-2.5 text-right">{s.total}</td>
                    <td className="px-4 py-2.5 text-right font-semibold text-green-700">{s.success}</td>
                    <td className="px-4 py-2.5 text-right">{s.success}</td>
                    <td className="px-4 py-2.5 text-right text-green-700">{s.sameDay}</td>
                    <td className="px-4 py-2.5 text-right text-amber-600">{s.noOrder}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
