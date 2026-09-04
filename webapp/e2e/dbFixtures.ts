import { expect } from '@playwright/test'

// Helper đối soát DB dùng CHUNG cho các spec acceptance (không phải .spec.ts —
// Playwright cấm test file import test file khác, xem authState.ts).
//
// Một bản must() DUY NHẤT cho cả repo: đây là guard fail-closed, có hai bản
// song song thì sớm muộn một bản bị nới lỏng mà không ai thấy (P1 111.2).

// Truy vấn đối soát phải NỔ khi lỗi. Dùng `.data ?? []` thì query hỏng → mảng
// rỗng → test hiểu nhầm thành "không có fixture" rồi tự skip, báo cáo vẫn xanh.
export function must<T>(res: { data: T | null; error: { message?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what} lỗi: ${res.error.message ?? JSON.stringify(res.error)}`)
  if (res.data === null) throw new Error(`${what}: không có dữ liệu trả về`)
  return res.data
}

// Service role: BỎ QUA RLS — chỉ dùng để dựng/đọc FIXTURE (nguồn sự thật độc
// lập với app). TUYỆT ĐỐI không dùng để "chứng minh" quyền đọc của một vai
// trò: nó trả về mọi thứ nên chứng minh được cả điều sai (bài học 108.7).
export async function serviceDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  expect(Boolean(url && key), 'thiếu SUPABASE env để đối soát phạm vi').toBe(true)
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(url as string, key as string, { auth: { persistSession: false } })
}

// Đăng nhập THẬT bằng anon key + credential của vai trò ⇒ mọi truy vấn sau đó
// đi qua đúng policy RLS như app. Đây mới là cách hỏi thẳng RLS "vai trò này
// đọc được gì", thay vì suy ra từ việc UI có render hay không.
export async function sessionDb(email: string, password: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  expect(Boolean(url && anon), 'thiếu NEXT_PUBLIC_SUPABASE_* để đăng nhập kiểm RLS').toBe(true)
  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(url as string, anon as string, { auth: { persistSession: false } })
  const { error } = await sb.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`đăng nhập ${email} để kiểm RLS lỗi: ${error.message}`)
  return sb
}

export type Sb = Awaited<ReturnType<typeof serviceDb>>
