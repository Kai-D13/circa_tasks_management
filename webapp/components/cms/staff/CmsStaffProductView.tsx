import Link from 'next/link'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { TagBadge } from '@/components/ds/TagBadge'
import { CmsProductImage } from '@/components/cms/CmsProductImage'
import { CmsCopyButton } from '@/components/cms/staff/CmsCopyButton'
import { CMS_GATE_HUE, CMS_GATE_LABEL, cmsAmountPerUnit, cmsBaseQtyLine, cmsDate, cmsDateRange, cmsPrice, cmsTierRange, cmsVnd } from '@/lib/cms/display'
import { CMS_STATUS_LABEL, CMS_STATUS_TONE, cmsDisplayStatus } from '@/lib/cms/programStatus'
import { cmsStaffHref } from '@/lib/cms/staffView'
import type { CmsStaffProduct } from '@/lib/cms/server/staffCatalog'

// CMS P1-d · D2 `/targets/cms/products/[programProductId]` (UI §4.2; r2 U1 / U19). P1 CHỈ: ảnh, tên, ProductID · giá ·
// chương trình, điều kiện cấu hình (ẩn khi không target), thang chính sách `đ/unit_CMS`, quy cách, tư vấn ĐẦY ĐỦ (text
// thuần `pre-line`, không cắt — PM P1-c §4) + Sao chép. KHÔNG có CMS đã kiếm, tiến độ, bậc hiện tại, "Nếu bán thêm",
// ghi nhận gần đây (P2). Dùng chung route thật + fixture /ui-catalog/cms-v2/product.

export function CmsStaffProductView({ data, today }: { data: CmsStaffProduct; today: string }) {
  const { program, product: p } = data
  const display = cmsDisplayStatus(program, today)
  return (
    <div data-ui-v2="page" data-layout-width="centered" data-cms-staff-product-detail={p.gmvBasis} className="mx-auto max-w-2xl p-4 space-y-4 v2:space-y-3">
      <Link href={cmsStaffHref(program.id)} className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> CMS sản phẩm
      </Link>

      <div className="flex justify-center rounded-v2-panel bg-muted p-3">
        <CmsProductImage url={p.imageUrlSnapshot} name={p.nameSnapshot} size={180} />
      </div>

      <div className="space-y-1.5">
        <h1 className="text-[20px] font-bold leading-snug break-words">{p.nameSnapshot}</h1>
        <p className="text-[13px] text-muted-foreground break-words">
          <span className="tabular-nums">{p.productId}</span>
          {p.priceSnapshot ? <> · <span className="tabular-nums">{cmsPrice(p.priceSnapshot)}</span></> : null}
          {' · '}{program.name}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          <StatusBadge tone={CMS_STATUS_TONE[display]} size="sm">{CMS_STATUS_LABEL[display]}</StatusBadge>
          <span className="tabular-nums">{display === 'upcoming' ? `Bắt đầu ${cmsDate(program.startDate)}` : cmsDateRange(program.startDate, program.endDate)}</span>
        </div>
      </div>

      {p.gmvBasis !== 'none' && (
        <section data-cms-staff-gate className="space-y-1.5 rounded-v2-panel border bg-card p-4">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold">
            Điều kiện <TagBadge hue={CMS_GATE_HUE[p.gmvBasis]}>{CMS_GATE_LABEL[p.gmvBasis]}</TagBadge>
          </h2>
          {p.gmvBasis === 'product'
            ? <p className="text-[13px]">Mỗi dược sĩ có GMV sản phẩm này trong kỳ đạt <b className="tabular-nums">{cmsVnd(p.targetGmv)}</b> thì CMS được tính cho toàn bộ số lượng dược sĩ đó đã bán trong kỳ.</p>
            : <p className="text-[13px]">Mỗi dược sĩ có tổng GMV các sản phẩm trong nhóm danh mục đạt <b className="tabular-nums">{cmsVnd(program.catalogTargetGmv)}</b> thì CMS được tính cho toàn bộ số lượng dược sĩ đó đã bán trong kỳ.</p>}
        </section>
      )}

      <section data-cms-staff-tiers className="space-y-2 rounded-v2-panel border bg-card p-4">
        <h2 className="text-[14px] font-semibold">Thang CMS theo số lượng</h2>
        {p.tiers.length === 1 ? (
          <p className="text-[13px]">CMS <b className="tabular-nums">{cmsAmountPerUnit(p.tiers[0].amount, p.unitCms)}</b>{p.tiers[0].to !== null ? <> · tối đa {p.tiers[0].to} {p.unitCms}</> : null}</p>
        ) : (
          <ol className="space-y-1.5">
            {p.tiers.map((t) => (
              <li key={t.order} data-cms-staff-tier={t.order} className="flex items-center justify-between gap-3 rounded-[8px] border px-3 py-2 text-[13px]">
                <span><span className="text-muted-foreground">Bậc {t.order} · </span><span className="tabular-nums">{cmsTierRange(t.from, t.to)} {p.unitCms}</span></span>
                <b className="tabular-nums">{cmsAmountPerUnit(t.amount, p.unitCms)}</b>
              </li>
            ))}
          </ol>
        )}
        <p className="text-[12px] text-muted-foreground">Lũy tiến: mỗi {p.unitCms} tính theo bậc nó rơi vào. {cmsBaseQtyLine(p.unitCms, p.baseQuantityCms)}.</p>
      </section>

      <section data-cms-staff-advice className="space-y-2 rounded-v2-panel border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold">
            Nội dung tư vấn <StatusBadge tone="success" size="sm"><ShieldCheck className="mr-0.5 inline h-3 w-3" aria-hidden="true" />Đã kiểm duyệt</StatusBadge>
          </h2>
          <CmsCopyButton text={p.adviceText} />
        </div>
        <p className="whitespace-pre-line break-words text-[14px] leading-relaxed">{p.adviceText}</p>
      </section>
    </div>
  )
}
