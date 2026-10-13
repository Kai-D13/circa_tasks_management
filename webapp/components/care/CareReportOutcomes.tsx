import { CARE_OUTCOMES, CARE_OUTCOME_META } from '@/lib/care/outcome'
import type { CareOutcomeKey } from '@/lib/care/browse'
import { cn } from '@/lib/utils'

// B8.2 — "Kết quả liên hệ" /care/reports (Q-117): MỖI TASK đã có lượt tính một lần theo `last_outcome`
// (không đếm mọi lượt); task chưa liên hệ không vào mẫu. Trang thật tải số sau khi hiện (CareReportExtras) để các
// count không tranh pool với lúc render khung trang. Lỗi đọc ⇒ báo không tải được, không hiện 0 giả.

const PANEL = 'rounded-care-panel border border-care-line bg-card'
const fmt = (n: number) => n.toLocaleString('vi-VN')

export function CareReportOutcomesView({ counts }: { counts: Partial<Record<CareOutcomeKey, number>> | null }) {
  const rows = CARE_OUTCOMES.map((k) => ({ key: k, label: CARE_OUTCOME_META[k].label, n: counts?.[k] ?? 0 }))
  const sum = rows.reduce((s, r) => s + r.n, 0)
  const max = Math.max(1, ...rows.map((r) => r.n))
  return (
    <section className={cn(PANEL, 'space-y-3 p-4')} aria-labelledby="care-report-outcomes" data-testid="care-report-outcomes">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="care-report-outcomes" className="text-base font-semibold">Kết quả liên hệ</h2>
        <span className="text-xs text-muted-foreground">{counts ? `${fmt(sum)} khách · mỗi khách theo lượt gần nhất` : 'Không tải được'}</span>
      </div>
      {counts ? (
        <ul className="space-y-2" aria-label="Kết quả lượt gần nhất theo khách">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)_2.5rem] items-center gap-3 text-sm">
              <span className="truncate" title={r.label}>{r.label}</span>
              <span className="flex h-2.5 items-center" role="img" aria-label={`${r.label}: ${r.n}`}>
                <span className={cn('block h-full rounded-r', r.n > 0 ? 'bg-status-info' : 'w-0.5 bg-muted-foreground/40')}
                  style={r.n > 0 ? { width: `${(r.n / max) * 100}%` } : undefined} />
              </span>
              <span className={cn('text-right font-semibold tabular-nums', r.n === 0 && 'text-muted-foreground')}>{fmt(r.n)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Không tải được phân bố kết quả — thử tải lại trang.</p>
      )}
    </section>
  )
}

export function CareReportOutcomesSkeleton() {
  return (
    <section className={cn(PANEL, 'space-y-3 p-4')} aria-busy="true" aria-label="Kết quả liên hệ đang tải" data-testid="care-report-outcomes-loading">
      <h2 className="text-base font-semibold">Kết quả liên hệ</h2>
      <div className="space-y-2">{CARE_OUTCOMES.map((k) => <div key={k} className="h-4 animate-pulse rounded bg-muted" />)}</div>
    </section>
  )
}
