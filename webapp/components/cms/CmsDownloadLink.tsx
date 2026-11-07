'use client'

import { useFixtureActionBlocked, useInFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'

// CMS-UI-1 (PM 04/11 §6.7; r2 P2) — link TẢI FILE (XLSX kết quả / chi trả / dòng lỗi import). Route thật: <a href> như cũ (không đổi
// hành vi tải). Trong fixture /ui-catalog (KpiFixtureBoundary) KHÔNG có href tới endpoint thật — là <button> bấm bị chặn qua
// useFixtureActionBlocked ⇒ mở tab mới / chuột giữa / sao chép link cũng không bắn endpoint thật với ID giả (0 request /api/...).
export function CmsDownloadLink({ href, className, children, ...data }: { href: string; className?: string; children: React.ReactNode } & Record<`data-${string}`, string | boolean | undefined>) {
  const inFixture = useInFixtureBoundary()
  const fixtureBlocked = useFixtureActionBlocked()
  if (inFixture) {
    return (
      <button type="button" onClick={() => { fixtureBlocked() }} className={className} {...data}>
        {children}
      </button>
    )
  }
  return (
    <a href={href} className={className} {...data}>
      {children}
    </a>
  )
}
