import { CareOrdersScreen } from '@/components/care/CareOrdersScreen'

// /care/orders/care — cohort "Khách có đơn sau chăm sóc" theo báo cáo (E3, thiết kế E0 r3.4 §8–9). Cờ UI OFF ⇒ 404.
export default async function CareOrdersCarePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <CareOrdersScreen basis="care" searchParams={await searchParams} />
}
