// 113.11 (audit P1#2 + item 3): cổng an toàn THUẦN cho acceptance GHI fixture
// vào DB production (kpi-order-bonus-acceptance). Tách khỏi spec để
// qa-tooling-gates.spec.ts test được mọi nhánh mà KHÔNG chạm DB.
//
// Vì sao cần: fixture phải ở trạng thái `active` (để kiểm RLS có nghĩa), mà
// cron sync-kpi-campaign-actuals nhặt MỌI campaign active, kể cả is_test. Cron
// chạy giữa phiên QA sẽ ghi actuals trước nút "Đồng bộ doanh số" hoặc ghi đè
// sau nó ⇒ test có thể xanh mà không chứng minh đúng đường thao tác.
//
// Các cờ xác nhận là biến PROCESS tạm cho TỪNG lần chạy. Đặt chúng trong
// .env.local sẽ biến lời xác nhận một lần thành mặc định vĩnh viễn ⇒ từ chối.

export const ORDER_BONUS_MARKER = '.qa-order-bonus-112.json'
export const ORDER_BONUS_NAME_PREFIX = 'QA-BONUS-112-'
export const ORDER_BONUS_PROCESS_FLAGS = [
  'E2E_ORDER_BONUS_QA', 'E2E_KPI_SYNC_CRON_PAUSED', 'E2E_EXPECTED_SUPABASE_HOST',
] as const

export type GateResult = { ok: true; host: string } | { ok: false; reason: string }

/** Hostname của một URL; null nếu không parse được. */
export function urlHost(url: string | undefined): string | null {
  if (!url) return null
  try { return new URL(url).hostname || null } catch { return null }
}

export function orderBonusWriteGate(input: {
  env: Record<string, string | undefined>
  /** Nội dung .env.local (null nếu không có file). */
  envFileText: string | null
  markerExists: boolean
}): GateResult {
  const { env, envFileText, markerExists } = input
  if (env.E2E_KPI_SYNC_CRON_PAUSED !== 'YES') {
    return {
      ok: false,
      reason: 'thiếu E2E_KPI_SYNC_CRON_PAUSED=YES — DISABLE Coolify Scheduled Task "Sync KPI campaign actuals" trước, rồi khai báo biến PROCESS tạm. Cron nhặt cả campaign is_test active, chạy giữa phiên sẽ làm test mất ý nghĩa.',
    }
  }
  if (envFileText !== null) {
    const leaked = ORDER_BONUS_PROCESS_FLAGS.filter((k) => new RegExp(`^\s*${k}\s*=`, 'm').test(envFileText))
    if (leaked.length > 0) {
      return {
        ok: false,
        reason: `${leaked.join(', ')} đang nằm trong .env.local — đây phải là biến PROCESS tạm cho từng lần chạy, xoá khỏi .env.local.`,
      }
    }
  }
  const host = urlHost(env.NEXT_PUBLIC_SUPABASE_URL)
  if (!host) return { ok: false, reason: 'NEXT_PUBLIC_SUPABASE_URL thiếu hoặc không parse được thành URL.' }
  if (env.E2E_EXPECTED_SUPABASE_HOST !== host) {
    return {
      ok: false,
      reason: `E2E_EXPECTED_SUPABASE_HOST (${env.E2E_EXPECTED_SUPABASE_HOST ?? 'THIẾU'}) phải TRÙNG host của NEXT_PUBLIC_SUPABASE_URL (${host}) — gõ lại host để xác nhận đúng project trước khi ghi.`,
    }
  }
  if (markerExists) {
    return {
      ok: false,
      reason: `marker ${ORDER_BONUS_MARKER} đang tồn tại — lần chạy trước chưa dọn xong. Xoá campaign ${ORDER_BONUS_NAME_PREFIX}* (is_test) theo tên/id trong marker, hậu kiểm 0 dòng, rồi xoá marker.`,
    }
  }
  return { ok: true, host }
}
