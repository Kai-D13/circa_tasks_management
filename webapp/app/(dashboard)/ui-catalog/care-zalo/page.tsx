import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { CareMyTaskDetail, type CareMyDetailData } from '@/components/care/CareMyTaskDetail'
import { CareMyHeader } from '@/components/care/CareMyHeader'
import { CareMyScreen } from '@/components/care/CareMyScreen'

// Dev-only bàn thử lát C (nút Zalo, Q-154) trên chi tiết khách của dược sĩ. 100% DỮ LIỆU GIẢ, không action, không DB.
// Cùng cổng /ui-catalog: UI_CATALOG=1 (Coolify không đặt ⇒ prod 404) + super. Trang riêng (không gộp vào ui-catalog/care-my)
// để không chồng lên thay đổi của E ở trang đó.
//   ?zalo=0|1 (mặc định 1) — giá trị prop `zalo` (thay cờ CARE_ZALO_LINK_ENABLED); &phone=bad ⇒ số không hợp lệ cho Zalo;
//   &qa=1 ⇒ dòng nhận biết chế độ QA. Dựng đúng bố cục trang thật (CareMyScreen + header) để test 360 / 390, sáng / tối.

const TASK = '00000000-0000-4000-8000-000000000901'
const detail = (phoneNorm: string): CareMyDetailData => ({
  task: { id: TASK, customer_name: 'KH QA Zalo 01', phone_raw: phoneNorm, phone_norm: phoneNorm, period_month: '2026-10-01', due_date: '2026-10-31',
    status: 'open', last_outcome: null, last_interaction_at: null, next_action_date: null,
    store: { code: 'QAOS01', name: 'QA store 1' }, assignee: { full_name: 'QA Dược sĩ 01a' } },
  products: [], interactions: { rows: [], hasMore: false, nextBefore: null }, events: [],
})

export default async function CareZaloCatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const sp = await searchParams
  const qa = sp.qa === '1'
  return (
    <CareMyScreen screen="detail">
      <CareMyHeader screen="detail" back={{ href: '/ui-catalog', label: 'UI catalog' }} qa={qa} />
      <CareMyTaskDetail todayISO="2026-10-10" canRecord updateHref="#" qa={qa} zalo={sp.zalo !== '0'}
        data={detail(sp.phone === 'bad' ? '0190000901' : '0390000901')} />
    </CareMyScreen>
  )
}
