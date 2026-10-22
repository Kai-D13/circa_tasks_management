import { CareOrdersScreen } from '@/components/care/CareOrdersScreen'

// /care/orders — "Đơn xác thực sau import" (E3, thiết kế E0 r3.4 §9). Cờ CARE_ORDER_LINKS_UI_ENABLED OFF ⇒ 404.
export default async function CareOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <CareOrdersScreen basis="import" searchParams={await searchParams} />
}
