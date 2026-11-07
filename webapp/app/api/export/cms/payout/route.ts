import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCmsLockEnabled } from '@/lib/cms/flags'
import { canManageCms, canViewCmsAdmin } from '@/lib/cms/access'
import { cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { cmsLoadPayout } from '@/lib/cms/server/payouts'
import { handleCmsPayoutExport } from '@/lib/cms/exportPayouts'

// GET /api/export/cms/payout?program=[&run=] — XLSX chi trả của chương trình ĐÃ CHỐT (lib/cms/exportPayouts). Super + SM, phạm vi
// do rpc_cms_payout (SESSION — không service role). Cờ program + earnings + lock.
export async function GET(request: Request) {
  return handleCmsPayoutExport(request, {
    async session() {
      const { user, profile } = await getSessionProfile()
      return user ? { userId: user.id, role: (profile?.role as string | undefined) ?? null, email: user.email ?? null } : null
    },
    lockEnabled: isCmsLockEnabled,
    access: (role, email) => ({ view: canViewCmsAdmin(role, email), manage: canManageCms(role, email) }),
    async program(id, manage) {
      const r = await cmsLoadProgramDetail(id, { manage })
      if (!r.ok) return { ok: false }
      if (!r.data) return { ok: true, data: null }
      const p = r.data.program
      return { ok: true, data: { id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate, status: p.status, isTest: p.isTest } }
    },
    payout: (programId) => cmsLoadPayout(programId),
    now: () => new Date(),
  })
}
