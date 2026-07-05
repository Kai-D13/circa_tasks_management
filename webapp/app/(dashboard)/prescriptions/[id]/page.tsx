import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PrescriptionSyncForm } from '@/components/prescriptions/PrescriptionSyncForm'
import { CareForm } from '@/components/prescriptions/CareForm'
import { ChronicSettingsForm } from '@/components/prescriptions/ChronicSettingsForm'
import { deriveCareState } from '@/lib/prescriptions/careStatus'
import { CheckCircle2, Clock, HeartPulse } from 'lucide-react'
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

  const isAdmin  = profile?.role === 'admin'
  const isSuper  = isAdmin && isSuperAdminEmail(user.email)
  const isSynced = sub.status === 'synced'

  // Chronic care (mig 073) — derived display state + who may log the care visit
  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  const careState = deriveCareState(sub, vnTodayISO)
  // Care gate mirrors submitPrescriptionCare (locked 2026-07-04): staff care for
  // their OWN submission, store manager for any in their store. (RLS already
  // hides other staff's submissions, so a staff only ever reaches their own.)
  const canCare = sub.is_chronic && sub.care_status === 'none' && (
    (profile?.role === 'store_manager' && profile?.store_id === sub.store_id) ||
    (profile?.role === 'staff' && sub.submitted_by === user.id)
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
          {isSynced ? (
            <Badge className="bg-green-100 text-green-700 gap-1">
              <CheckCircle2 className="h-3 w-3" /> Đã đồng bộ
            </Badge>
          ) : (
            <Badge className="bg-amber-100 text-amber-700 gap-1">
              <Clock className="h-3 w-3" /> Chờ đồng bộ
            </Badge>
          )}
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
        {isSynced && (
          <p className="text-xs text-muted-foreground mt-1">
            Đồng bộ bởi {(sub.syncer as unknown as { full_name: string } | null)?.full_name ?? '—'}
            {' · '}{sub.synced_at ? formatDateTime(sub.synced_at) : '—'}
          </p>
        )}
      </div>

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

      {/* Chronic care info (mig 073) */}
      {sub.is_chronic && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between gap-2 flex-wrap">
              <span className="flex items-center gap-1.5">
                <HeartPulse className="h-4 w-4 text-primary" /> Toa mạn tính
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
              <p><span className="text-muted-foreground">Khách hàng: </span><span className="font-medium">{sub.customer_name ?? '—'}</span></p>
              <p><span className="text-muted-foreground">SĐT: </span><span className="font-medium">{sub.customer_phone ?? '—'}</span></p>
              <p><span className="text-muted-foreground">Ngày bán: </span><span className="font-medium">{sub.order_created_at ? formatDate(sub.order_created_at) : '—'}</span></p>
              <p><span className="text-muted-foreground">Số ngày dùng: </span><span className="font-medium">{sub.days_supply ?? '—'}</span></p>
              <p><span className="text-muted-foreground">Dự kiến hết thuốc: </span><span className="font-medium text-primary">{sub.expected_refill_date ? formatDate(sub.expected_refill_date) : '—'}</span></p>
              <p><span className="text-muted-foreground">Ngày cần nhắc: </span><span className="font-medium">{sub.reminder_date ? formatDate(sub.reminder_date) : '—'}</span></p>
            </div>
            {sub.order_sync_error && (
              <p className="text-xs text-destructive">{sub.order_sync_error}</p>
            )}
            {sub.order_products_raw && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Sản phẩm (POS): </span>{sub.order_products_raw}
              </p>
            )}
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
      {/* Super admin can also mark a non-chronic prescription chronic (fix a missed tick) */}
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

      {/* Care form gating (review r-ui2):
          due       → prominent form (act now)
          upcoming  → secondary disclosure (early care possible, not pushed)
          waiting   → no form yet (no order data → can't schedule/care)
          error     → no form (DHC must be fixed on POS first)
          canCare already means chronic + not yet cared + permitted. */}
      {canCare && careState && (
        careState.key === 'due' ? (
          <CareForm submissionId={sub.id} storeId={sub.store_id} />
        ) : careState.key === 'upcoming' ? (
          <details className="group">
            <summary className="cursor-pointer select-none inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
              Ghi nhận chăm sóc sớm
              {sub.reminder_date ? ` (chưa tới kỳ · nhắc ${formatDate(sub.reminder_date)})` : ''}
            </summary>
            <div className="mt-3">
              <CareForm submissionId={sub.id} storeId={sub.store_id} />
            </div>
          </details>
        ) : (
          <Card>
            <CardContent className="py-3 text-sm text-muted-foreground">
              {careState.key === 'error'
                ? 'Chưa thể chăm sóc: mã DHC chưa khớp dữ liệu đơn POS. Kiểm tra lại mã trên POS, hệ thống sẽ tự cập nhật ở lần đồng bộ kế tiếp.'
                : 'Chưa thể chăm sóc: đang chờ dữ liệu đơn từ POS để lên lịch nhắc khách.'}
            </CardContent>
          </Card>
        )
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

      {/* Products (synced data — compliance view for health inspector) */}
      {isSynced && (products ?? []).length > 0 && (
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

      {/* Admin: global sync form (not per-submission — admin pastes batch JSON) */}
      {isAdmin && !isSynced && (
        <>
          <p className="text-sm text-muted-foreground">
            Để đồng bộ đơn hàng này, dán JSON chứa mã{' '}
            <code className="font-mono text-xs bg-muted px-1 rounded">{sub.order_code}</code>{' '}
            vào form bên dưới. Nếu muốn đồng bộ hàng loạt, dùng trang{' '}
            <Link href="/prescriptions" className="underline">danh sách</Link>.
          </p>
          <PrescriptionSyncForm />
        </>
      )}

      <div className="pt-2">
        <Link href="/prescriptions" className="text-sm text-muted-foreground hover:underline">
          ← Quay lại danh sách
        </Link>
      </div>
    </div>
  )
}
