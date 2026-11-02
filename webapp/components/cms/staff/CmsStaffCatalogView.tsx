import Link from 'next/link'
import { Boxes, ChevronRight, Store } from 'lucide-react'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { TagBadge } from '@/components/ds/TagBadge'
import { CmsProductImage } from '@/components/cms/CmsProductImage'
import { CmsTargetsSegment } from '@/components/cms/staff/CmsTargetsSegment'
import { CmsProgramPicker } from '@/components/cms/staff/CmsProgramPicker'
import { CMS_GATE_HUE, CMS_GATE_LABEL, cmsDate, cmsVnd } from '@/lib/cms/display'
import { cmsDaysLeft, cmsDisplayStatus } from '@/lib/cms/programStatus'
import { cmsProductHref, cmsTierSummary } from '@/lib/cms/staffView'
import type { CmsProductView, CmsProgramRowView } from '@/lib/cms/server/catalog'

// CMS P1-d · D1 `/targets?tab=cms` (UI §4.1; r2 U1 / U9 / U19; H5). Staff + QLCH xem DANH MỤC chương trình Sắp diễn ra /
// Đang chạy của nhà thuốc hiện tại: SP, loại điều kiện, target cấu hình, thang `đ/unit_CMS`. P1 KHÔNG có hero "CMS của
// bạn", tiến độ, thanh GMV, gợi ý gần đạt, bộ lọc Đã đạt / Chưa đạt, không số 0 giả. QLCH như staff (U19). Dùng chung
// route thật + fixture /ui-catalog/cms-v2/staff.

export type CmsStaffKind = 'ok' | 'empty' | 'error' | 'no-store'

export function CmsStaffCatalogView({ kind, programs, selected, products, today, manager, kpiTab }: {
  kind: CmsStaffKind
  programs: CmsProgramRowView[]
  selected: CmsProgramRowView | null
  products: CmsProductView[]
  today: string
  manager: boolean
  /** Có tab KPI để quay lại không. QLCH + cờ KPI campaign OFF ⇒ `/targets` chuyển về /tasks ⇒ false: không segmented. */
  kpiTab: boolean
}) {
  const display = selected ? cmsDisplayStatus(selected, today) : null
  const left = selected ? cmsDaysLeft(selected, today) : null
  const catalog = products.filter((p) => p.gmvBasis === 'catalog')
  return (
    <div data-ui-v2="page" data-layout-width="centered" data-cms-staff={kind} className="mx-auto max-w-2xl p-4 space-y-4 v2:space-y-3">
      <div className="space-y-3">
        <h1 className="text-[20px] font-bold leading-tight">{kpiTab ? 'Mục tiêu' : 'CMS sản phẩm'}</h1>
        {kpiTab && <CmsTargetsSegment active="cms" />}
      </div>

      {kind === 'error' ? (
        <ErrorState message="Không tải được danh mục CMS" hint="Thử tải lại trang." />
      ) : kind === 'no-store' ? (
        <EmptyState className="py-12 rounded-v2-panel border border-dashed border-input bg-card" icon={Store} title="Tài khoản chưa được gán nhà thuốc" hint="Liên hệ quản lý để được gán nhà thuốc." />
      ) : kind === 'empty' || !selected ? (
        <EmptyState className="py-12 rounded-v2-panel border border-dashed border-input bg-card" icon={Boxes} title="Hiện chưa có chương trình CMS cho nhà thuốc của bạn" />
      ) : (
        <>
          <CmsProgramPicker programs={programs} selectedId={selected.id} today={today} />
          <p data-cms-staff-note className="text-[13px] text-muted-foreground">
            {display === 'upcoming'
              ? <>Chương trình bắt đầu {cmsDate(selected.startDate)} — xem trước danh mục để chuẩn bị tư vấn.</>
              : <>{left !== null ? `Còn ${left} ngày. ` : ''}CMS tính theo số lượng từng dược sĩ bán trong kỳ.</>}
            {manager && ' Tài khoản cửa hàng chỉ xem danh mục.'}
          </p>
          {catalog.length > 0 && (
            <div data-cms-staff-catalog-target className="rounded-v2-panel border bg-card px-4 py-3 text-[13px]">
              <p className="font-semibold">Target GMV toàn danh mục: <span className="tabular-nums">{cmsVnd(selected.catalogTargetGmv)}</span></p>
              <p className="text-muted-foreground">Cộng GMV {catalog.length} sản phẩm trong nhóm danh mục.</p>
            </div>
          )}
          {products.length === 0 ? (
            <EmptyState className="py-10 rounded-v2-panel border border-dashed border-input bg-card" icon={Boxes} title="Chương trình chưa có sản phẩm" />
          ) : (
            <ul data-cms-staff-products className="space-y-2.5">
              {products.map((p) => (
                <li key={p.id}>
                  <Link href={cmsProductHref(p.id)} data-cms-staff-product={p.productId} className="flex min-h-[44px] gap-3 rounded-v2-panel border bg-card p-3">
                    <CmsProductImage url={p.imageUrlSnapshot} name={p.nameSnapshot} size={48} />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="font-semibold leading-snug line-clamp-2 break-words">{p.nameSnapshot}</span>
                      <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                        <TagBadge hue={CMS_GATE_HUE[p.gmvBasis]}>{CMS_GATE_LABEL[p.gmvBasis]}</TagBadge>
                        {p.gmvBasis === 'product' && <span className="tabular-nums">Target {cmsVnd(p.targetGmv)}</span>}
                        {p.gmvBasis === 'catalog' && <span>Theo target danh mục</span>}
                      </span>
                      <span className="block rounded-[6px] bg-muted px-2 py-1 text-[12px] leading-snug tabular-nums break-words">{cmsTierSummary(p.tiers, p.unitCms)}</span>
                    </span>
                    <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 self-center text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
