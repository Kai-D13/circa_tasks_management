import fs from 'node:fs'
import path from 'node:path'
import { test as setup, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'

// ─────────────────────────────────────────────────────────────────────────────
// AUTH SETUP — đăng nhập MỘT lần, dùng lại cho mọi spec cần tài khoản.
//
// M1.2 (audit P2): trước đây mỗi test tự login. Baseline 12 test × 2 project +
// account sheet 4 test ⇒ ~16 lần đăng nhập liên tiếp, và smoke nav bắt đầu
// timeout tại /login (rate limit phía auth). Giờ: 1 lần ở đây → `storageState`
// → mỗi test vẫn có CONTEXT RIÊNG (viewport riêng), chỉ bỏ phần login lặp.
//
// Step 5.0 (audit P1): bản trước VẪN login mỗi lần project `setup` chạy rồi ghi
// đè state — nghĩa là "dùng lại state" chỉ đúng trong PHẠM VI một lần chạy, còn
// chạy lại suite là login lại. Chạy đi chạy lại nhiều vòng trong một phiên đã
// làm auth từ chối đăng nhập thật (rate limit). Giờ setup TỰ BỎ QUA khi state
// còn hiệu lực, nên chạy lại bao nhiêu lần cũng không sinh thêm login.
//
// e2e/staff-mobile-nav.spec.ts CỐ Ý giữ login thật: đó là coverage duy nhất còn
// lại cho chính luồng đăng nhập.
//
// File state nằm trong e2e/.auth/ — ĐÃ gitignore. Nó chứa cookie phiên Supabase
// còn hiệu lực, tức là credential sống, không phải fixture vô hại.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const QLCH = { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD }
const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }
const SM = { email: process.env.E2E_SM_EMAIL, password: process.env.E2E_SM_PASSWORD }

// Còn ít nhất 5 phút thì coi là dùng được — đủ để chạy hết một suite mà không
// rơi vào ca "hết hạn giữa chừng".
const MIN_TTL_SECONDS = 300

// State còn dùng được không? Đọc THẲNG cookie phiên Supabase (`sb-*`) thay vì
// chỉ kiểm file tồn tại: file cũ với cookie đã hết hạn còn tệ hơn không có file
// — mọi test sẽ đỏ ở chỗ khác với thông báo khó lần.
function stateIsFresh(file: string): boolean {
  if (!fs.existsSync(file)) return false
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      cookies?: { name: string; expires: number }[]
    }
    const now = Date.now() / 1000
    return (raw.cookies ?? []).some(
      (c) => c.name.startsWith('sb-') && (c.expires === -1 || c.expires > now + MIN_TTL_SECONDS),
    )
  } catch {
    return false
  }
}

// Kiểm host CHUNG cho mọi setup: cookie auth của Supabase đặt cờ Secure.
// Chromium tin http://localhost là secure context nên vẫn gửi cookie;
// http://127.0.0.1 thì KHÔNG tương đương — cookie lưu được nhưng không bao giờ
// được đính vào request, mọi trang authed bật về /login. Fail sớm ở đây, đừng
// để cả suite đỏ vì một chữ trong URL.
function assertLocalhost(baseURL: string | undefined) {
  const host = new URL(baseURL ?? 'http://localhost:3000').hostname
  expect(
    host,
    `E2E_BASE_URL đang trỏ tới "${host}". Phải dùng localhost — 127.0.0.1 không được coi là secure context tương đương nên cookie Supabase (Secure) sẽ không được gửi.`,
  ).toBe('localhost')
}

async function login(page: Page, email: string, password: string, file: string) {
  await page.goto('/login')
  await page.fill('#email', email)
  await page.fill('#password', password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 20_000 })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await page.context().storageState({ path: file })
}

setup('đăng nhập staff một lần', async ({ page, baseURL }) => {
  setup.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD chưa set')
  setup.skip(stateIsFresh(STAFF_STATE), 'storageState staff còn hiệu lực — không login lại')
  assertLocalhost(baseURL)
  await login(page, STAFF.email!, STAFF.password!, STAFF_STATE)
})

setup('đăng nhập QLCH một lần', async ({ page, baseURL }) => {
  setup.skip(!QLCH.email || !QLCH.password, 'E2E_QLCH_EMAIL / E2E_QLCH_PASSWORD chưa set')
  setup.skip(stateIsFresh(MANAGER_STATE), 'storageState QLCH còn hiệu lực — không login lại')
  assertLocalhost(baseURL)
  await login(page, QLCH.email!, QLCH.password!, MANAGER_STATE)
})

setup('đăng nhập Super Admin một lần', async ({ page, baseURL }) => {
  setup.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_EMAIL / E2E_SUPER_PASSWORD chưa set')
  setup.skip(stateIsFresh(SUPER_STATE), 'storageState super còn hiệu lực — không login lại')
  assertLocalhost(baseURL)
  await login(page, SUPER.email!, SUPER.password!, SUPER_STATE)
})

setup('đăng nhập SM một lần', async ({ page, baseURL }) => {
  setup.skip(!SM.email || !SM.password, 'E2E_SM_EMAIL / E2E_SM_PASSWORD chưa set')
  setup.skip(stateIsFresh(SM_STATE), 'storageState SM còn hiệu lực — không login lại')
  assertLocalhost(baseURL)
  await login(page, SM.email!, SM.password!, SM_STATE)
})
