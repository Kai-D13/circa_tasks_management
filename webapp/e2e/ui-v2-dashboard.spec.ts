import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'

// UI v2 P1.1 r1.1 (PM finding P1.1-R1-01): /dashboard ≥1280px xếp 2 cột (Hoạt động gần đây | Task định kỳ).
// Ở 1280px + sidebar MỞ RỘNG (232px) panel trái hẹp nhất ⇒ bảng phải vừa panel: cột Deadline nằm trong
// vùng nhìn, không tràn ngang bảng/trang — kể cả khi tiêu đề rất dài (bơm chữ test-only vào DOM, không ghi DB).
// Dưới 1280px: xếp dọc, định kỳ trước (thứ tự cũ).

const HAS_STATE = fs.existsSync(SUPER_STATE)
const LONG = 'Tiêu đề kiểm tra rất dài cho bảng hoạt động gần đây ' + 'X'.repeat(48) + ' ' + 'chữ dài '.repeat(14)

async function open(page: Page, width: number, theme: 'light' | 'dark', baseURL: string) {
  await page.setViewportSize({ width, height: 900 })
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
  await page.goto('/dashboard')
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme)
  await page.getByRole('heading', { level: 1, name: 'Tổng quan' }).waitFor()
}

const recent = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: 'Hoạt động gần đây' }) })
const recurring = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: 'Task định kỳ' }) })

async function assertTableFits(page: Page) {
  const panel = recent(page)
  const container = panel.locator('[data-slot="table-container"]')
  await container.waitFor()
  // Bơm tiêu đề dài vào ô tiêu đề đầu tiên (nếu có dòng) — chỉ DOM, đo bố cục xấu nhất.
  await panel.locator('tbody tr td:first-child').first().evaluate((td, text) => {
    const target = td.querySelector('a, div') ?? td
    target.textContent = text
  }, LONG).catch(() => {})
  const m = await container.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const ths = el.querySelectorAll('thead th')
    const last = ths[ths.length - 1].getBoundingClientRect()
    const main = document.querySelector('main')!
    return {
      scrollW: el.scrollWidth, clientW: el.clientWidth, right: box.right, lastRight: last.right,
      lastLabel: ths[ths.length - 1].textContent, mainScrollW: main.scrollWidth, mainClientW: main.clientWidth,
    }
  })
  expect(m.lastLabel).toBe('Deadline')
  expect(m.scrollW, 'bảng tràn ngang trong panel').toBeLessThanOrEqual(m.clientW + 1)
  expect(m.lastRight, 'cột Deadline nằm ngoài vùng nhìn').toBeLessThanOrEqual(m.right + 1)
  expect(m.mainScrollW, 'trang tràn ngang').toBeLessThanOrEqual(m.mainClientW + 1)
}

test.describe('ui v2 /dashboard bố cục @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const theme of ['light', 'dark'] as const) {
    test(`1280 sidebar mở rộng — 2 cột, bảng vừa panel (${theme})`, async ({ page }, info) => {
      await open(page, 1280, theme, info.project.use.baseURL!)
      const aside = await page.locator('aside.bg-sidebar').first().boundingBox()
      expect(aside!.width, 'sidebar phải đang mở rộng').toBeGreaterThan(200)
      if (await recurring(page).count()) {
        const r = await recent(page).boundingBox()
        const s = await recurring(page).boundingBox()
        expect(Math.abs(r!.y - s!.y), '≥1280px: 2 panel cùng hàng').toBeLessThan(2)
        expect(s!.x, 'Task định kỳ bên phải').toBeGreaterThan(r!.x)
      }
      await assertTableFits(page)
    })
  }

  test('1366 — 2 cột, bảng vừa panel', async ({ page }, info) => {
    await open(page, 1366, 'light', info.project.use.baseURL!)
    await assertTableFits(page)
  })

  test('1200 (<1280) — xếp dọc, định kỳ trước, bảng vừa panel', async ({ page }, info) => {
    await open(page, 1200, 'light', info.project.use.baseURL!)
    if (await recurring(page).count()) {
      const r = await recent(page).boundingBox()
      const s = await recurring(page).boundingBox()
      expect(s!.y + s!.height, '<1280px: định kỳ nằm TRÊN hoạt động gần đây').toBeLessThanOrEqual(r!.y + 1)
    }
    await assertTableFits(page)
  })
})
