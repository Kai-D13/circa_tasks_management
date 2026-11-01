import { CmsListSkeleton } from '@/components/cms/CmsRouteSkeletons'

// CMS P1-c — khung chờ riêng nhánh /targets/campaigns/cms (không rơi về khung danh sách KPI của campaigns/loading.tsx).
export default function Loading() {
  return <CmsListSkeleton />
}
