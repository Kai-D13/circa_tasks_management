'use client'

import { usePathname } from 'next/navigation'
import { LoadingState } from '@/components/ds/LoadingState'
import CampaignsLoading from './campaigns/loading'

// /targets lands on either the campaign card list (staff/SM/store manager) or
// the period card — a short list skeleton fits both without a layout jump.
// UI v2 K-1: vào /targets/campaigns từ NGOÀI /targets (link sidebar) thì ranh giới chờ gần nhất là file này
// (cấp targets), không phải campaigns/loading.tsx ⇒ chọn khung theo đường dẫn, tránh nhảy max-w-xl → fluid v2.
// Mọi đường dẫn khác giữ nguyên khung cũ.
export default function TargetsLoading() {
  const pathname = usePathname()
  if (pathname === '/targets/campaigns') return <CampaignsLoading />
  return (
    <div className="p-4 space-y-4 max-w-xl mx-auto">
      <div className="h-7 w-56 rounded bg-muted animate-pulse" />
      <LoadingState variant="list" rows={3} />
    </div>
  )
}
