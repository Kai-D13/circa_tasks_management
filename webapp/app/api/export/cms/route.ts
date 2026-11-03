import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { cmsFlagsFromEnv } from '@/lib/cms/flags'
import { canManageCms, canViewCmsAdmin } from '@/lib/cms/access'
import { cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { cmsLoadStoreNames } from '@/lib/cms/server/resultLoad'
import { cmsLoadAllResultLines, cmsLoadResultExcluded, cmsLoadResultHeader, cmsLoadResultRows } from '@/lib/cms/server/results'
import { CMS_Q206_RETURNS_CONTRACT } from '@/lib/cms/releaseGate'
import { handleCmsResultExport, parseCmsExcludedPage } from '@/lib/cms/exportResults'

// GET /api/export/cms?program=&run= — XLSX kết quả CMS của đúng run trên màn A3 (lib/cms/exportResults: ghim run, đủ dòng,
// đối chiếu tổng, Q-206). Super + SM (phạm vi do RPC 122, SESSION client — không service role). Cờ program + earnings.
export async function GET(request: Request) {
  return handleCmsResultExport(request, {
    async session() {
      const { user, profile } = await getSessionProfile()
      return user ? { userId: user.id, role: (profile?.role as string | undefined) ?? null, email: user.email ?? null } : null
    },
    flags: () => { const f = cmsFlagsFromEnv(process.env); return { program: f.program, earnings: f.earnings } },
    access: (role, email) => ({ view: canViewCmsAdmin(role, email), manage: canManageCms(role, email) }),
    async program(id, manage) {
      const r = await cmsLoadProgramDetail(id, { manage })
      if (!r.ok) return { ok: false }
      if (!r.data) return { ok: true, data: null }
      const p = r.data.program
      return {
        ok: true,
        data: {
          program: { id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate, configVersion: p.configVersion, status: p.status },
          products: r.data.products.map((x) => ({ id: x.id, productId: x.productId, nameSnapshot: x.nameSnapshot, unitCms: x.unitCms, baseQuantityCms: x.baseQuantityCms, gmvBasis: x.gmvBasis })),
        },
      }
    },
    header: (programId) => cmsLoadResultHeader(programId),
    rows: (programId, runId) => cmsLoadResultRows(programId, runId),
    lines: (programId, runId, maxRows) => cmsLoadAllResultLines({ programId, runId, maxRows }),
    async excluded(programId, runId, afterSeq) {
      const r = await cmsLoadResultExcluded({ programId, runId, afterSeq, limit: 500 })
      if (!r.ok) return r
      try {
        return { ok: true, data: parseCmsExcludedPage(r.data) }
      } catch {
        console.error('[cms-export] excluded DTO_INVALID')
        return { ok: false, error: 'QUERY_FAILED' }
      }
    },
    storeNames: (ids) => cmsLoadStoreNames(ids),
    now: () => new Date(),
    returnsApproved: CMS_Q206_RETURNS_CONTRACT === 'APPROVED',
  })
}
