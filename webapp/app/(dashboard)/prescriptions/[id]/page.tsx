import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CareForm } from '@/components/prescriptions/CareForm'
import { ChronicSettingsForm } from '@/components/prescriptions/ChronicSettingsForm'
import { OrderCodeFixForm } from '@/components/prescriptions/OrderCodeFixForm'
import { deriveCareState, deriveOrderStatus } from '@/lib/prescriptions/careStatus'
import { CalendarClock } from 'lucide-react'
import { formatDate, formatDateTime, formatVnLocalDateTimeString } from '@/lib/dateUtils'
import Link from 'next/link'
import { PRESCRIPTION_BUCKET } from '@/lib/prescriptions/constants'
import { publicStorageUrl } from '@/lib/storage/publicUrl'
import { isSuperAdminEmail } from '@/lib/authz'
import { cn } from '@/lib/utils'

export default async function PrescriptionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user.id).single()

  // Fetch submission + related data in parallel
  const [
    { data: sub },
    { data: images },
    { data: products },
    { data: careLogs },
  ] = await Promise.all([
    supabase
      .from('prescription_submissions')
      .select('*, stores(name, code), submitter:users!submitted_by(full_name), syncer:users!synced_by(full_name)')
      .eq('id', id)
      .single(),
    supabase
      .from('prescription_images')
      .select('id, storage_path, name, type, size')
      .eq('submission_id', id)
      .order('created_at', { ascending: true }),
    supabase
      .from('prescription_submission_products')
      .select('*')
      .eq('submission_id', id)
      .order('created_at', { ascending: true }),
    supabase
      .from('prescription_care_logs')
      .select('id, care_note, evidence_images, cared_at, carer:users!care_by(full_name)')
      .eq('submission_id', id)
      .order('cared_at', { ascending: false }),
  ])

  if (!sub) notFound()

  const isSuper  = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const orderStatus = deriveOrderStatus(sub.order_sync_status)
  // Legacy product-sync data (paste-JSON → prescription_submission_products) is
  // deprecated but kept read-only when it exists (old compliance rows).
  const hasLegacyProducts = (products ?? []).length > 0

  // Chronic care (mig 073) — derived display state + who may log the care visit
  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  const careState = deriveCareState(sub, vnTodayISO)
  // Order info (customer/POS/products from the Sheet sync) is shown for ANY toa
  // that has synced data — chronic or not. Previously it was wrongly nested inside
  // the is_chronic block, so a plain synced toa showed none of its order data.
  const hasOrderInfo = !!(
    sub.customer_name || sub.customer_phone || sub.order_created_at ||
    sub.pos_code || sub.pos_name || sub.order_products_raw || sub.order_sync_error
  )
  // Care gate mirrors submitPrescriptionCare (locked 2026-07-04): staff care for
  // their OWN submission, store manager for any in their store. (RLS already
  // hides other staff's submissions, so a staff only ever reaches their own.)
  const canCare = sub.is_chronic && sub.care_status === 'none' && (
    (profile?.role === 'store_manager' && profile?.store_id === sub.store_id) ||
    (profile?.role === 'staff' && sub.submitted_by === user.id)
  )
  // DHC correction: owner staff / super may fix a wrong code while the order is
  // still pending/error and the toa hasn't been cared for (mirrors the action).
  const canFixCode = ['pending', 'error'].includes(sub.order_sync_status) && sub.care_status !== 'done' && (
    isSuper || (profile?.role === 'staff' && sub.submitted_by === user.id)
  )
  const careImageUrl = (p: string) => (p.startsWith('http') ? p : publicStorageUrl(PRESCRIPTION_BUCKET, p))

  // Generate image URLs server-side — always from the PUBLIC origin (the
  // server client may be talking to Kong over the internal docker network).
  const imageUrls = (images ?? []).map((img) => ({
    ...img,
    // GCS-stored rows keep a full URL in storage_path → use as-is (dual-read);
    // legacy Supabase rows store a key → build the public URL.
    url: img.storage_path?.startsWith('http')
      ? img.storage_path
      : publicStorageUrl(PRESCRIPTION_BUCKET, img.storage_path),
  }))

  return (
    <div className="p-6 max-w-3xl space-y-6 pb-24">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold font-mono tracking-wide">{sub.order_code}</h1>
          {/* Primary status = order-sync from the Sheet (mig 073). */}
          <span className={cn('text-xs px-2.5 py-1 rounded-full font-medium', orderStatus.cls)}>{orderStatus.label}</span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Nộp bởi{' '}
          <span className="font-medium text-foreground">
            {(sub.submitter as unknown as { full_name: string } | null)?.full_name ?? '—'}
          </span>
          {' · '}{formatDateTime(sub.submitted_at)}
        </p>
        <p className="text-sm text-muted-foreground">
          Cửa hàng: <span className="font-medium text-foreground">
            {(sub.stores as unknown as { name: string } | null)?.name ?? '—'}
          </span>
        </p>
      </div>

      {/* DHC correction when the order failed to sync (or is still pending) */}
      {canFixCode && (
        <OrderCodeFixForm
          submissionId={sub.id}
          currentCode={sub.order_code}
          isError={sub.order_sync_status === 'error'}
        />
      )}

      {/* Prescription images */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Ảnh toa thuốc ({imageUrls.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {imageUrls.length === 0 ? (
            <p className="text-sm text-muted-foreground">Không có ảnh</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {imageUrls.map((img) => (
                <a key={img.id} href={img.url} target="_blank" rel="noreferrer" className="block group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.url}
                    alt={img.name}
                    className="w-full h-44 object-cover rounded border group-hover:opacity-90 transition-opacity"
                  />
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Order info (Sheet sync, mig 073) — shown for ANY toa that has synced
          data, chronic or not (previously wrongly nested inside is_chronic). */}
      {hasOrderInfo && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Thông tin đơn hàng</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <p><span className="text-muted-foreground">Khách hàng: </span><span className="font-medium">{sub.customer_name ?? '—'}</span></p>
              <p><span className="text-muted-foreground">SĐT: </span><span className="font-medium">{sub.customer_phone ?? '—'}</span></p>
              <p><span className="text-muted-foreground">Ngày bán: </span><span className="font-medium">{sub.order_created_at ? formatDate(sub.order_created_at) : '—'}</span></p>
              <p><span className="text-muted-foreground">POS: </span><span className="font-medium">{sub.pos_name ?? sub.pos_code ?? '—'}</span></p>
            </div>
            {sub.order_products_raw && (
              <div className="text-sm">
                <p className="text-muted-foreground mb-0.5">Sản phẩm trong đơn:</p>
                <p className="whitespace-pre-wrap text-foreground">{sub.order_products_raw}</p>
              </div>
            )}
            {sub.order_sync_error && (
              <p className="text-xs text-destructive">{sub.order_sync_error}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Days-supply tracking (mig 073) — only when the toa has a days_supply
          (is_chronic = "có ngày dùng"). Care badge + refill/reminder dates. */}
      {sub.is_chronic && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between gap-2 flex-wrap">
              <span className="flex items-center gap-1.5">
                <CalendarClock className="h-4 w-4 text-primary" /> Theo dõi ngày dùng
              </span>
              {careState && (
                <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', careState.cls)}>
                  {careState.label}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <p><span className="text-muted-foreground">Số ngày dùng: </span><span className="font-medium">{sub.days_supply ?? '—'}</span></p>
              <p><span className="text-muted-foreground">Dự kiến hết thuốc: </span><span className="font-medium text-primary">{sub.expected_refill_date ? formatDate(sub.expected_refill_date) : '—'}</span></p>
              <p><span className="text-muted-foreground">Ngày cần nhắc: </span><span className="font-medium">{sub.reminder_date ? formatDate(sub.reminder_date) : '—'}</span></p>
            </div>
            {isSuper && (
              <ChronicSettingsForm
                submissionId={sub.id}
                isChronic={!!sub.is_chronic}
                daysSupply={sub.days_supply ?? null}
              />
            )}
          </CardContent>
        </Card>
      )}
      {/* Super admin can add days-supply tracking to a toa that has none. */}
      {!sub.is_chronic && isSuper && (
        <ChronicSettingsForm submissionId={sub.id} isChronic={false} daysSupply={null} />
      )}

      {/* Care history */}
      {(careLogs ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Lịch sử chăm sóc</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(careLogs ?? []).map((log) => {
              const evidences = (log.evidence_images as { path: string; name?: string }[] | null) ?? []
              return (
                <div key={log.id} className="rounded-lg border p-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {(log.carer as unknown as { full_name: string } | null)?.full_name ?? '—'}
                    </span>
                    {' · '}{formatDateTime(log.cared_at)}
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{log.care_note}</p>
                  {evidences.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto">
                      {evidences.map((img, i) => (
                        <a key={i} href={careImageUrl(img.path)} target="_blank" rel="noreferrer" className="shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={careImageUrl(img.path)} alt={img.name ?? 'Ảnh chăm sóc'} className="h-24 w-24 object-cover rounded border" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Care form gating (review r-ui2): careState is care-only now (waiting/
          error are the order-sync badge, handled in the chronic card above).
          due → prominent form; upcoming → early-care disclosure. */}
      {canCare && careState?.key === 'due' && (
        <CareForm submissionId={sub.id} storeId={sub.store_id} />
      )}
      {canCare && careState?.key === 'upcoming' && (
        <details className="group">
          <summary className="cursor-pointer select-none inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
            Ghi nhận chăm sóc sớm
            {sub.reminder_date ? ` (chưa tới kỳ · nhắc ${formatDate(sub.reminder_date)})` : ''}
          </summary>
          <div className="mt-3">
            <CareForm submissionId={sub.id} storeId={sub.store_id} />
          </div>
        </details>
      )}

      {/* Notes */}
      {sub.notes && (
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground mb-1">Ghi chú</p>
            <p className="text-sm whitespace-pre-wrap">{sub.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Legacy product data (read-only) — only for old rows that were
          product-synced before the Sheet workflow. New prescriptions carry the
          product list as text in the chronic card's "Sản phẩm (POS)". */}
      {hasLegacyProducts && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Sản phẩm trong đơn hàng ({products?.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[700px]">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Tên sản phẩm</th>
                    <th className="px-3 py-2 text-left font-medium">SKU</th>
                    <th className="px-3 py-2 text-left font-medium">Số lô / HSD</th>
                    <th className="px-3 py-2 text-left font-medium">Nhân viên bán</th>
                    <th className="px-3 py-2 text-left font-medium">Giờ bán</th>
                    <th className="px-3 py-2 text-left font-medium">POS</th>
                  </tr>
                </thead>
                <tbody>
                  {(products ?? []).map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{p.product_name ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">{p.sku_code}</td>
                      <td className="px-3 py-2 font-mono">{p.lot_date}</td>
                      <td className="px-3 py-2 text-muted-foreground">{p.employee_name ?? '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                        {formatVnLocalDateTimeString(p.completed_at_vn)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{p.pos_name ?? p.pos_code ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="pt-2">
        <Link href="/prescriptions" className="text-sm text-muted-foreground hover:underline">
          ← Quay lại danh sách
        </Link>
      </div>
    </div>
  )
}
