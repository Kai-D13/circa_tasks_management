import { cmsLoadStaffCatalog } from '@/lib/cms/server/staffCatalog'
import { cmsTodayVn } from '@/lib/cms/programStatus'
import { CmsStaffCatalogView } from '@/components/cms/staff/CmsStaffCatalogView'

// CMS P1-d — nhánh `/targets?tab=cms` (server component): targets/page.tsx gọi SAU cổng auth / FS / vai trò và TRƯỚC mọi
// query KPI (SPEC §8.1). Đọc qua RLS 120 (session). Không có nhà thuốc ⇒ trạng thái riêng, không truy vấn.
// `kpiTab` = tab KPI có tới được không (QLCH + cờ KPI campaign OFF ⇒ không) — quyết định segmented.
export async function CmsStaffCatalogPage({ storeId, programId, manager, kpiTab }: { storeId: string | null; programId: string | null; manager: boolean; kpiTab: boolean }) {
  const today = cmsTodayVn(new Date())
  const base = { today, manager, kpiTab }
  if (!storeId) return <CmsStaffCatalogView kind="no-store" programs={[]} selected={null} products={[]} {...base} />
  const res = await cmsLoadStaffCatalog({ today, programId })
  if (!res.ok) return <CmsStaffCatalogView kind="error" programs={[]} selected={null} products={[]} {...base} />
  const { programs, selected, products } = res.data
  return (
    <CmsStaffCatalogView
      kind={selected ? 'ok' : 'empty'}
      programs={programs}
      selected={selected}
      products={products}
      {...base}
    />
  )
}
