import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { PageHeader } from '@/components/ds/PageHeader'
import { Panel } from '@/components/ds/Panel'
import { AnnouncementCard, type AnnouncementCardData } from '@/components/announcements/AnnouncementCard'
import { AnnouncementFeed } from '@/components/announcements/AnnouncementFeed'
import { ReadMeter, StoreReadBar } from '@/components/announcements/ReadMeter'
import { AnnouncementImageAddTile, AnnouncementImageTile, AnnouncementImageUploadingTile } from '@/components/announcements/AnnouncementImageTile'
import { AnnouncementsEmpty, AnnouncementsError, ReadStateErrorNotice } from '@/components/announcements/AnnouncementStates'
import { AnnouncementFixtureBoundary } from '@/components/announcements/AnnouncementFixtureBoundary'
import { AnnouncementsListView, type AnnouncementsListState } from '@/components/announcements/AnnouncementsListView'
import { groupAnnouncementsByTime } from '@/lib/announcements/feed'

// Dev-only fixture UI v2 Phase 3 · Bảng tin (artboard B0 — component dùng chung). Render ĐÚNG component của route thật
// với dữ liệu giả cố định: không truy vấn, không action, không upload; bọc AnnouncementFixtureBoundary. Ảnh = data URI
// (không request mạng). `now` cố định 15/10/2026 09:45 giờ VN (thứ Năm) ⇒ nhóm Hôm nay / Tuần này / Trước đó ổn định.
// Cổng như /ui-catalog: UI_CATALOG=1 (prod 404) + super admin.
// ?fx= components (mặc định, bảng B0) · feed (n tin, có trạng thái đọc) · feed-one · feed-empty · feed-error
//      · feed-read-error (truy vấn đọc lỗi ⇒ không "Mới") · feed-admin (admin: không theo dõi đọc, có tin hết hạn)
// A1 — trang danh sách (AnnouncementsListView, đúng view của /announcements; không khung fixture bên ngoài):
//      · list-staff (dược sĩ/QLCH: 2 tin mới) · list-allread (đã đọc hết ⇒ không dòng đếm) · list-admin (nút Tạo, không
//        theo dõi đọc, có tin hết hạn) · list-empty · list-error (truy vấn chính lỗi) · list-read-error (đọc lỗi)
//      · list-long (tiêu đề + trích dẫn rất dài)

const NOW = '2026-10-15T02:45:00.000Z' // 09:45 15/10/2026 giờ VN
const img = (a: string, b: string) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs><rect width='320' height='180' fill='url(#g)'/><circle cx='246' cy='58' r='22' fill='${b}' opacity='.55'/></svg>`,
)}`
const IMG_A = img('#E7D8C9', '#B9A48E')
const IMG_B = img('#CFE0EE', '#8FB2CF')
const IMG_C = img('#D9E8D2', '#9DBE8C')

const LONG_TITLE = 'Thông báo điều chỉnh lịch trực và quy trình nhận hàng dịp Tết Dương lịch 2027 cho toàn bộ cửa hàng khu vực Hồ Chí Minh mở rộng — đọc kỹ trước khi đăng ký ca'
const base = (o: Partial<AnnouncementCardData> & Pick<AnnouncementCardData, 'id' | 'title' | 'publishedAt'>): AnnouncementCardData => ({
  href: `#${o.id}`, excerpt: null, creatorName: 'Nguyễn Văn A', byStore: false, expired: false, read: 'read', coverUrl: null, ...o,
})
const FEED: AnnouncementCardData[] = [
  base({ id: 'fx-ann-1', title: 'Lịch trực Tết Dương lịch 2027 — đăng ký trước 20/10', publishedAt: '2026-10-15T02:30:00Z', read: 'unread', coverUrl: IMG_A,
    excerpt: 'Các cửa hàng gửi lịch trực 31/12 – 01/01 cho Quản lý vùng. Ca trực được tính công x3 theo quy định nhân sự hiện hành.' }),
  base({ id: 'fx-ann-2', title: 'Đổi giờ nhận hàng kho Bình Dương tuần 43', publishedAt: '2026-10-15T01:10:00Z', read: 'unread', byStore: true, creatorName: 'Trần Thị B',
    excerpt: 'Xe giao hàng đến từ 13:00 – 15:00 thay vì buổi sáng. Cửa hàng bố trí người nhận và kiểm đếm.' }),
  base({ id: 'fx-ann-3', title: 'Cập nhật quy trình nhận hàng từ kho Bình Dương', publishedAt: '2026-10-13T09:05:00Z', creatorName: 'Trần Thị B',
    excerpt: 'Từ 14/10, phiếu giao hàng được đối chiếu trên app trước khi ký nhận. Chi tiết xem hướng dẫn trong nội dung.' }),
  base({ id: 'fx-ann-4', title: 'Trưng bày quầy OTC theo planogram tuần 42', publishedAt: '2026-10-12T01:00:00Z', byStore: true, coverUrl: IMG_B, creatorName: 'Phạm Thị D',
    excerpt: 'Áp dụng cho 6 cửa hàng khu vực Quận 1 – Quận 3. Ảnh mẫu trong phần nội dung.' }),
  base({ id: 'fx-ann-5', title: 'Khuyến mãi Vitamin C tháng 9', publishedAt: '2026-09-01T03:00:00Z', coverUrl: IMG_C,
    excerpt: 'Chương trình mua 2 tặng 1 áp dụng đến hết 30/09.' }),
]
// Bốn trạng thái thẻ B0 + tiêu đề dài.
const CARDS: { caption: string; a: AnnouncementCardData }[] = [
  { caption: 'Chưa đọc', a: FEED[0] },
  { caption: 'Đã đọc', a: FEED[2] },
  { caption: 'Theo cửa hàng', a: { ...FEED[3], read: 'read' } },
  { caption: 'Hết hạn (chỉ admin thấy)', a: { ...FEED[4], id: 'fx-ann-expired', href: '#fx-ann-expired', read: 'untracked', expired: true } },
  { caption: 'Tiêu đề dài · chưa đọc', a: { ...FEED[1], id: 'fx-ann-long', href: '#fx-ann-long', title: LONG_TITLE, excerpt: `${FEED[0].excerpt} ${FEED[3].excerpt} ${FEED[2].excerpt}` } },
]
const asAdmin = (list: AnnouncementCardData[]) => list.map((a, i) => ({ ...a, read: 'untracked' as const, expired: i === list.length - 1 }))
const asUntracked = (list: AnnouncementCardData[]) => list.map((a) => ({ ...a, read: 'untracked' as const }))

function Caption({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{children}</span>
}

function Board() {
  const groups = groupAnnouncementsByTime(FEED, NOW)
  return (
    <div className="space-y-5">
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Thẻ tin — 4 trạng thái" bodyClassName="space-y-3">
          {CARDS.map((c) => (
            <div key={c.a.id} data-testid={`fx-card-${c.a.id}`} className="space-y-1.5">
              <Caption>{c.caption}</Caption>
              <AnnouncementCard a={c.a} />
            </div>
          ))}
        </Panel>
        <div className="space-y-5">
          <Panel title="Thống kê đã xem (admin)" bodyClassName="space-y-4">
            <div data-testid="fx-meter-86"><ReadMeter stats={{ kind: 'ok', read: 86, total: 120 }} /></div>
            <div data-testid="fx-store-bars" className="space-y-2.5 text-[13px]">
              <StoreReadBar name="CIRCA LUMINA" read={1} total={4} />
              <StoreReadBar name="CIRCA URBAN" read={4} total={5} />
              <StoreReadBar name="CIRCA CENTRAL" read={6} total={6} />
            </div>
          </Panel>
          <Panel title="Ảnh tải lên" bodyClassName="space-y-2">
            <div data-testid="fx-image-tiles" className="grid grid-cols-3 gap-2">
              <AnnouncementImageTile url={IMG_A} removeLabel="Xóa ảnh carousel 1" />
              <AnnouncementImageUploadingTile />
              <AnnouncementImageAddTile label="Thêm ảnh khác" />
            </div>
          </Panel>
        </div>
      </div>

      <Panel title="Thống kê đã xem — các trạng thái" bodyClassName="grid gap-3 md:grid-cols-2">
        <div data-testid="fx-meter-strip"><ReadMeter variant="strip" stats={{ kind: 'ok', read: 86, total: 120 }} unreadHref="#fx-stats" /></div>
        <div data-testid="fx-meter-zero"><ReadMeter variant="strip" stats={{ kind: 'ok', read: 0, total: 120 }} unreadHref="#fx-stats" /></div>
        <div data-testid="fx-meter-complete"><ReadMeter variant="strip" stats={{ kind: 'ok', read: 120, total: 120 }} unreadHref="#fx-stats" /></div>
        <div data-testid="fx-meter-near"><ReadMeter stats={{ kind: 'ok', read: 119, total: 120 }} /></div>
        <div data-testid="fx-meter-no-audience"><ReadMeter variant="strip" stats={{ kind: 'ok', read: 0, total: 0 }} /></div>
        <div data-testid="fx-meter-missing"><ReadMeter variant="strip" stats={{ kind: 'missing' }} /></div>
        <div data-testid="fx-meter-nan"><ReadMeter stats={{ kind: 'ok', read: 5, total: Number.NaN }} /></div>
        <div data-testid="fx-meter-error" className="md:col-span-2"><ReadMeter variant="strip" stats={{ kind: 'error' }} /></div>
      </Panel>

      <div className="grid items-start gap-5 lg:grid-cols-3">
        <Panel title="Nhóm theo thời gian" bodyClassName="space-y-2.5">
          {groups.map((g) => (
            <div key={g.key} data-testid={`fx-group-${g.key}`} className="flex items-center gap-2.5">
              <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{g.label}</span>
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
              <span className="text-[12px] text-muted-foreground tabular-nums">{g.items.length} tin</span>
            </div>
          ))}
        </Panel>
        <div data-testid="fx-state-empty"><AnnouncementsEmpty /></div>
        <div className="space-y-3">
          <div data-testid="fx-state-error"><AnnouncementsError /></div>
          <div data-testid="fx-state-read-error"><ReadStateErrorNotice /></div>
        </div>
      </div>
    </div>
  )
}

export default async function UiCatalogAnnouncementsV2Page({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'components' } = await searchParams

  if (fx.startsWith('list-')) {
    const admin = fx === 'list-admin'
    const state: AnnouncementsListState =
      fx === 'list-error' ? { kind: 'error' }
      : fx === 'list-empty' ? { kind: 'ok', items: [], reads: 'tracked' }
      : fx === 'list-read-error' ? { kind: 'ok', items: asUntracked(FEED), reads: 'error' }
      : admin ? { kind: 'ok', items: asAdmin(FEED), reads: 'untracked' }
      : fx === 'list-allread' ? { kind: 'ok', items: FEED.map((a) => ({ ...a, read: 'read' as const })), reads: 'tracked' }
      : fx === 'list-long' ? { kind: 'ok', items: [CARDS[4].a, ...FEED.slice(2)], reads: 'tracked' }
      : { kind: 'ok', items: FEED, reads: 'tracked' }
    return (
      <AnnouncementFixtureBoundary>
        <div data-testid="ui-catalog-ann-v2" data-fx={fx}>
          <AnnouncementsListView canCreate={admin} state={state} now={NOW} />
        </div>
      </AnnouncementFixtureBoundary>
    )
  }

  const body = (() => {
    if (fx === 'components') return <Board />
    const column = (node: React.ReactNode) => <div className="mx-auto max-w-3xl space-y-4">{node}</div>
    if (fx === 'feed-empty') return column(<AnnouncementsEmpty />)
    if (fx === 'feed-error') return column(<AnnouncementsError />)
    if (fx === 'feed-read-error') return column(<><ReadStateErrorNotice /><AnnouncementFeed items={asUntracked(FEED)} now={NOW} /></>)
    if (fx === 'feed-one') return column(<AnnouncementFeed items={FEED.slice(0, 1)} now={NOW} />)
    if (fx === 'feed-admin') return column(<AnnouncementFeed items={asAdmin(FEED)} now={NOW} />)
    return column(<AnnouncementFeed items={FEED} now={NOW} />)
  })()

  return (
    <AnnouncementFixtureBoundary>
      <div data-ui-v2="page" data-testid="ui-catalog-ann-v2" data-fx={fx} className="space-y-6 p-4 md:p-6">
        <PageHeader title="UI v2 · Bảng tin (B0)" subtitle="Dev-only · fixture giả 100% · phạm vi [data-ui-v2]" />
        <span id="fx-stats" className="sr-only" tabIndex={-1}>Thống kê</span>
        {body}
      </div>
    </AnnouncementFixtureBoundary>
  )
}
