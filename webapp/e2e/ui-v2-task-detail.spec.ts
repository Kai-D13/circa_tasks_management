import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { STAFF_STATE, SUPER_STATE } from './authState'

// UI v2 P1.3 /tasks/[id] — bố cục + quy ước v2 trên route THẬT. Lấy task bằng cách duyệt từ danh sách
// (chỉ đọc); KHÔNG có nhánh bỏ qua theo dữ liệu: không tìm được task ⇒ FAIL. Tiêu đề dài chỉ bơm vào DOM.

const LONG = 'Tiêu đề chi tiết kiểm tra rất dài ' + 'X'.repeat(48) + ' ' + 'chữ dài '.repeat(14)
const taskId = (href: string | null) => href?.match(/\/tasks\/([0-9a-f-]{36})/)?.[1] ?? null

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme)
}

async function assertDetailLayout(page: Page, h1Px: number) {
  await expect(page.locator('main [data-ui-v2="page"]'), 'chi tiết task phải gắn data-ui-v2="page"').toHaveCount(1)
  const h1 = page.locator('main h1').first()
  expect(await h1.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(h1Px)
  await h1.evaluate((el, t) => { el.textContent = t }, LONG)
  const m = await page.locator('main').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
  expect(m.sw, 'trang chi tiết tràn ngang').toBeLessThanOrEqual(m.cw + 1)
  // Panel nội dung/metadata = 12px (Panel ds hoặc ui/card trong phạm vi v2)
  const radii = await page.locator('main [data-ui-v2] section.border, main [data-ui-v2] [data-slot="card"]').evaluateAll(
    (els) => els.map((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius)))
  expect(radii.length, 'phải có panel').toBeGreaterThan(0)
  for (const r of radii) expect(r).toBe(12)
}

test.describe('ui v2 /tasks/[id] — admin desktop @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  async function pick(page: Page, url: string, selector: string) {
    await page.goto(url)
    await page.locator('main h1').first().waitFor()
    const id = taskId(await page.locator(selector).first().getAttribute('href', { timeout: 15_000 }))
    expect(id, `không tìm được task từ ${url}`).not.toBeNull()
    return id!
  }

  // Task thường (không phải nhóm/TRF): thử lần lượt task đơn tab Chờ → task đơn tab Hoàn thành → task con
  // của nhóm broadcast đầu tiên. Không nguồn nào có ⇒ FAIL (dữ liệu prod đổi theo ngày; không bỏ qua).
  async function pickNormal(page: Page): Promise<string> {
    for (const url of ['/tasks', '/tasks?view=done']) {
      await page.goto(url)
      await page.locator('main h1').first().waitFor()
      const href = await page.locator('tbody tr:not([data-group-type]) a[href^="/tasks/"]').first()
        .getAttribute('href', { timeout: 3_000 }).catch(() => null)
      if (taskId(href)) return taskId(href)!
    }
    await page.goto('/tasks')
    await page.locator('tr[data-group-type="broadcast"] td[data-group-col="title"]').first().click()
    const child = await page.locator('tbody tr:not([data-group-type]) a[href^="/tasks/"]').first().getAttribute('href', { timeout: 10_000 })
    const id = taskId(child)
    expect(id, 'không tìm được task thường nào (tab Chờ, Hoàn thành, task con broadcast)').not.toBeNull()
    return id!
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`task thường 1280 sidebar mở (${theme}) — tiêu đề dài không tràn, nút header trong khung`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: info.project.use.baseURL! }])
      const id = await pickNormal(page)
      await page.goto(`/tasks/${id}`)
      await setTheme(page, theme)
      await page.locator('main h1').first().waitFor()
      await assertDetailLayout(page, 24)
      const vw = page.viewportSize()!.width
      for (const name of ['Chia sẻ', 'Xoá']) {
        const b = (await page.getByRole('button', { name, exact: true }).boundingBox())!
        expect(b.x + b.width, `nút ${name} ngoài khung`).toBeLessThanOrEqual(vw + 1)
        expect(b.height, `nút ${name} cao 36px desktop`).toBeCloseTo(36, 0)
      }
    })
  }

  test('task TRF — giữ TrfInfoPanel, tiêu đề "Phiếu …"', async ({ page }) => {
    const id = await pick(page, '/inventory/trf', 'main a[href^="/tasks/"]')
    await page.goto(`/tasks/${id}`)
    await expect(page.locator('main h1').first()).toHaveText(/^Phiếu /)
    await expect(page.getByText('Thông tin phiếu TRF')).toBeVisible()
    await expect(page.locator('main [data-ui-v2="page"]')).toHaveCount(1)
  })

  test('task cha "từng dược sĩ" — khối Tiến độ dược sĩ + nút Chỉnh sửa hướng dẫn', async ({ page }) => {
    const id = await pick(page, '/tasks', 'tr[data-group-type="staff_broadcast"] a[data-group-title], tr[data-group-type="staff"] a[data-group-title]')
    await page.goto(`/tasks/${id}`)
    await expect(page.getByRole('heading', { name: /Tiến độ dược sĩ/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Chỉnh sửa hướng dẫn' })).toBeVisible()
  })
})

test.describe('ui v2 /tasks/[id] — dược sĩ mobile @mobile', () => {
  test.skip(!fs.existsSync(STAFF_STATE), 'chưa có phiên staff')
  test.use({ storageState: STAFF_STATE })

  test('chi tiết task của dược sĩ — tiêu đề 20px, không tràn, panel 12px', async ({ page }) => {
    await page.goto('/tasks')
    await page.locator('main h1').first().waitFor()
    const id = taskId(await page.locator('main a[href^="/tasks/"]').first().getAttribute('href', { timeout: 15_000 }))
    expect(id, 'tài khoản QA staff phải có task').not.toBeNull()
    await page.goto(`/tasks/${id}`)
    await page.locator('main h1').first().waitFor()
    await assertMobileOrder(page)
    await assertDetailLayout(page, 20)
  })

  // Nợ trước RC (PM): chọn CHẮC một task có form nộp — duyệt tối đa 12 task ở tab Chờ của staff QA, mở từng
  // task (chỉ đọc) tới khi gặp heading "Nộp kết quả". Không có ⇒ FAIL (không kiểm có điều kiện).
  test('task có form nộp — form nằm trong khối nội dung, trước metadata', async ({ page }) => {
    await page.goto('/tasks')
    await page.locator('main h1').first().waitFor()
    await page.waitForLoadState('networkidle')
    const ids = [...new Set((await page.locator('main a[href^="/tasks/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      .map(taskId).filter((x): x is string => !!x))].slice(0, 12)
    expect(ids.length, 'tài khoản QA staff phải có task ở tab Chờ').toBeGreaterThan(0)
    let found: string | null = null
    for (const id of ids) {
      await page.goto(`/tasks/${id}`)
      await page.locator('main h1').first().waitFor()
      if (await page.locator('main [data-detail-content] h2', { hasText: 'Nộp kết quả' }).count() === 1) { found = id; break }
    }
    expect(found, `không task nào trong ${ids.length} task tab Chờ của staff QA có form nộp`).not.toBeNull()
    await assertMobileOrder(page)
    const submit = page.locator('main [data-detail-content] h2', { hasText: 'Nộp kết quả' })
    await expect(submit).toBeVisible()
    const sTop = (await submit.boundingBox())!.y
    const metaTop = (await page.locator('main [data-detail-meta]').boundingBox())!.y
    expect(sTop, 'form nộp phải trước metadata').toBeLessThan(metaTop)
    const inContent = await submit.evaluate((el) => !!el.closest('[data-detail-content]'))
    expect(inContent, 'form nộp phải thuộc khối nội dung').toBe(true)
  })
})

// P1.3 r1.1 (PM): trên mobile thứ tự NHÌN = thứ tự DOM (đọc/Tab): header → Deadline/Ưu tiên → nội dung (+form nộp)
// → metadata/hành động phụ. Không dùng order-* đảo khối; chỉ một nhãn "Deadline" hiển thị.
async function assertMobileOrder(page: Page) {
  const parts = ['main h1', 'main [data-mobile-summary]', 'main [data-detail-content]', 'main [data-detail-meta]']
  for (const sel of parts) await expect(page.locator(sel).first(), `thiếu ${sel}`).toBeVisible()
  const r = await page.evaluate((sels) => {
    const els = sels.map((s) => document.querySelector(s)!)
    const boxes = els.map((el) => el.getBoundingClientRect())
    const domOrder = els.slice(1).every((el, i) => !!(els[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
    const orders = els.map((el) => getComputedStyle(el).order)
    return { tops: boxes.map((b) => Math.round(b.top)), bottoms: boxes.map((b) => Math.round(b.bottom)), domOrder, orders }
  }, parts)
  expect(r.domOrder, 'thứ tự DOM phải là header → tóm tắt → nội dung → metadata').toBe(true)
  for (let i = 1; i < parts.length; i++) {
    expect(r.tops[i], `${parts[i]} phải nằm dưới ${parts[i - 1]}`).toBeGreaterThanOrEqual(r.bottoms[i - 1] - 1)
  }
  expect(r.orders.every((o) => o === '0'), 'không được dùng CSS order để đảo khối').toBe(true)
  // Vị trí form nộp: kiểm CHẮC CHẮN ở ca "task có form nộp" (task chọn có form), không kiểm có điều kiện ở đây.
  const deadlineLabels = await page.locator('main p', { hasText: /^Deadline$/ }).evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).length)
  expect(deadlineLabels, 'chỉ một nhãn Deadline hiển thị trên mobile').toBe(1)
}

test.describe('ui v2 /tasks/[id] — desktop giữ 2 cột @desktop', () => {
  test.skip(!fs.existsSync(STAFF_STATE), 'chưa có phiên staff')
  test.use({ storageState: STAFF_STATE })

  test('1280: nội dung trái + metadata phải, khối tóm tắt mobile ẩn, một nhãn Deadline', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/tasks')
    await page.locator('main h1').first().waitFor()
    const id = taskId(await page.locator('main a[href^="/tasks/"]').first().getAttribute('href', { timeout: 15_000 }))
    expect(id, 'tài khoản QA staff phải có task').not.toBeNull()
    await page.goto(`/tasks/${id}`)
    await page.locator('main h1').first().waitFor()
    await expect(page.locator('main [data-mobile-summary]')).toBeHidden()
    const c = (await page.locator('main [data-detail-content]').boundingBox())!
    const m = (await page.locator('main [data-detail-meta]').boundingBox())!
    expect(m.x, 'metadata ở cột phải').toBeGreaterThan(c.x + c.width - 2)
    expect(Math.abs(m.y - c.y), '2 cột cùng hàng').toBeLessThan(2)
    const deadlineLabels = await page.locator('main p', { hasText: /^Deadline$/ }).evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).length)
    expect(deadlineLabels).toBe(1)
  })
})

// Guardrail tĩnh (UI_CHANGE_GUARDRAILS §sau-migrate, mở rộng sang component import): file thuộc các route v2
// không được còn màu status/pastel thô. Pastel chỉ được sống trong components/ds/.
test.describe('ui v2 guardrail màu thô @desktop', () => {
  test('route v2 + component con không còn pastel/status thô', () => {
    const root = path.resolve(__dirname, '..')
    const files = [
      'app/(dashboard)/dashboard/page.tsx', 'app/(dashboard)/tasks/page.tsx', 'app/(dashboard)/tasks/[id]/page.tsx',
      'components/tasks/TaskList.tsx', 'components/tasks/TaskFilters.tsx', 'components/tasks/RequestResubmitSection.tsx',
      'components/tasks/ExtendDeadlineForm.tsx', 'components/tasks/TaskSubmitForm.tsx', 'components/feedback/FeedbackSection.tsx',
      'components/tasks/EditStaffAllInstructionDialog.tsx',
    ]
    const RAW = /\b(?:bg|text|border)-(?:green|red|amber|sky|blue|teal|gray|emerald|rose|orange)-(?:50|100|200|300|500|600|700|800|900)\b/g
    for (const f of files) {
      const hits = fs.readFileSync(path.join(root, f), 'utf8').match(RAW) ?? []
      expect(hits, `${f} còn màu thô`).toEqual([])
    }
  })
})
