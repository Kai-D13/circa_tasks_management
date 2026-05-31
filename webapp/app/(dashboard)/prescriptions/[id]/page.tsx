import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PrescriptionSyncForm } from '@/components/prescriptions/PrescriptionSyncForm'
import { CheckCircle2, Clock } from 'lucide-react'
import { formatDateTime, formatVnLocalDateTimeString } from '@/lib/dateUtils'
import Link from 'next/link'
import { PRESCRIPTION_BUCKET } from '@/lib/prescriptions/constants'

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
  ])

  if (!sub) notFound()

  const isAdmin  = profile?.role === 'admin'
  const isSynced = sub.status === 'synced'

  // Generate image URLs server-side (public URL for task-uploads bucket)
  const imageUrls = (images ?? []).map((img) => ({
    ...img,
    url: supabase.storage.from(PRESCRIPTION_BUCKET).getPublicUrl(img.storage_path).data.publicUrl,
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
