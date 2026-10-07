import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { isSuperAdminEmail } from '../lib/authz'
import { resolveEnv } from './envLocal'

// CRM-CSKH B0 (SPEC B0 mục 6) — preflight tài khoản QA Marketing.
//
// Mục đích: trước khi B1–B4 dựa vào E2E_MKT_ADMIN_* để kiểm quyền import/phân
// công, xác nhận tài khoản đó THẬT SỰ là `role='admin'` thuộc phòng Marketing
// và KHÔNG nằm trong allowlist super (một super sẽ qua mọi cổng ⇒ test quyền
// xanh giả).
//
// Chạy trên PowerShell, không cần source .env.local:
//   cd webapp; npx playwright test e2e/care-qa-preflight.spec.ts --project=desktop-chromium
// Credential đọc qua e2e/envLocal.ts (process env > .env.local). Thiếu biến ⇒
// skip, lý do chỉ nêu TÊN biến. Không in email/mật khẩu/token ở bất kỳ đâu;
// thông điệp lỗi chỉ nói đạt/không đạt.
//
// Chỉ ĐỌC (đăng nhập bằng anon key + đọc hồ sơ chính mình qua RLS), không ghi
// DB ⇒ không cần writeQaGates. Không cần dev server.

// Q-22 (DECISIONS): phòng Marketing được import/phân công ban đầu. Hằng số ở
// test để preflight, KHÔNG phải cổng quyền trong logic (B1 dùng care_access).
const MARKETING_DEPARTMENT_ID = '80cb84b5-da69-46e3-b0e5-1de3d31b93c3'

const KEYS = [
  'E2E_MKT_ADMIN_EMAIL', 'E2E_MKT_ADMIN_PASSWORD',
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
] as const

test.describe('care QA preflight — tài khoản Marketing @desktop', () => {
  test('E2E_MKT_ADMIN là admin phòng Marketing, không phải super admin', async () => {
    const { values, missing } = resolveEnv(KEYS)
    test.skip(missing.length > 0, `thiếu biến: ${missing.join(', ')} (process env hoặc webapp/.env.local)`)

    const email = values.E2E_MKT_ADMIN_EMAIL!
    expect(isSuperAdminEmail(email), 'tài khoản Marketing nằm trong allowlist super — test quyền sẽ xanh giả').toBe(false)

    const sb = createClient(values.NEXT_PUBLIC_SUPABASE_URL!, values.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    // Retry CHỈ lỗi mạng (AuthRetryableFetchError, status 0): full suite chạy
    // song song làm Supabase self-host chậm/đứt kết nối tạm thời (đo 07/10).
    // Sai credential (AuthApiError 400) không retry ⇒ vẫn đỏ ngay.
    let attempt = 0
    let res = await sb.auth.signInWithPassword({ email, password: values.E2E_MKT_ADMIN_PASSWORD! })
    while (res.error?.name === 'AuthRetryableFetchError' && ++attempt < 3) {
      await new Promise((r) => setTimeout(r, 2_000 * attempt))
      res = await sb.auth.signInWithPassword({ email, password: values.E2E_MKT_ADMIN_PASSWORD! })
    }
    const { data: auth, error: authErr } = res
    // Chỉ so sánh boolean để thông điệp lỗi không chứa dữ liệu tài khoản. Tên
    // lớp lỗi + status (vd AuthRetryableFetchError/0 = mạng, AuthApiError/400 =
    // sai credential) đủ để phân loại mà không lộ gì.
    expect(
      authErr === null && !!auth.user,
      `đăng nhập Marketing không đạt (${authErr?.name ?? '-'}/${authErr?.status ?? '-'})`,
    ).toBe(true)

    try {
      const { data: me, error } = await sb
        .from('users')
        .select('role, department_id')
        .eq('id', auth.user!.id)
        .single()
      expect(error === null && !!me, 'đọc hồ sơ users của chính mình không đạt').toBe(true)
      expect(me!.role === 'admin', 'role phải là admin').toBe(true)
      expect(me!.department_id === MARKETING_DEPARTMENT_ID, 'department_id phải là phòng Marketing (Q-22)').toBe(true)

      const { data: dept } = await sb.from('departments').select('name').eq('id', MARKETING_DEPARTMENT_ID).single()
      expect(/marketing/i.test(dept?.name ?? ''), 'bản ghi phòng Marketing không tồn tại/đổi tên').toBe(true)
    } finally {
      // 'local': chỉ thu hồi phiên vừa tạo, không đá các phiên khác của tài khoản.
      await sb.auth.signOut({ scope: 'local' })
    }
  })
})
