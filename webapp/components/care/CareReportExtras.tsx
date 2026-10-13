'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { carePct, careReportExtrasKey } from '@/lib/care/reports'
import type { CareOutcomeKey } from '@/lib/care/browse'
import { CareKpiTile, CarePaceRow } from './CareReportView'
import { CareReportOutcomesSkeleton, CareReportOutcomesView } from './CareReportOutcomes'

// B8.2 — số liệu phụ /care/reports ("Đã liên hệ" Q-113 + "Kết quả liên hệ" Q-117) tải MỘT lần sau khi trang hiện
// (server action, session/RLS). Ô KPI, thanh nhịp và khối kết quả đọc chung kết quả. Đang tải ⇒ "…"; lỗi ⇒ "—"
// + ghi chú; không bao giờ hiện 0 giả.

export type CareReportExtrasLoader = (input: { month: string; store: string | null; assignee: string | null }) =>
  Promise<{ ok: true; contacted: number; outcomes: Partial<Record<CareOutcomeKey, number>> } | { ok: false; message: string }>

type State = { kind: 'loading' } | { kind: 'ok'; contacted: number; outcomes: Partial<Record<CareOutcomeKey, number>> } | { kind: 'error' }
const Ctx = createContext<State>({ kind: 'loading' })
const fmt = (n: number) => n.toLocaleString('vi-VN')
const LABEL = 'Đã liên hệ'
const DOT = 'bg-status-info'

export function CareReportExtrasProvider({ load, params, children }: {
  load: CareReportExtrasLoader
  params: { month: string; store: string | null; assignee: string | null }
  children: React.ReactNode
}) {
  // Kết quả gắn khoá bộ lọc đã sinh ra nó; render chỉ dùng khi khớp bộ lọc HIỆN TẠI ⇒ lần render đầu sau khi đổi
  // kỳ/store/dược sĩ là "đang tải", không bao giờ là số của bộ lọc cũ (PM B8.2 r1). Trang còn đặt `key` cho provider.
  const [got, setGot] = useState<{ key: string; s: State } | null>(null)
  const key = careReportExtrasKey(params)
  const seq = useRef(0)
  useEffect(() => {
    const my = ++seq.current
    const done = (s: State) => { if (my === seq.current) setGot({ key, s }) }
    load(params)
      .then((r) => done(r.ok ? { kind: 'ok', contacted: r.contacted, outcomes: r.outcomes } : { kind: 'error' }))
      .catch(() => done({ kind: 'error' }))
    // params gom trong key (đối tượng mới mỗi lần render server không được kích hoạt lại khi giá trị không đổi).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load])
  const state: State = got && got.key === key ? got.s : { kind: 'loading' }
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>
}

export function CareContactedKpiLive({ tasks }: { tasks: number }) {
  const s = useContext(Ctx)
  if (s.kind === 'loading') return <CareKpiTile label={LABEL} value="…" hint="đang đếm khách có lượt chăm sóc" dot={DOT} />
  if (s.kind === 'error') return <CareKpiTile label={LABEL} value="—" hint="không tải được — thử tải lại trang" dot={DOT} />
  return <CareKpiTile label={LABEL} value={fmt(s.contacted)} pct={carePct(s.contacted, tasks)} hint="khách có ≥ 1 lượt chăm sóc" dot={DOT} />
}

export function CareContactedPaceLive({ tasks }: { tasks: number }) {
  const s = useContext(Ctx)
  return <CarePaceRow label="Khách đã liên hệ" cls="bg-primary"
    pct={s.kind === 'ok' ? carePct(s.contacted, tasks) : null}
    note={s.kind === 'ok' ? `${fmt(s.contacted)}/${fmt(tasks)} khách có ≥ 1 lượt` : s.kind === 'error' ? 'không tải được' : 'đang tải'} />
}

export function CareReportOutcomesLive() {
  const s = useContext(Ctx)
  if (s.kind === 'loading') return <CareReportOutcomesSkeleton />
  return <CareReportOutcomesView counts={s.kind === 'ok' ? s.outcomes : null} />
}
