import fs from 'node:fs'
import path from 'node:path'
import { test as setup, expect } from '@playwright/test'
import { MANAGER_STATE, STAFF_STATE } from './authState'

// ─────────────────────────────────────────────────────────────────────────────
// AUTH SETUP — đăng nhập MỘT lần, dùng lại cho mọi spec cần tài khoản staff.
//
// M1.2 (audit P2): trước đây mỗi test tự login. Baseline 12 test × 2 project +
// account sheet 4 test ⇒ ~16 lần đăng nhập liên tiếp, và smoke nav bắt đầu
// timeout tại /login (rate limit phía auth). Giờ: 1 lần ở đây → `storageState`
// → mỗi test vẫn có CONTEXT RIÊNG (viewport riêng, không dùng chung state
// trong bộ nhớ), chỉ bỏ phần login lặp.
//
// e2e/staff-mobile-nav.spec.ts CỐ Ý giữ login thật: đó là coverage duy nhất còn
// lại cho chính luồng đăng nhập. Một lần login ở đó là chấp nhận được.
//
// File state nằm trong e2e/.auth/ — ĐÃ gitignore. Nó chứa cookie phiên Supabase
// còn hiệu lực, tức là credential sống, không phải fixture vô hại.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL = process.env.E2E_STAFF_EMAIL
const PASSWORD = process.env.E2E_STAFF_PASSWORD
const QLCH_EMAIL = process.env.E2E_QLCH_EMAIL
const QLCH_PASSWORD = process.env.E2E_QLCH_PASSWORD

// Kiểm host CHUNG cho mọi setup — xem lý do ở test staff bên dưới.
function assertLocalhost(baseURL: string | undefined) {
  const host = new URL(baseURL ?? 'http://localhost:3000').hostname
  expect(
    host,
    `E2E_BASE_URL đang trỏ tới "${host}". Phải dùng localhost — 127.0.0.1 không được coi là secure context tương đương nên cookie Supabase (Secure) sẽ không được gửi.`,
  ).toBe('localhost')
}

setup('đăng nhập staff một lần', async ({ page, baseURL }) => {
  setup.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD chưa set')

  // Cookie auth của Supabase đặt cờ Secure. Chromium tin http://localhost là
  // secure context nên vẫn gửi cookie; http://127.0.0.1 thì KHÔNG tương đương —
  // cookie lưu được nhưng không bao giờ được đính vào request, mọi trang authed
  // bật về /login. Fail sớm ở đây, đừng để 16 test đỏ vì một chữ trong URL.
  assertLocalhost(baseURL)

  await page.goto('/login')
  await page.fill('#email', EMAIL!)
  await page.fill('#password', PASSWORD!)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(tasks|dashboard|targets)/, { timeout: 20_000 })

  fs.mkdirSync(path.dirname(STAFF_STATE), { recursive: true })
  await page.context().storageState({ path: STAFF_STATE })
})

setup('đăng nhập QLCH một lần', async ({ page, baseURL }) => {
  setup.skip(!QLCH_EMAIL || !QLCH_PASSWORD, 'E2E_QLCH_EMAIL / E2E_QLCH_PASSWORD chưa set')
  assertLocalhost(baseURL)

  await page.goto('/login')
  await page.fill('#email', QLCH_EMAIL!)
  await page.fill('#password', QLCH_PASSWORD!)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(tasks|dashboard|targets)/, { timeout: 20_000 })

  fs.mkdirSync(path.dirname(MANAGER_STATE), { recursive: true })
  await page.context().storageState({ path: MANAGER_STATE })
})
