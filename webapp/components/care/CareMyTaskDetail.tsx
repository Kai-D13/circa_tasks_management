'use client'

import { useState } from 'react'
import Link from 'next/link'
import { MessageSquare, NotebookPen, Package, Phone, User } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { careMyBadge } from '@/lib/care/my'
import type { CareInteractionPage } from '@/lib/care/browse'
import { formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { CareProductGallery, type CareProductView } from './CareProductGallery'
import { CareTimeline, type CareLoadMoreInteractions, type CareTimelineEvent } from './CareTimeline'

// Chi tiết khách cho dược sĩ (SPEC B4 §2): 3 tab Tổng quan / Sản phẩm / Lịch sử chăm sóc.
// Ảnh sản phẩm CHỈ tải khi mở tab Sản phẩm (gallery chỉ mount ở tab đó). Gọi/Nhắn chỉ mở
// tel:/sms: trên máy — không gửi gì tự động. Task đã kết thúc ⇒ chỉ đọc.

export interface CareMyDetailData {
  task: {
    id: string; customer_name: string; phone_raw: string; phone_norm: string; period_month: string; due_date: string
    status: 'open' | 'completed' | 'closed_unfinished'; last_outcome: string | null; last_interaction_at: string | null; next_action_date: string | null
    store: { code: string; name: string } | null; assignee: { full_name: string } | null
  }
  products: CareProductView[]
  interactions: CareInteractionPage
  events: CareTimelineEvent[]
}

const TABS = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'products', label: 'Sản phẩm' },
  { key: 'history', label: 'Lịch sử chăm sóc' },
] as const
type TabKey = (typeof TABS)[number]['key']
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

export function CareMyTaskDetail({ data, todayISO, canRecord, updateHref, loadMore }: {
  data: CareMyDetailData
  todayISO: string
  canRecord: boolean
  updateHref: string
  loadMore?: CareLoadMoreInteractions
}) {
  const [tab, setTab] = useState<TabKey>('overview')
  const t = data.task
  const b = careMyBadge(t, todayISO)
  return (
    <div className="space-y-4" data-testid="care-my-detail">
      <div className="flex flex-wrap items-center gap-2">
        <User className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold" title={t.customer_name}>{t.customer_name}</h2>
        <StatusBadge tone={b.tone}>{b.label}</StatusBadge>
      </div>

      <div role="tablist" aria-label="Thông tin khách" className="grid grid-cols-3 gap-1 rounded-lg border bg-muted/40 p-1">
        {TABS.map((x) => (
          <button key={x.key} type="button" role="tab" id={`care-tab-${x.key}`} aria-selected={tab === x.key} aria-controls={`care-panel-${x.key}`}
            onClick={() => setTab(x.key)}
            className={cn('min-h-[44px] rounded-md px-2 text-sm font-medium transition-colors',
              tab === x.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}>
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <section role="tabpanel" id="care-panel-overview" aria-labelledby="care-tab-overview" className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <a href={`tel:${t.phone_norm}`} className={cn(buttonVariants({ variant: 'outline' }), 'min-h-[44px]')}><Phone className="size-4" /> Gọi {t.phone_raw}</a>
            <a href={`sms:${t.phone_norm}`} className={cn(buttonVariants({ variant: 'outline' }), 'min-h-[44px]')}><MessageSquare className="size-4" /> Nhắn tin</a>
          </div>
          <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-card p-3">
            <Field label="Cửa hàng">{t.store ? `${t.store.code} · ${t.store.name}` : '—'}</Field>
            <Field label="Dược sĩ phụ trách">{t.assignee?.full_name ?? '—'}</Field>
            <Field label="Hạn chăm sóc">{dmy(t.due_date)}</Field>
            <Field label="Hẹn chăm sóc lại">{t.next_action_date ? dmy(t.next_action_date) : '—'}</Field>
            <Field label="Lần chăm sóc gần nhất">{t.last_interaction_at ? formatDateTime(t.last_interaction_at) : 'Chưa có'}</Field>
            <Field label="Sản phẩm cần chăm sóc">{data.products.length}</Field>
          </dl>
        </section>
      )}

      {tab === 'products' && (
        <section role="tabpanel" id="care-panel-products" aria-labelledby="care-tab-products" className="space-y-3">
          {data.products.length ? <CareProductGallery products={data.products} /> : <EmptyState icon={Package} title="Không có sản phẩm" />}
        </section>
      )}

      {tab === 'history' && (
        <div role="tabpanel" id="care-panel-history" aria-labelledby="care-tab-history">
          <CareTimeline taskId={t.id} initial={data.interactions} events={data.events} loadMore={loadMore} />
        </div>
      )}

      {canRecord ? (
        <Link href={updateHref} prefetch={false} className={cn(buttonVariants(), 'min-h-[44px] w-full')}>
          <NotebookPen className="size-4" /> Ghi nhận chăm sóc
        </Link>
      ) : (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground" role="note">
          {t.status === 'open' ? 'Khách không còn mở để ghi nhận (đã qua kỳ hoặc không còn giao cho bạn).' : 'Khách đã kết thúc chăm sóc — chỉ xem.'}
        </p>
      )}
    </div>
  )
}
