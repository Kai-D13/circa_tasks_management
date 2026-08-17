// Contract THUẦN cho bộ lọc khoảng ngày của campaign (17/08).
//
// Lọc chỉ là CHẾ ĐỘ XEM: không ghi DB, không đụng cron, và tuyệt đối không suy
// lại tier/commission — phần thưởng luôn tính trên toàn kỳ. Mọi quyết định
// parse/validate nằm ở đây để test khoá; page + component chỉ tiêu thụ.

import { metricPresentation } from '@/lib/kpi/campaignDisplay'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// Campaign "Số khách Affiliate" KHÔNG hỗ trợ lọc khoảng.
// Số khách dedup theo account trên TOÀN chiến dịch (một khách nhiều đơn vẫn là
// một khách), nên cộng dồn `affiliate_customer_count` theo ngày sẽ đếm trùng.
// Lọc đúng nghĩa buộc phải gọi lại rpc_aggregate_affiliate_customers — RPC
// service-role mà cron dùng, quét lại đơn Affiliate trong range — quá đắt để
// chạy mỗi lần render. Chốt 17/08: ẩn filter cho loại này.
export function rangeFilterSupported(metricType?: string | null): boolean {
  return metricPresentation(metricType).kind !== 'affiliate_customer_count'
}

export type CampaignRangeError =
  | 'incomplete'      // chỉ có một đầu ngày
  | 'malformed'       // không phải YYYY-MM-DD hoặc không phải ngày thật
  | 'reversed'        // from > to
  | 'outside'         // vượt ra ngoài kỳ campaign
  | 'unsupported'     // loại campaign không hỗ trợ lọc

export interface CampaignRange {
  active: boolean               // false ⇒ dùng snapshot toàn kỳ như cũ
  from: string | null
  to: string | null
  days: number                  // số ngày inclusive; 0 khi không active
  error: CampaignRangeError | null
}

const NO_RANGE: CampaignRange = { active: false, from: null, to: null, days: 0, error: null }

// Ngày THẬT, không chỉ đúng hình dạng: '2026-13-99' khớp regex nhưng không tồn
// tại (bẫy đã gặp ở mig 106) ⇒ so lại chuỗi sau round-trip.
function isRealDate(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false
  const d = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso
}

function daysInclusive(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.floor(ms / 86_400_000) + 1
}

export function parseCampaignRange(p: {
  from?: string | null
  to?: string | null
  campaignStart: string
  campaignEnd: string
  metricType?: string | null
}): CampaignRange {
  const from = p.from?.trim() || null
  const to = p.to?.trim() || null

  if (!from && !to) return NO_RANGE
  if (!rangeFilterSupported(p.metricType)) return { ...NO_RANGE, error: 'unsupported' }
  // Một đầu thiếu là lỗi NHÌN THẤY ĐƯỢC, không tự suy đầu còn lại: đoán hộ ở
  // màn tiền dễ cho ra một khoảng người dùng không hề chọn.
  if (!from || !to) return { ...NO_RANGE, from, to, error: 'incomplete' }
  if (!isRealDate(from) || !isRealDate(to)) return { ...NO_RANGE, from, to, error: 'malformed' }
  if (from > to) return { ...NO_RANGE, from, to, error: 'reversed' }
  if (from < p.campaignStart || to > p.campaignEnd) {
    // KHÔNG clamp âm thầm về biên kỳ — người dùng phải thấy mình chọn sai,
    // nếu không họ đọc một con số của khoảng khác với khoảng đang gõ.
    return { ...NO_RANGE, from, to, error: 'outside' }
  }

  // Trọn kỳ ⇒ coi như KHÔNG lọc: đi đúng đường snapshot cũ, không có cơ hội
  // lệch số so với bản đang chạy.
  if (from === p.campaignStart && to === p.campaignEnd) return NO_RANGE

  return { active: true, from, to, days: daysInclusive(from, to), error: null }
}

export const CAMPAIGN_RANGE_ERROR_TEXT: Record<CampaignRangeError, string> = {
  incomplete: 'Chọn đủ cả hai mốc: Từ ngày và Đến ngày.',
  malformed: 'Ngày không hợp lệ.',
  reversed: 'Từ ngày phải trước hoặc bằng Đến ngày.',
  outside: 'Khoảng ngày phải nằm trong thời gian chiến dịch.',
  unsupported: 'Chiến dịch Số khách Affiliate không lọc theo khoảng ngày (mỗi khách chỉ tính một lần cho cả kỳ).',
}

// Giữ nguyên các query param hiện có khi dựng URL filter — `campaign`,
// `series`, `store`, `tab` đều là contract đang chạy, mất một cái là gãy màn.
export function withRangeParams(
  base: Record<string, string | undefined>,
  range: { from?: string | null; to?: string | null },
): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(base)) if (v) sp.set(k, v)
  if (range.from) sp.set('from', range.from); else sp.delete('from')
  if (range.to) sp.set('to', range.to); else sp.delete('to')
  const q = sp.toString()
  return q ? `?${q}` : ''
}
