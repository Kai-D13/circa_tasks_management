import { Skeleton } from '@/components/ui/skeleton'

// UI v2 Phase 2 · K-3: khung chờ trang tạo chiến dịch (lối vào: nút "Tạo chiến dịch" ở danh sách — cùng segment
// campaigns ⇒ ranh giới này). Server component (không chờ chunk JS). Bố cục theo CampaignWizard: tiêu đề, 2 bước, form.
export default function NewCampaignLoading() {
  return (
    <div data-ui-v2="page" data-route-loading="campaign-new" className="p-4 md:p-6 max-w-3xl mx-auto space-y-4 md:space-y-[18px]">
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-7 w-56" />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Skeleton className="h-[48px] rounded-v2-control" />
        <Skeleton className="h-[48px] rounded-v2-control" />
      </div>
      <div className="space-y-4 rounded-v2-panel border bg-card px-5 py-[18px]">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-[44px] md:h-[40px] w-full rounded-v2-control" />
          </div>
        ))}
      </div>
    </div>
  )
}
