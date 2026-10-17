'use client'

import { createContext, useCallback, useContext, useState } from 'react'
import { toast } from 'sonner'

// PM 17/10 (P1 — catalog bất khả ghi): fixture /ui-catalog/kpi-v2/* dựng CHÍNH component của route thật. Mọi handler
// gọi server action (ghi lẫn đọc) hoặc export hỏi useFixtureActionBlocked() NGAY TRƯỚC lời gọi: trong
// <KpiFixtureBoundary> ⇒ chặn (toast, không gọi action, không request); ngoài boundary (route thật) ⇒ false, action giữ
// nguyên. Lớp bảo vệ là logic handler, không phải CSS. Chỉ trang fixture bọc boundary; số lần chặn ghi ở
// [data-kpi-fixture-blocked] (ẩn) để spec đếm đúng từng thao tác.
export const KPI_FIXTURE_BLOCKED_TOAST = 'Bản mẫu UI — thao tác không gọi máy chủ, không ghi dữ liệu.'

const FixtureBlockContext = createContext<(() => void) | null>(null)

export function KpiFixtureBoundary({ children }: { children: React.ReactNode }) {
  const [blocked, setBlocked] = useState(0)
  const block = useCallback(() => {
    setBlocked((n) => n + 1)
    toast.info(KPI_FIXTURE_BLOCKED_TOAST)
  }, [])
  return (
    <FixtureBlockContext.Provider value={block}>
      {children}
      <span hidden data-kpi-fixture-blocked={blocked} />
    </FixtureBlockContext.Provider>
  )
}

export function useFixtureActionBlocked(): () => boolean {
  const block = useContext(FixtureBlockContext)
  return useCallback(() => {
    if (!block) return false
    block()
    return true
  }, [block])
}
