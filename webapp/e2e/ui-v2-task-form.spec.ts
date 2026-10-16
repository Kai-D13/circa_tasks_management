import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'

// UI v2 P1.4 /tasks/new + /tasks/[id]/edit — bố cục + quy ước v2 trên route THẬT. Chỉ đổi state cục bộ của
// form (phạm vi, cách nộp, loại task, chip output, mở/đóng overlay); KHÔNG bấm Tạo/Cập nhật. Không có nhánh
// bỏ qua theo dữ liệu: thiếu cửa hàng/task ⇒ FAIL.

const taskId = (href: string | null) => href?.match(/^\/tasks\/([0-9a-f-]{36})(?:$|[/?#])/)?.[1] ?? null
const btn = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).first()

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme)
}

const bg = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor)

// Panel 12px; không panel nào bị cắt nội dung (lỗi đã gặp: cột trái flex-col làm panel flush co lại).
async function assertPanels(page: Page) {
  await expect(page.locator('main [data-ui-v2="page"]'), 'form phải gắn data-ui-v2="page"').toHaveCount(1)
  const panels = await page.locator('main [data-ui-v2] section.border').evaluateAll((els) => els.map((el) => ({
    r: parseFloat(getComputedStyle(el).borderTopLeftRadius), ch: el.clientHeight, sh: el.scrollHeight,
  })))
  expect(panels.length, 'phải có panel').toBeGreaterThanOrEqual(3)
  for (const p of panels) {
    expect(p.r).toBe(12)
    expect(p.ch, 'panel bị co, cắt nội dung').toBeGreaterThanOrEqual(p.sh - 1)
  }
  const m = await page.locator('main').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
  expect(m.sw, 'form tràn ngang').toBeLessThanOrEqual(m.cw + 1)
}

// Một dòng chữ (không bị ép xuống dòng) — đếm số hàng của các hộp chữ.
const lineCount = (page: Page, name: string, scope = 'main') =>
  page.locator(scope).getByRole('button', { name, exact: true }).first().evaluate((el) => {
    const r = document.createRange(); r.selectNodeContents(el)
    return new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size
  })

async function chooseMultiStores(page: Page, n: number) {
  await expect(async () => {
    await btn(page, 'Nhiều CH').click()
    await expect(page.locator('main').getByText(/^Chọn cửa hàng \(\d+ đã chọn\)$/)).toBeVisible({ timeout: 1_000 })
  }, 'không chuyển được sang Nhiều CH (hydrate?)').toPass({ timeout: 15_000 })
  const boxes = page.locator('main label input[type="checkbox"]')
  expect(await boxes.count(), 'phải có ít nhất 2 cửa hàng để chọn').toBeGreaterThanOrEqual(n)
  for (let i = 0; i < n; i++) await boxes.nth(i).check()
  await expect(page.locator('main').getByText(`Chọn cửa hàng (${n} đã chọn)`)).toBeVisible()
}

test.describe('ui v2 form task — admin desktop @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const theme of ['light', 'dark'] as const) {
    test(`tạo mới 1280 sidebar mở (${theme}) — header 64/36px, panel 12px, cấu hình 360px, segmented trung tính`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: info.project.use.baseURL! }])
      await page.goto('/tasks/new')
      await setTheme(page, theme)
      const h1 = page.locator('main h1').first()
      await expect(h1).toHaveText('Tạo task mới')
      expect(await h1.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(18)
      const header = (await h1.evaluate((el) => el.parentElement!.getBoundingClientRect().height))
      expect(header).toBeCloseTo(64, 0)
      const vw = page.viewportSize()!.width
      for (const name of ['Huỷ', 'Tạo Task']) {
        const b = (await btn(page, name).boundingBox())!
        expect(b.height, `nút ${name} 36px`).toBeCloseTo(36, 0)
        expect(b.x + b.width, `nút ${name} ngoài khung`).toBeLessThanOrEqual(vw + 1)
      }
      const cfg = (await page.locator('main [data-task-config]').boundingBox())!
      expect(cfg.width).toBeCloseTo(360, 0)
      expect(cfg.x + cfg.width).toBeLessThanOrEqual(vw + 1)
      // Đang chọn = nền panel (trung tính), KHÔNG phải cam hành động của nút Tạo
      const action = await bg(page, 'main button[type="submit"]')
      expect(await btn(page, 'Một CH').getAttribute('aria-pressed')).toBe('true')
      expect(await bg(page, 'main button[aria-pressed="true"]')).not.toBe(action)
      for (const name of ['Một CH', 'Nhiều CH', 'Cửa hàng nộp', 'Từng dược sĩ nộp', 'Phát sinh', 'Định kỳ']) {
        expect(await lineCount(page, name), `"${name}" bị xuống dòng`).toBe(1)
      }
      await assertPanels(page)
    })
  }

  test('Nhiều CH + từng dược sĩ: panel tiêu đề/mô tả/đính kèm KHÔNG bị co (editor ≥ 180px)', async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: info.project.use.baseURL! }])
    await page.goto('/tasks/new')
    await page.locator('main h1').first().waitFor()
    await chooseMultiStores(page, 2)
    await assertPanels(page)
    await btn(page, 'Từng dược sĩ nộp').click()
    await expect(btn(page, 'Từng dược sĩ nộp')).toHaveAttribute('aria-pressed', 'true')
    const editor = page.locator('main .ProseMirror')
    await expect(editor).toBeVisible()
    expect((await editor.boundingBox())!.height, 'editor bị co').toBeGreaterThanOrEqual(179)
    await assertPanels(page)
  })

  test('chip output bật/tắt bằng aria-pressed, nền đang bật ≠ cam hành động', async ({ page }) => {
    await page.goto('/tasks/new')
    await page.locator('main h1').first().waitFor()
    const chip = page.locator('main [data-task-config]').getByRole('button', { name: 'Ghi chú', exact: true })
    // Bật (mặc định theo danh mục có thể đã bật) → đo nền → tắt
    await expect(async () => {
      if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click()
      await expect(chip).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    const onBg = await chip.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(onBg, 'chip đang bật phải có nền chọn').not.toBe('rgba(0, 0, 0, 0)')
    expect(onBg, 'chip đang bật không dùng cam hành động').not.toBe(await bg(page, 'main button[type="submit"]'))
    await chip.click()
    await expect(chip).toHaveAttribute('aria-pressed', 'false')
  })

  test('sửa task — không có hàng phạm vi, tiêu đề có sẵn, nút Cập nhật, panel 12px', async ({ page }) => {
    let id: string | null = null
    for (const url of ['/tasks', '/tasks?view=done']) {
      await page.goto(url)
      await page.locator('main h1').first().waitFor()
      await page.waitForLoadState('networkidle')
      const hrefs = await page.locator('main a[href^="/tasks/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))
      id = hrefs.map(taskId).find(Boolean) ?? null
      if (id) break
    }
    expect(id, 'không tìm được task nào (tab Chờ, Hoàn thành) để mở form sửa').not.toBeNull()
    await page.goto(`/tasks/${id}/edit`)
    await expect(page.locator('main h1').first()).toHaveText('Chỉnh sửa Task')
    await expect(btn(page, 'Nhiều CH')).toHaveCount(0)
    await expect(btn(page, 'Cập nhật')).toBeVisible()
    expect(await page.locator('main').getByPlaceholder('Tiêu đề task...').filter({ visible: true }).inputValue()).not.toBe('')
    await assertPanels(page)
  })
})

test.describe('ui v2 form task — admin mobile @mobile', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('header 2 hàng không cắt tiêu đề, nút 44px, segmented 1 dòng, overlay cấu hình', async ({ page }) => {
    await page.goto('/tasks/new')
    const h1 = page.locator('main h1').first()
    await expect(h1).toHaveText('Tạo task mới')
    const vw = page.viewportSize()!.width
    const t = await h1.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ov: getComputedStyle(el).textOverflow }))
    expect(t.ov).not.toBe('ellipsis')
    expect(t.sw, 'tiêu đề bị cắt').toBeLessThanOrEqual(t.cw + 1)
    for (const name of ['Cấu hình task', 'Huỷ', 'Tạo Task']) {
      const b = (await page.getByRole('button', { name, exact: true }).first().boundingBox())!
      expect(b.height, `nút ${name} 44px`).toBeGreaterThanOrEqual(43.5)
      expect(b.x + b.width, `nút ${name} ngoài khung`).toBeLessThanOrEqual(vw + 1)
    }
    for (const name of ['Một CH', 'Nhiều CH', 'Cửa hàng nộp', 'Từng dược sĩ nộp']) {
      expect(await lineCount(page, name), `"${name}" bị xuống dòng`).toBe(1)
    }
    await expect(page.getByRole('button', { name: /^Tất cả \(\d+\)$/ })).toHaveCount(1)
    expect(await page.getByRole('button', { name: /^Tất cả \(\d+\)$/ }).evaluate((el) => {
      const r = document.createRange(); r.selectNodeContents(el)
      return new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size
    }), '"Tất cả (N)" bị xuống dòng').toBe(1)
    await assertPanels(page)

    // Overlay cấu hình phủ màn hình; nút Đóng 44px; 7 chip ngày trong tuần cùng một hàng
    const cfg = page.locator('main [data-task-config]')
    await expect(cfg).toBeHidden()
    await expect(async () => {
      await page.getByRole('button', { name: 'Cấu hình task', exact: true }).click()
      await expect(cfg).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    const box = (await cfg.boundingBox())!
    expect(box.x).toBe(0)
    expect(box.width).toBeCloseTo(vw, 0)
    const close = (await cfg.getByRole('button', { name: 'Đóng', exact: true }).boundingBox())!
    expect(close.width).toBeGreaterThanOrEqual(43.5)
    expect(close.height).toBeGreaterThanOrEqual(43.5)
    await cfg.getByRole('button', { name: 'Định kỳ', exact: true }).click()
    await cfg.getByRole('button', { name: 'Mỗi tuần', exact: true }).click()
    const tops = await Promise.all(['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map(async (d) =>
      Math.round((await cfg.getByRole('button', { name: d, exact: true }).boundingBox())!.y)))
    expect(new Set(tops).size, '7 ngày trong tuần phải cùng một hàng').toBe(1)
    const sc = await cfg.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(sc.sw, 'overlay cấu hình tràn ngang').toBeLessThanOrEqual(sc.cw + 1)
    await cfg.getByRole('button', { name: 'Đóng', exact: true }).click()
    await expect(cfg).toBeHidden()
  })
})

// Guardrail tĩnh: file của form v2 không còn màu status/pastel thô (pastel chỉ sống trong components/ds/).
test.describe('ui v2 form task — guardrail màu thô @desktop', () => {
  test('form + component con không còn pastel/status thô, không text-white', () => {
    const root = path.resolve(__dirname, '..')
    const files = [
      'app/(dashboard)/tasks/new/page.tsx', 'app/(dashboard)/tasks/[id]/edit/page.tsx',
      'components/tasks/TaskForm.tsx', 'components/tasks/TaskExcelSplitPanel.tsx',
      'components/tasks/TaskInputAttachments.tsx', 'components/tasks/RichTextEditor.tsx',
    ]
    const RAW = /\b(?:bg|text|border)-(?:green|red|amber|sky|blue|teal|gray|emerald|rose|orange)-(?:50|100|200|300|500|600|700|800|900)\b/g
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8')
      expect(src.match(RAW) ?? [], `${f} còn màu thô`).toEqual([])
      expect(src.match(/\btext-white\b/g) ?? [], `${f} còn text-white`).toEqual([])
    }
  })
})
