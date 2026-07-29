'use server'

import { createClient } from '@/lib/supabase/server'
import { isKpiAffiliateEnabled, isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { vnDayRange } from '@/lib/kpi/engine'
import { sanitizeOpsText } from '@/lib/ops/sanitize'
import {
  ORDERS_PAGE_SIZE, nextCursorFrom, validOrdersRange,
  type AffiliateOrderRow, type OrdersCursor,
} from '@/lib/affiliate/orders'

// Drill-down đơn Affiliate (contract 28/07): đọc qua SESSION client →
// rpc_list_affiliate_orders (mig 099) — RPC tự authz theo auth.uid() trong DB
// (Super mọi store · OPS admin OS-all · SM OS-assigned · QLCH OS-own · Staff
// từ chối). TUYỆT ĐỐI không supabaseAdmin ở đây: authz nằm trong DB là
// boundary cuối, app không tự nới scope được. Server action = POST, response
// không cache (tương đương private/no-store). KHÔNG gọi Mongo, KHÔNG sync.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function listAffiliateOrders(input: {
  storeId: string
  from: string   // YYYY-MM-DD (ngày VN — cùng parse với trang overview)
  to: string
  cursor?: OrdersCursor | null
}): Promise<{ rows: AffiliateOrderRow[]; nextCursor: OrdersCursor | null } | { error: string }> {
  if (!(isKpiCampaignEnabled() && isKpiAffiliateEnabled())) {
    return { error: 'Tính năng Affiliate chưa được bật' }
  }
  if (!UUID_RE.test(input.storeId ?? '')) return { error: 'Cửa hàng không hợp lệ' }
  if (!DATE_RE.test(input.from ?? '') || !DATE_RE.test(input.to ?? '')) {
    return { error: 'Khoảng ngày không hợp lệ' }
  }
  // r1 (audit P2#3): ngày LỊCH thật + from ≤ to + span ≤366 ngày — regex không
  // đủ (2026-02-31 lọt); RPC 099 có guard tương đương trong DB (2 lớp).
  const range0 = validOrdersRange(input.from, input.to)
  if (!range0.ok) return { error: range0.reason }
  const cursor = input.cursor ?? null
  if (cursor && !UUID_RE.test(cursor.id)) return { error: 'Cursor không hợp lệ' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Chưa đăng nhập' }

  // Cùng date basis với parent: vnDayRange → [from 00:00 VN, ngày-sau-to 00:00
  // VN) trên completed_time — child đối soát được tuyệt đối với aggregate.
  const range = vnDayRange(input.from, input.to)
  const { data, error } = await supabase.rpc('rpc_list_affiliate_orders', {
    p_store_id: input.storeId,
    p_from: range.from,
    p_to: range.to,
    p_limit: ORDERS_PAGE_SIZE,
    p_cursor_completed_time: cursor?.completedTime ?? null,
    p_cursor_id: cursor?.id ?? null,
  })
  if (error) return { error: sanitizeOpsText(error.message) }
  const rows = (data ?? []) as AffiliateOrderRow[]
  return { rows, nextCursor: nextCursorFrom(rows, ORDERS_PAGE_SIZE) }
}
