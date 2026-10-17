import { AnnouncementCard, type AnnouncementCardData } from '@/components/announcements/AnnouncementCard'
import { groupAnnouncementsByTime } from '@/lib/announcements/feed'

// UI v2 Phase 3 · Bảng tin (A0, artboard B0 "Nhóm theo thời gian" / B1 / M1) — danh sách thẻ chia nhóm Hôm nay ·
// Tuần này · Trước đó theo ngày VN (lib/announcements/feed). Chỉ nhóm trên mảng ĐÃ TẢI, giữ thứ tự gốc trong nhóm,
// chỉ render nhóm có dữ liệu. Danh sách rỗng ⇒ caller hiện EmptyState (component này không tự quyết "rỗng").

export function AnnouncementFeed({ items, now }: { items: AnnouncementCardData[]; now: Date | string }) {
  const groups = groupAnnouncementsByTime(items, now)
  return (
    <div data-ann-feed className="space-y-5 v2:space-y-[18px]">
      {groups.map((g) => (
        <section key={g.key} data-ann-group={g.key} aria-labelledby={`ann-group-${g.key}`} className="space-y-2.5">
          <div className="flex items-center gap-2.5 pt-1">
            <h2 id={`ann-group-${g.key}`} className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              {g.label}
            </h2>
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
          </div>
          <ul className="space-y-2.5">
            {g.items.map((a) => (
              <li key={a.id}><AnnouncementCard a={a} /></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
