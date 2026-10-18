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
import { AnnouncementDetailView, type AnnouncementDetailData } from '@/components/announcements/AnnouncementDetailView'
import { AnnouncementAdminActions } from '@/components/announcements/AnnouncementAdminActions'
import type { ReadStatsData } from '@/components/announcements/ReadStatsPanel'
import { AnnouncementFormView } from '@/components/announcements/AnnouncementFormView'
import { CreateAnnouncementForm } from '@/components/announcements/CreateAnnouncementForm'
import { editLoadDecision, type EditLoad } from '@/lib/announcements/editLoad'
import { groupAnnouncementsByTime } from '@/lib/announcements/feed'
import { buildStoreReadGroups, UNASSIGNED_STORE, type ReadMember } from '@/lib/announcements/readStats'

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
// A2 — trang chi tiết (AnnouncementDetailView + AnnouncementAdminActions THẬT trong boundary ⇒ Xóa bị chặn trước
//      confirm/action): detail-admin (16/23 đã xem, 5 cửa hàng gồm "Chưa gán cửa hàng", 2 người khác) · detail-complete
//      (23/23) · detail-zero (0 người nhận) · detail-stats-error (truy vấn thống kê lỗi) · detail-staff (dược sĩ: không
//      thống kê, không Sửa/Xóa) · detail-long (tiêu đề/nội dung dài, 5 ảnh carousel) · detail-noimage · detail-error
//      · detail-admin-other (admin không phải tác giả: thống kê có, Sửa/Xóa không)
// A3 — form tạo/sửa (AnnouncementFormView + CreateAnnouncementForm + AnnouncementImageUpload THẬT trong boundary ⇒
//      gửi form và chọn file bị chặn trước action/upload): form-new (25 cửa hàng) · form-edit (ảnh bìa + 3 carousel,
//      4/25 cửa hàng, hạn 20/10/2026) · form-stores-error (truy vấn cửa hàng lỗi) · form-edit-error (truy vấn trang
//      sửa lỗi) · form-nostores (0 cửa hàng) · form-edit-stores-error (tin THEO CỬA HÀNG + danh sách cửa hàng lỗi ⇒
//      chỉ ErrorState — R1-01) · form-edit-all-stores-error (tin TẤT CẢ + danh sách lỗi ⇒ form, chỉ "Tất cả")

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
// A2 — người nhận giả: [cửa hàng, đã xem, tổng] (thứ tự KHÔNG theo tỷ lệ để test sắp xếp của readStats).
const AUDIENCE: [string, number, number][] = [
  ['CIRCA CENTRAL', 6, 6], ['CIRCA URBAN', 4, 5], [UNASSIGNED_STORE, 0, 1], ['CIRCA MIZUKI', 5, 7], ['CIRCA LUMINA', 1, 4],
]
const NAMES = ['Võ Thị E', 'Hồ Văn F', 'Đỗ Thị H', 'Ngô Văn K', 'Lê Thị M', 'Phan Văn N', 'Trịnh Thị P']
function fxStats(allRead = false): ReadStatsData {
  const members: ReadMember[] = []
  const readMap = new Map<string, string>()
  AUDIENCE.forEach(([store, read, total], si) => {
    for (let i = 0; i < total; i++) {
      const id = `fx-u${si}-${i}`
      members.push({ id, full_name: `${NAMES[i]} (${si + 1})`, store_id: store === UNASSIGNED_STORE ? null : `fx-s${si}`, store })
      if (allRead || i < read) readMap.set(id, `2026-10-15T0${2 + (i % 7)}:${10 + si}:00Z`)
    }
  })
  const { groups, total, read } = buildStoreReadGroups(members, readMap)
  return {
    kind: 'ok', read, total, groups,
    others: [
      { user_id: 'fx-o1', full_name: 'Phạm Thị D', role: 'sm', dept: 'Vận hành', read_at: '2026-10-15T03:02:00Z' },
      { user_id: 'fx-o2', full_name: 'Lê Văn G', role: 'admin', dept: 'Nhân sự', read_at: '2026-10-15T02:41:00Z' },
    ],
  }
}
const BODY = '<p>Các cửa hàng gửi lịch trực <strong>31/12/2026 – 01/01/2027</strong> cho Quản lý vùng trước <strong>17:00 ngày 20/10</strong>. Ca trực ngày lễ được tính công x3 theo quy định nhân sự hiện hành.</p><table><thead><tr><th>Ca</th><th>Giờ</th><th>Tối thiểu</th></tr></thead><tbody><tr><td>Sáng</td><td>07:00 – 14:00</td><td>1 dược sĩ</td></tr><tr><td>Chiều</td><td>14:00 – 22:00</td><td>2 dược sĩ</td></tr></tbody></table><p>Mẫu đăng ký xem ảnh bên dưới. Quản lý cửa hàng chịu trách nhiệm tổng hợp và gửi một bản duy nhất.</p>'
const DETAIL: Extract<AnnouncementDetailData, { kind: 'ok' }> = {
  kind: 'ok', title: FEED[0].title, creatorName: 'Nguyễn Văn A', publishedAt: FEED[0].publishedAt, body: BODY,
  coverUrl: IMG_A, carousel: [IMG_B, IMG_C, img('#EAD9E6', '#B98FB0')],
}
// A3 — 25 cửa hàng giả cho bộ chọn (có dấu, để thử lọc bỏ dấu).
const FORM_STORES = ['CIRCA CENTRAL', 'CIRCA URBAN', 'CIRCA LUMINA', 'CIRCA MIZUKI', 'CIRCA SUNRISE', 'CIRCA ELANA', 'CIRCA THỐNG NHẤT',
  'CIRCA MORA', 'CIRCA SIGNATURE', 'CIRCA ÁNH DƯƠNG', 'CIRCA BÌNH THẠNH', 'CIRCA GÒ VẤP', 'CIRCA PHÚ NHUẬN', 'CIRCA TÂN BÌNH', 'CIRCA QUẬN 7',
  'CIRCA THỦ ĐỨC', 'CIRCA NHÀ BÈ', 'CIRCA HÓC MÔN', 'CIRCA CỦ CHI', 'CIRCA BÌNH CHÁNH', 'CIRCA AKARI', 'CIRCA ASTORIA', 'CIRCA ECO GREEN',
  'CIRCA BELVITA', 'CIRCA HOTCHLAND'].map((name, i) => ({ id: `fx-st${i}`, name }))
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

  if (fx.startsWith('form-')) {
    const edit = ['form-edit', 'form-edit-error', 'form-edit-stores-error', 'form-edit-all-stores-error'].includes(fx)
    const stores = fx === 'form-nostores' ? [] : FORM_STORES
    // Trạng thái trang sửa đi qua CHÍNH editLoadDecision của route (R1-01): tin gửi theo cửa hàng + danh sách cửa hàng
    // lỗi ⇒ chỉ ErrorState; tin gửi tất cả + danh sách lỗi ⇒ form, chỉ "Tất cả". form-edit-error = tải tin lỗi.
    const editVisibility: 'all' | 'stores' = fx === 'form-edit-all-stores-error' ? 'all' : 'stores'
    const load: EditLoad = !edit ? { kind: 'form', storesError: fx === 'form-stores-error' }
      : fx === 'form-edit-error' ? { kind: 'error' }
      : editLoadDecision({ aStoresErr: false, assetsErr: false, storesErr: fx.endsWith('stores-error'), visibility: editVisibility })
    return (
      <AnnouncementFixtureBoundary>
        <div data-testid="ui-catalog-ann-v2" data-fx={fx}>
          <AnnouncementFormView
            heading={edit ? 'Sửa thông báo' : 'Tạo thông báo'}
            backHref="#fx-back"
            backLabel={edit ? 'Quay lại' : 'Bảng tin'}
            error={load.kind === 'error'}
          >
            {load.kind === 'form' && <CreateAnnouncementForm
              stores={stores}
              storesError={load.storesError}
              {...(edit ? {
                mode: 'edit' as const, announcementId: 'fx-ann-1',
                initial: {
                  title: FEED[0].title, body: BODY, visibility: editVisibility,
                  storeIds: editVisibility === 'stores' ? FORM_STORES.slice(0, 4).map((s) => s.id) : [],
                  expiresAt: '2026-10-20', coverUrl: IMG_A, carouselUrls: [IMG_B, IMG_C, img('#EAD9E6', '#B98FB0')],
                },
              } : {})}
            />}
          </AnnouncementFormView>
        </div>
      </AnnouncementFixtureBoundary>
    )
  }

  if (fx.startsWith('detail-')) {
    const staff = fx === 'detail-staff'
    // detail-admin-other: admin KHÔNG phải tác giả (canManage = false) ⇒ vẫn thấy thống kê, KHÔNG Sửa/Xóa.
    const noActions = staff || fx === 'detail-admin-other'
    const data: AnnouncementDetailData =
      fx === 'detail-error' ? { kind: 'error' }
      : fx === 'detail-long' ? {
          ...DETAIL, title: LONG_TITLE,
          body: `${BODY}${BODY}<p>${'Nội dung rất dài để kiểm xuống dòng và không tràn ngang trên điện thoại. '.repeat(8)}</p>`,
          carousel: [IMG_A, IMG_B, IMG_C, img('#EAD9E6', '#B98FB0'), img('#E2E6D3', '#A9B58A')],
        }
      : fx === 'detail-noimage' ? { ...DETAIL, coverUrl: null, carousel: [], body: 'Thông báo dạng chữ thường (không HTML).\nDòng thứ hai giữ xuống dòng.' }
      : DETAIL
    const stats: ReadStatsData | null = staff || fx === 'detail-error' ? null
      : fx === 'detail-stats-error' ? { kind: 'error' }
      : fx === 'detail-zero' ? { kind: 'ok', read: 0, total: 0, groups: [], others: [] }
      : fx === 'detail-complete' ? fxStats(true)
      : fxStats()
    return (
      <AnnouncementFixtureBoundary>
        <div data-testid="ui-catalog-ann-v2" data-fx={fx}>
          <AnnouncementDetailView
            data={data}
            backHref="#fx-back"
            stats={stats}
            actions={noActions ? undefined : <AnnouncementAdminActions announcementId="fx-ann-1" editHref="#fx-edit" />}
          />
        </div>
      </AnnouncementFixtureBoundary>
    )
  }

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
