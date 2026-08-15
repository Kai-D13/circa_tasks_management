import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID } from '@/lib/fs/constants'
import { Card, CardContent } from '@/components/ui/card'
import { FsImportWizard } from '@/components/fs/FsImportWizard'
import { ChevronLeft, AlertTriangle } from 'lucide-react'

// Create a session from a product Excel/CSV (Policy/super). Success → the wizard
// redirects to /fs/products/[id].
export default async function FsProductNewPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isPolicy = profile?.role === 'admin' && profile?.department_id === POLICY_DEPT_ID
  if (!isSuper && !isPolicy) redirect('/tasks')

  const supabase = await createClient()
  const { data: fsStores, error: storesErr } = await supabase
    .from('stores').select('id, name, code')
    .eq('store_type', 'fs').eq('is_active', true).order('name')
  if (storesErr) console.error('[fs-products-new] stores query failed:', storesErr.message)

  return (
    <div className="p-4 space-y-4 max-w-3xl mx-auto">
      <Link href="/fs/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" /> Danh sách phiên
      </Link>
      <h1 className="text-xl font-semibold">Tạo phiên xử lý sản phẩm</h1>
      {storesErr && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Không tải được danh sách cửa hàng FS: {storesErr.message}</span>
        </div>
      )}
      <Card>
        <CardContent className="p-4">
          <FsImportWizard fsStores={fsStores ?? []} />
        </CardContent>
      </Card>
    </div>
  )
}
