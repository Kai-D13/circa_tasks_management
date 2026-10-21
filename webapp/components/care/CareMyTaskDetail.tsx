'use client'

import { useState } from 'react'
import Link from 'next/link'
import { MessageSquare, NotebookPen, Package, Phone } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { StickyActionBar } from '@/components/ds/StickyActionBar'
import { careMyBadge, customerInitials } from '@/lib/care/my'
import type { CareInteractionPage } from '@/lib/care/browse'
import { formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { CareProductGallery, type CareProductView } from './CareProductGallery'
import { CareTimeline, type CareLoadMoreInteractions, type CareTimelineEvent } from './CareTimeline'

// Chi tiết khách cho dược sĩ (SPEC B4 §2): 3 tab Tổng quan / Sản phẩm / Lịch sử chăm sóc.
// Ảnh sản phẩm CHỈ tải khi mở tab Sản phẩm (gallery chỉ mount ở tab đó). Gọi/Nhắn chỉ mở
// tel:/sms: trên máy — không gửi gì tự động. Task đã kết thúc ⇒ chỉ đọc.
// Q-107 (B7-ui r1.1): chế độ QA local cũng mở tel:/sms: — số là phone_norm của task đang xem, mà
// trang chỉ đọc được task is_test thuộc batch marker (withCareScope) ⇒ luôn là số bản sao QA giả.
// Operator chịu trách nhiệm không để cuộc gọi/tin nhắn tới khách thật; app không tự gọi/gửi.
// B7-ui r2 (artboard 09): khối khách trắng tràn ngang (avatar chữ tắt, tên + badge, SĐT · hạn, Gọi/Nhắn);
// tab gạch chân dính dưới header; Tổng quan dạng lưới 2 cột; "Ghi nhận chăm sóc" ở thanh đáy (mt-auto:
// nội dung ngắn vẫn nằm sát đáy màn — gốc trang là cột flex cao tối thiểu bằng vùng cuộn).
// SĐT ĐẦY ĐỦ ở đây (artboard che số): Q-107 cần đối chiếu số trước khi bấm gọi.

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
const CONTACT_BTN = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-care-ctl text-[15px] font-semibold outline-none transition-opacity focus-visible:ring-3 focus-visible:ring-ring/50 active:opacity-80'

export function CareMyTaskDetail({ data, todayISO, canRecord, updateHref, loadMore, qa = false, orders }: {
  data: CareMyDetailData
  todayISO: string
  canRecord: boolean
  updateHref: string
  loadMore?: CareLoadMoreInteractions
  /** Chế độ QA local (Q-107): chỉ thêm dòng nhận biết số giả — nút vẫn là tel:/sms: thật. */
  qa?: boolean
  /** E3: "Đơn xác thực sau import" ở tab Tổng quan — chỉ truyền khi CARE_ORDER_LINKS_UI_ENABLED. */
  orders?: React.ReactNode
}) {
  const [tab, setTab] = useState<TabKey>('overview')
  const t = data.task
  const b = careMyBadge(t, todayISO)
  // Số mục lịch sử đang hiện (cùng quy tắc CareTimeline: còn trang cũ hơn ⇒ chỉ tính sự kiện từ lượt cũ
  // nhất đã tải, và ghi "N+").
  const loaded = data.interactions.rows
  const oldest = data.interactions.hasMore && loaded.length ? loaded.reduce((m, r) => (r.created_at < m ? r.created_at : m), loaded[0].created_at) : null
  const historyCount = `${loaded.length + data.events.filter((e) => !oldest || e.created_at >= oldest).length}${data.interactions.hasMore ? '+' : ''}`
  const overview: { label: string; value: string | number | null }[] = [
    { label: 'Hạn chăm sóc', value: dmy(t.due_date) },
    { label: 'Hẹn chăm sóc lại', value: t.next_action_date ? dmy(t.next_action_date) : null },
    { label: 'Lần chăm sóc gần nhất', value: t.last_interaction_at ? formatDateTime(t.last_interaction_at) : null },
    { label: 'Sản phẩm cần chăm sóc', value: data.products.length },
    { label: 'Cửa hàng', value: t.store ? `${t.store.code} · ${t.store.name}` : null },
    { label: 'Dược sĩ phụ trách', value: t.assignee?.full_name ?? null },
  ]
  return (
    <div className="flex flex-1 flex-col md:space-y-4" data-testid="care-my-detail">
      <section aria-label="Thông tin liên hệ" className="space-y-3 border-b border-care-line bg-card px-4 pt-[18px] pb-4 md:rounded-care-card md:border">
        <div className="flex items-center gap-3">
          <div aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-[15px] font-semibold text-muted-foreground">
            {customerInitials(t.customer_name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-[20px] leading-tight font-bold break-words">{t.customer_name}</h2>
              <StatusBadge tone={b.tone}>{b.label}</StatusBadge>
            </div>
            {/* Số đầy đủ trong span riêng (nút chỉ ghi "Gọi khách") — số dài/định dạng lạ không làm tràn nút ở 360px. */}
            <p className="mt-0.5 text-[13px] text-muted-foreground"><span className="tabular-nums">{t.phone_raw}</span> · Hạn {dmy(t.due_date)}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <a href={`tel:${t.phone_norm}`} className={cn(CONTACT_BTN, 'bg-status-success-bg text-status-success')}><Phone className="size-[18px]" /> Gọi khách</a>
          <a href={`sms:${t.phone_norm}`} className={cn(CONTACT_BTN, 'border border-care-line-strong bg-card text-foreground')}><MessageSquare className="size-[18px]" /> Nhắn tin</a>
        </div>
        {qa && (
          <p role="note" data-testid="care-contact-qa" className="text-xs text-status-warning">
            Chế độ QA: số của khách QA giả — máy sẽ mở ứng dụng gọi/SMS, kiểm tra số trước khi bấm gọi.
          </p>
        )}
      </section>

      <div role="tablist" aria-label="Thông tin khách"
        className="sticky top-[52px] z-20 grid grid-cols-3 border-b border-care-line bg-card px-2 md:static md:bg-transparent md:px-0">
        {TABS.map((x) => (
          <button key={x.key} type="button" role="tab" id={`care-tab-${x.key}`} aria-selected={tab === x.key} aria-controls={`care-panel-${x.key}`}
            onClick={() => setTab(x.key)}
            aria-label={x.key === 'products' ? `${x.label} ${data.products.length}` : x.label}
            className={cn('-mb-px min-h-[44px] border-b-2 px-1 text-sm whitespace-nowrap transition-colors',
              tab === x.key ? 'border-primary font-semibold text-foreground' : 'border-transparent font-medium text-muted-foreground')}>
            {/* 360px: "Lịch sử chăm sóc" xuống 2 dòng ⇒ hiện "Lịch sử"; tên truy cập giữ nhãn SPEC. */}
            {x.key === 'history' ? <><span className="sm:hidden">Lịch sử</span><span className="hidden sm:inline">{x.label}</span></> : x.label}
            {x.key === 'products' && <span className="ml-1.5 font-medium tabular-nums text-muted-foreground">{data.products.length}</span>}
            {x.key === 'history' && <span className="ml-1.5 font-medium tabular-nums text-muted-foreground">{historyCount}</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 px-4 pt-2 pb-6 md:p-0">
        {tab === 'overview' && (
          <section role="tabpanel" id="care-panel-overview" aria-labelledby="care-tab-overview">
            <dl className="grid grid-cols-2 gap-x-4">
              {overview.map((f, i) => (
                <div key={f.label} className={cn('space-y-0.5 py-3', i >= 2 && 'border-t border-care-line')}>
                  <dt className="text-[13px] text-muted-foreground">{f.label}</dt>
                  <dd className={cn('text-[15px] font-medium break-words', f.value === null && 'text-muted-foreground/70')}>{f.value ?? 'Chưa có'}</dd>
                </div>
              ))}
            </dl>
            {orders && <div className="pt-3">{orders}</div>}
          </section>
        )}

        {tab === 'products' && (
          <section role="tabpanel" id="care-panel-products" aria-labelledby="care-tab-products" className="space-y-3 pt-2">
            {data.products.length ? <CareProductGallery products={data.products} /> : <EmptyState icon={Package} title="Không có sản phẩm" />}
          </section>
        )}

        {tab === 'history' && (
          <div role="tabpanel" id="care-panel-history" aria-labelledby="care-tab-history" className="pt-3">
            <CareTimeline taskId={t.id} initial={data.interactions} events={data.events} loadMore={loadMore} showHeading={false} />
          </div>
        )}
      </div>

      {canRecord ? (
        <StickyActionBar className="mx-0 mt-auto border-care-line bg-card px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] backdrop-blur-none">
          <Link href={updateHref} prefetch={false}
            className="flex min-h-[50px] w-full items-center justify-center gap-2 rounded-care-ctl bg-care-cta text-[16px] font-semibold text-care-cta-foreground outline-none transition-opacity focus-visible:ring-3 focus-visible:ring-ring/50 active:opacity-90 md:min-h-[44px] md:text-sm">
            <NotebookPen className="size-[18px]" /> Ghi nhận chăm sóc
          </Link>
        </StickyActionBar>
      ) : (
        <p className="mx-4 mt-auto mb-4 rounded-care-ctl border border-care-line bg-card p-3 text-sm text-muted-foreground md:mx-0" role="note">
          {t.status === 'open' ? 'Khách không còn mở để ghi nhận (đã qua kỳ hoặc không còn giao cho bạn).' : 'Khách đã kết thúc chăm sóc — chỉ xem.'}
        </p>
      )}
    </div>
  )
}
