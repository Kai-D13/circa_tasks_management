import { cmsLoadStaffCatalog } from '@/lib/cms/server/staffCatalog'
import { cmsLoadResults } from '@/lib/cms/server/resultLoad'
import { cmsTodayVn } from '@/lib/cms/programStatus'
import { cmsParseCardFilter, type CmsResultsLoad } from '@/lib/cms/resultUi'
import { CmsStaffCatalogView } from '@/components/cms/staff/CmsStaffCatalogView'

// CMS P1-d — nhánh `/targets?tab=cms` (server component): targets/page.tsx gọi SAU cổng auth / FS / vai trò và TRƯỚC mọi
// query KPI (SPEC §8.1). Đọc qua RLS 120 (session). Không có nhà thuốc ⇒ trạng thái riêng, không truy vấn.
// `kpiTab` = tab KPI có tới được không (QLCH + cờ KPI campaign OFF ⇒ không) — quyết định segmented.
// P2-c (I3): số liệu qua RPC 122 (session; staff = mình, QLCH = staff hiện thuộc nhà thuốc) CHỈ khi cờ
// CMS_EARNINGS_ENABLED bật và chương trình đã bắt đầu — cờ OFF ⇒ không gọi RPC, giao diện P1 nguyên trạng.
export async function CmsStaffCatalogPage({ storeId, programId, manager, kpiTab, filter }: {
  storeId: string | null; programId: string | null; manager: boolean; kpiTab: boolean; filter?: string | null
}) {
  const today = cmsTodayVn(new Date())
  const base = { today, manager, kpiTab }
  if (!storeId) return <CmsStaffCatalogView kind="no-store" programs={[]} selected={null} products={[]} {...base} />
  const res = await cmsLoadStaffCatalog({ today, programId })
  if (!res.ok) return <CmsStaffCatalogView kind="error" programs={[]} selected={null} products={[]} {...base} />
  const { programs, selected, products } = res.data
  const results: CmsResultsLoad = selected ? await cmsLoadResults(selected.id, { started: selected.startDate <= today }) : { kind: 'off' }
  return (
    <CmsStaffCatalogView
      kind={selected ? 'ok' : 'empty'}
      programs={programs}
      selected={selected}
      products={products}
      results={results}
      filter={cmsParseCardFilter(filter)}
      {...base}
    />
  )
}
