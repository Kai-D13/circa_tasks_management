import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { requireSite } from '@/lib/site/context'
import { CYCLE_COUNT_DEPT_ID } from '@/lib/inventory/constants'
import { Card, CardContent } from '@/components/ui/card'
import { Boxes, ClipboardCheck, ChevronRight } from 'lucide-react'

// Inventory hub. A real hub (not a redirect) so future submodules slot in as
// cards. Today: one submodule, TRF. Access: super admin, Cycle Count admin, or a
// staff/store_manager with a store (they see their store's TRF inside).
export default async function InventoryPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  await requireSite('os') // FS site users never see OS surfaces

  const role = profile?.role
  const deptId = (profile as { department_id?: string | null } | null)?.department_id ?? null
  const isSuper = role === 'admin' && isSuperAdminEmail(user.email)
  const isCycleCount = role === 'admin' && deptId === CYCLE_COUNT_DEPT_ID
  const isOwnStoreViewer = (role === 'staff' || role === 'store_manager') && !!profile?.store_id
  if (!isSuper && !isCycleCount && !isOwnStoreViewer) redirect('/tasks')

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Boxes className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Tồn kho</h1>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/inventory/trf">
          <Card className="hover:bg-muted/30 active:bg-muted/40 transition-colors">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <ClipboardCheck className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">TRF</p>
                <p className="text-xs text-muted-foreground">Kiểm kho theo mã TRF</p>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  )
}
