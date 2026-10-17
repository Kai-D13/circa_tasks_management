'use client'

import { useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { Notice } from '@/components/ds/Notice'
import { READ_STATS_ERROR, READ_STATS_NO_AUDIENCE, StoreReadBar } from '@/components/announcements/ReadMeter'
import { onlyUnread, READ_STATS_ANCHOR, type StoreReadGroup } from '@/lib/announcements/readStats'
import { formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'

// UI v2 Phase 3 · Bảng tin (A2, artboard B2 panel "Đã xem") — thống kê người xem CHỈ cho admin. Dữ liệu = đúng tập
// người nhận + read receipt mà trang chi tiết đã tải (lib/announcements/readStats); component chỉ lọc tại client.
//   · Lỗi bất kỳ truy vấn thống kê ⇒ chỉ Notice "Không tải được thống kê đã xem" (không số, không 0/0 giả — PM P1).
//   · 0 người nhận thật ⇒ "Không có đối tượng nhận." (chữ hiện hành).
//   · Bộ lọc "Tất cả / Chưa xem (N)" client-only; N = 0 ⇒ nút tắt; khi lọc: chỉ cửa hàng còn người chưa xem, chỉ người
//     chưa xem, ẩn "Người khác đã xem" (Q-140). Mỗi cửa hàng là <details> (Enter/Space bằng bàn phím).
//   · id="da-xem" + tabIndex -1: đích của link "N người chưa xem ↓" ở dải ReadMeter.

export interface OtherViewer { user_id: string; full_name: string; role: string; dept: string | null; read_at: string }

export type ReadStatsData =
  | { kind: 'error' }
  | { kind: 'ok'; read: number; total: number; groups: StoreReadGroup[]; others: OtherViewer[] }

const ROLE_VI: Record<string, string> = { admin: 'Admin', sm: 'SM', store_manager: 'Quản lý', staff: 'Nhân viên' }

export function ReadStatsPanel({ stats }: { stats: ReadStatsData }) {
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const ok = stats.kind === 'ok'
  const unreadTotal = ok ? Math.max(0, stats.total - stats.read) : 0
  const groups = ok ? (filter === 'unread' ? onlyUnread(stats.groups) : stats.groups) : []

  return (
    <section
      id={READ_STATS_ANCHOR}
      tabIndex={-1}
      aria-labelledby="ann-read-stats-title"
      data-ann-read-stats={stats.kind === 'error' ? 'error' : stats.total === 0 ? 'no-audience' : 'ok'}
      data-filter={filter}
      className="overflow-hidden rounded-lg border bg-card text-card-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring v2:rounded-v2-panel"
    >
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 md:px-5 md:py-4">
        <h2 id="ann-read-stats-title" className="min-w-0 flex-1 text-[15px] font-semibold">
          {/* Số chỉ khi có người nhận thật — 0 người nhận KHÔNG ghi "0/0" (PM P1), lỗi không ghi số. */}
          {ok && stats.total > 0 ? (
            <>Đã xem: <span className="tabular-nums">{stats.read}/{stats.total}</span> <span className="font-normal text-muted-foreground">(đối tượng nhận)</span></>
          ) : 'Đã xem'}
        </h2>
        {ok && stats.total > 0 && (
          <div role="group" aria-label="Lọc người nhận" className="inline-flex gap-1 rounded-md bg-muted p-[3px] v2:rounded-v2-control">
            {([['all', 'Tất cả'], ['unread', `Chưa xem (${unreadTotal})`]] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={filter === k}
                data-ann-filter={k}
                disabled={k === 'unread' && unreadTotal === 0}
                onClick={() => setFilter(k)}
                className={cn(
                  'min-h-[44px] rounded-[8px] px-2.5 text-[12px] md:min-h-[32px]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                  filter === k ? 'border border-input bg-card font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {stats.kind === 'error' ? (
        <div className="p-4 md:px-5"><Notice tone="warning" role="status" title={READ_STATS_ERROR} /></div>
      ) : stats.total === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground md:px-5">{READ_STATS_NO_AUDIENCE}</p>
      ) : (
        <div>
          {groups.map((g, i) => (
            <details
              key={`${filter}:${g.store}`}
              open={filter === 'unread' ? true : undefined}
              data-ann-store={g.store}
              data-unassigned={g.unassigned ? '' : undefined}
              className={cn('group/store', i > 0 && 'border-t')}
            >
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-3 px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-5 [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/store:rotate-90" />
                <StoreReadBar name={g.store} read={g.read} total={g.total} />
              </summary>
              <ul className="divide-y px-4 pb-2 pl-11 text-[13px] md:px-5 md:pl-[46px]">
                {g.members.map((m) => (
                  <li key={m.id} data-ann-member={m.readAt ? 'read' : 'unread'} className="flex items-center gap-2.5 py-2">
                    {m.readAt ? (
                      <span aria-hidden="true" className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-status-success text-white">
                        <Check className="size-3" strokeWidth={3} />
                      </span>
                    ) : (
                      <span aria-hidden="true" className="size-[18px] shrink-0 rounded-full border-[1.5px] border-input" />
                    )}
                    <span className={cn('min-w-0 flex-1 break-words', !m.readAt && 'text-muted-foreground')}>{m.full_name}</span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">{m.readAt ? formatDateTime(m.readAt) : 'Chưa xem'}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}

      {ok && filter === 'all' && stats.others.length > 0 && (
        <div data-ann-others className="space-y-2 border-t px-4 py-3.5 md:px-5">
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Người khác đã xem ({stats.others.length})</p>
          <ul className="divide-y text-[13px]">
            {stats.others.map((v) => (
              <li key={v.user_id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 break-words">{v.full_name} <span className="text-muted-foreground">· {ROLE_VI[v.role] ?? v.role}{v.dept ? ` · ${v.dept}` : ''}</span></span>
                <span className="shrink-0 text-[12px] text-muted-foreground">{formatDateTime(v.read_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
