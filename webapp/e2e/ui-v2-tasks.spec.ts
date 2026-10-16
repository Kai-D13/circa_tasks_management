import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { STAFF_STATE, SUPER_STATE } from './authState'

// UI v2 P1.2 /tasks — bố cục + quy ước v2 đo bằng computed style. KHÔNG có nhánh bỏ qua theo dữ liệu
// (PM audit P1.1): thiếu bảng/thẻ hay không bơm được tiêu đề dài ⇒ FAIL. Tiêu đề dài chỉ bơm vào DOM
// (test-only, không ghi DB) để đo ca xấu nhất.

const LONG = 'Tiêu đề kiểm tra rất dài ' + 'X'.repeat(48) + ' ' + 'chữ dài '.repeat(14)

async function open(page: Page, width: number, theme: 'light' | 'dark', baseURL: string, height = 900) {
  await page.setViewportSize({ width, height })
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
  await page.goto('/tasks')
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme)
  await page.getByRole('heading', { level: 1, name: 'Danh sách Tasks' }).waitFor()
}

// Tab đang chọn phải TRUNG TÍNH (nền panel), không phải màu hành động.
async function assertNeutralTab(page: Page) {
  await expect(page.locator('main [data-ui-v2="page"]'), 'trang /tasks phải gắn data-ui-v2="page"').toHaveCount(1, { timeout: 5_000 })
  const active = page.locator('button[aria-pressed="true"]', { hasText: 'Chờ thực hiện' })
  await expect(active).toHaveCount(1)
  const [bg, actionBg] = await Promise.all([
    active.evaluate((el) => getComputedStyle(el).backgroundColor),
    page.locator('main [data-ui-v2]').first().evaluate((el) => {
      const probe = document.createElement('span'); probe.className = 'bg-primary'; el.appendChild(probe)
      const c = getComputedStyle(probe).backgroundColor; probe.remove(); return c
    }),
  ])
  expect(bg, 'tab đang chọn không được dùng màu hành động').not.toBe(actionBg)
}

test.describe('ui v2 /tasks — admin desktop @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [1366, 'light']] as const) {
    test(`${width} sidebar mở rộng (${theme}) — bảng vừa khung, cột cuối trong vùng nhìn`, async ({ page }, info) => {
      await open(page, width, theme, info.project.use.baseURL!)
      expect((await page.locator('aside.bg-sidebar').first().boundingBox())!.width, 'sidebar phải mở rộng').toBeGreaterThan(200)
      const container = page.locator('main [data-slot="table-container"]').first()
      await expect(container, 'phải có bảng task (dữ liệu prod luôn có task đang mở)').toBeVisible()
      // Ô tiêu đề đầu tiên (sau ô chọn): dòng task đơn = <a>, dòng nhóm = <span>/<a> trong khối flex.
      const injected = await container.locator('tbody tr').first().evaluate((tr, text) => {
        const cells = Array.from(tr.querySelectorAll('td'))
        const titleCell = cells.find((td) => td.querySelector('a, span') && !td.querySelector('input')) ?? null
        const target = titleCell?.querySelector('a, span')
        if (!target) return false
        target.textContent = text
        return true
      }, LONG)
      expect(injected, 'không bơm được tiêu đề dài').toBe(true)
      const m = await container.evaluate((el) => {
        const ths = el.querySelectorAll('thead th')
        const last = ths[ths.length - 1]
        const main = document.querySelector('main')!
        return {
          scrollW: el.scrollWidth, clientW: el.clientWidth, right: el.getBoundingClientRect().right,
          lastRight: last.getBoundingClientRect().right, lastLabel: last.textContent?.trim(),
          mainScrollW: main.scrollWidth, mainClientW: main.clientWidth,
        }
      })
      expect(m.lastLabel).toBe('Ngày tạo')
      expect(m.scrollW, 'bảng tràn ngang').toBeLessThanOrEqual(m.clientW + 1)
      expect(m.lastRight, 'cột Ngày tạo ngoài vùng nhìn').toBeLessThanOrEqual(m.right + 1)
      expect(m.mainScrollW, 'trang tràn ngang').toBeLessThanOrEqual(m.mainClientW + 1)
      // P1.2 r1.1: mọi tên nhóm (dữ liệu thật) có đủ VÙNG để hiển thị — trước đó tag cùng hàng ép tên còn
      // 1 ký tự/dòng. Đo VÙNG (mép trái tên → mép trái phần tử kế tiếp cùng hàng, hoặc mép phải hàng flex),
      // không đo bề rộng chữ (tên ngắn vốn hẹp).
      const titleWidths = await container.locator('tr[data-group-type] [data-group-title]').evaluateAll(
        (els) => els.map((el) => {
          const next = el.nextElementSibling
          const right = next ? next.getBoundingClientRect().left : el.parentElement!.getBoundingClientRect().right
          return right - el.getBoundingClientRect().left
        }))
      expect(titleWidths.length, 'phải có dòng nhóm (admin luôn có broadcast đang mở)').toBeGreaterThan(0)
      for (const w of titleWidths) expect(w, 'tên nhóm bị ép hẹp').toBeGreaterThanOrEqual(140)
      await assertNeutralTab(page)
      // Panel bảng = 12px (v2)
      const radius = await page.locator('main [data-slot="card"]').first().evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))
      expect(radius).toBe(12)
    })
  }
})

test.describe('ui v2 /tasks — dược sĩ mobile @mobile', () => {
  test.skip(!fs.existsSync(STAFF_STATE), 'chưa có phiên staff')
  test.use({ storageState: STAFF_STATE })

  test('thẻ task vừa màn, tab 44px trung tính, thẻ 12px', async ({ page }, info) => {
    const vp = page.viewportSize()!
    await open(page, vp.width, 'light', info.project.use.baseURL!, vp.height)
    for (const name of ['Chờ thực hiện', 'Hoàn thành']) {
      const h = (await page.getByRole('button', { name, exact: true }).boundingBox())!.height
      expect(h, `tab ${name} ≥44px`).toBeGreaterThanOrEqual(44)
    }
    const card = page.locator('main a[href^="/tasks/"]').filter({ has: page.locator('span.line-clamp-2') }).first()
    await expect(card, 'phải có thẻ task (tài khoản QA staff có task)').toBeVisible()
    await card.locator('span.line-clamp-2').evaluate((el, text) => { el.textContent = text }, LONG)
    expect(await card.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBe(12)
    const m = await page.locator('main').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(m.sw, 'trang tràn ngang trên mobile').toBeLessThanOrEqual(m.cw + 1)
    const cardBox = (await card.boundingBox())!
    expect(cardBox.x + cardBox.width, 'thẻ vượt mép phải màn hình').toBeLessThanOrEqual(vp.width + 1)
    await assertNeutralTab(page)
  })
})
