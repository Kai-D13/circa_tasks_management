import Link from 'next/link'
import { Megaphone, Plus } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { buttonVariants } from '@/components/ui/button'
import { type AnnouncementCardData } from '@/components/announcements/AnnouncementCard'
import { AnnouncementFeed } from '@/components/announcements/AnnouncementFeed'
import { AnnouncementsEmpty, AnnouncementsError, ReadStateErrorNotice } from '@/components/announcements/AnnouncementStates'
import { cn } from '@/lib/utils'

// UI v2 Phase 3 · Bảng tin (A1, artboard B1 admin desktop / M1–M3 dược sĩ mobile) — trang danh sách /announcements,
// dùng CHUNG route thật và fixture /ui-catalog/announcements-v2?fx=list-*. Chỉ trình bày: dữ liệu = đúng truy vấn hiện
// có của page (≤ 100 tin theo published_at giảm dần, RLS hiện hành), không truy vấn thêm.
//   · page-root centered `max-w-3xl mx-auto` (hợp đồng ui-width-contract giữ nguyên) + gốc data-ui-v2.
//   · Header: icon + "Bảng tin" (không phụ đề — Q-136). Admin: nút "Tạo thông báo" (44px mobile). Vai có theo dõi đọc
//     hợp lệ: "N tin mới trong danh sách" (chỉ đếm trong các tin ĐÃ TẢI — PM §3.2; không cùng nghĩa badge BottomNav).
//   · reads 'error' ⇒ Notice "Không tải được trạng thái đã xem." + không số, không "Mới" (Q-146).
//   · Truy vấn chính lỗi ⇒ ErrorState (không đọc thành "rỗng"); rỗng chỉ khi truy vấn thành công và trả 0 dòng.

export type AnnouncementsListState =
  | { kind: 'error' }
  | { kind: 'ok'; items: AnnouncementCardData[]; reads: 'tracked' | 'untracked' | 'error' }

export function AnnouncementsListView({
  canCreate, state, now,
}: {
  canCreate: boolean
  state: AnnouncementsListState
  now: Date | string
}) {
  const unread = state.kind === 'ok' && state.reads === 'tracked'
    ? state.items.filter((a) => a.read === 'unread').length
    : 0
  const actions = state.kind === 'error' ? undefined
    : canCreate ? (
      <Link href="/announcements/new" className={cn(buttonVariants({ size: 'sm' }), 'h-[44px] px-3.5 text-[13px] font-semibold md:h-[36px]')}>
        <Plus className="mr-1 h-4 w-4" /> Tạo thông báo
      </Link>
    ) : unread > 0 ? (
      <span data-ann-unread-count className="text-[13px] font-semibold text-status-info">{unread} tin mới trong danh sách</span>
    ) : undefined

  return (
    <div
      data-ui-v2="page"
      data-layout-width="centered"
      data-ann-list={state.kind === 'error' ? 'error' : state.reads}
      className="mx-auto max-w-3xl space-y-4 p-4 md:p-6 v2:space-y-[18px]"
    >
      <PageHeader title="Bảng tin" icon={Megaphone} actions={actions} className="items-center" />
      {state.kind === 'error' ? (
        <AnnouncementsError />
      ) : (
        <>
          {state.reads === 'error' && <ReadStateErrorNotice />}
          {state.items.length === 0 ? <AnnouncementsEmpty /> : <AnnouncementFeed items={state.items} now={now} />}
        </>
      )}
    </div>
  )
}
