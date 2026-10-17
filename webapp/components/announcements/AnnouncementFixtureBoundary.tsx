'use client'

import { createContext, useCallback, useContext, useState } from 'react'
import { toast } from 'sonner'

// UI v2 Phase 3 · Bảng tin (A0) — safety gate của fixture /ui-catalog/announcements-v2 (PM spec §4 A0/A3, P1):
// fixture KHÔNG được gọi create/update/delete/markAnnouncementRead, KHÔNG tải file lên GCS/Supabase.
// Cùng cơ chế đã qua audit ở KPI (components/kpi/KpiFixtureBoundary) nhưng tách riêng cho Bảng tin (không sửa file
// KPI): mọi handler ghi/upload của component Bảng tin hỏi useAnnouncementFixtureBlocked() NGAY TRƯỚC lời gọi —
// trong boundary ⇒ chặn (toast, không gọi action, không request); ngoài boundary (route thật) ⇒ false, giữ nguyên
// hành vi. Lớp bảo vệ là logic handler, không phải CSS. Số lần chặn ở [data-ann-fixture-blocked] (ẩn) để spec đếm.
export const ANN_FIXTURE_BLOCKED_TOAST = 'Bản mẫu UI — thao tác không gọi máy chủ, không ghi dữ liệu.'

const FixtureBlockContext = createContext<(() => void) | null>(null)

export function AnnouncementFixtureBoundary({ children }: { children: React.ReactNode }) {
  const [blocked, setBlocked] = useState(0)
  const block = useCallback(() => {
    setBlocked((n) => n + 1)
    toast.info(ANN_FIXTURE_BLOCKED_TOAST)
  }, [])
  return (
    <FixtureBlockContext.Provider value={block}>
      {children}
      <span hidden data-ann-fixture-blocked={blocked} />
    </FixtureBlockContext.Provider>
  )
}

/** true ⇒ đang trong fixture: handler phải DỪNG trước mọi lời gọi ghi/upload. Ngoài fixture luôn false. */
export function useAnnouncementFixtureBlocked(): () => boolean {
  const block = useContext(FixtureBlockContext)
  return useCallback(() => {
    if (!block) return false
    block()
    return true
  }, [block])
}
