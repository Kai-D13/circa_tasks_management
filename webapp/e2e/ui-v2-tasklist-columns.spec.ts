import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'

// UI v2 P1.2 r1.1 (PM P1): dòng nhóm desktop của TaskList phải đặt tên nhóm / cửa hàng / tiến độ vào
// ĐÚNG cột tiêu đề bảng (trước đây ô tiêu đề colSpan 4 đẩy tiến độ sang cột "Trạng thái").
// Chạy trên TaskList THẬT với fixture cố định ở /ui-catalog/tasks-v2 (đủ 4 loại nhóm, có/không ô chọn)
// ⇒ không phụ thuộc loại nhóm tình cờ có trên prod. Server: UI_CATALOG=1 + phiên super.

const GROUPS = ['broadcast', 'import_batch', 'staff_broadcast', 'staff'] as const

async function open(page: Page, width: number, theme: 'light' | 'dark', baseURL: string) {
  await page.setViewportSize({ width, height: 900 })
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
  await page.goto('/ui-catalog/tasks-v2')
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme)
  await page.getByTestId('fx-tasklist-checkbox').locator('table').waitFor()
}

type ColCheck = {
  ths: number; tds: number; colspan: boolean
  idx: { title: number; store: number; progress: number; created: number }
  cell: { title: number; store: number; progress: number }
  createdText: string; storeText: string; progressText: string
  bar: { now: string | null; max: string | null } | null
  titleWidth: number
}

async function columns(table: Locator, type: string): Promise<ColCheck> {
  return table.evaluate((tbl, t) => {
    const ths = Array.from(tbl.querySelectorAll('thead th')).map((th) => th.textContent?.trim() ?? '')
    const row = tbl.querySelector(`tbody tr[data-group-type="${t}"]`) as HTMLTableRowElement | null
    if (!row) throw new Error(`không có dòng nhóm ${t}`)
    const tds = Array.from(row.cells)
    const cellOf = (col: string) => {
      const td = row.querySelector(`td[data-group-col="${col}"]`) as HTMLTableCellElement | null
      if (!td) throw new Error(`dòng ${t} thiếu ô ${col}`)
      return td
    }
    const progress = cellOf('progress')
    const pb = progress.querySelector('[role="progressbar"]')
    return {
      ths: ths.length, tds: tds.length, colspan: tds.some((td) => td.colSpan > 1),
      idx: { title: ths.indexOf('Tiêu đề'), store: ths.indexOf('Cửa hàng'), progress: ths.indexOf('Thực hiện / Đã nộp'), created: ths.indexOf('Ngày tạo') },
      cell: { title: cellOf('title').cellIndex, store: cellOf('store').cellIndex, progress: progress.cellIndex },
      createdText: tds[ths.indexOf('Ngày tạo')]?.textContent?.trim() ?? '',
      storeText: cellOf('store').textContent?.trim() ?? '',
      progressText: progress.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      bar: pb ? { now: pb.getAttribute('aria-valuenow'), max: pb.getAttribute('aria-valuemax') } : null,
      // Vùng dành cho tên (không phải bề rộng chữ — tên ngắn vốn hẹp): từ mép trái tên tới mép trái phần tử
      // kế tiếp cùng hàng (vd tag) hoặc mép phải hàng flex nếu tên đứng cuối.
      titleWidth: (() => {
        const t = row.querySelector('[data-group-title]') as HTMLElement | null
        if (!t || !t.parentElement) return 0
        const next = t.nextElementSibling as HTMLElement | null
        const right = next ? next.getBoundingClientRect().left : t.parentElement.getBoundingClientRect().right
        return right - t.getBoundingClientRect().left
      })(),
    }
  }, type)
}

test.describe('ui v2 TaskList — dòng nhóm đúng cột @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [1366, 'light']] as const) {
    test(`${width} sidebar mở (${theme}) — 4 loại nhóm × có/không ô chọn`, async ({ page }, info) => {
      await open(page, width, theme, info.project.use.baseURL!)
      for (const testId of ['fx-tasklist-checkbox', 'fx-tasklist-nocheckbox']) {
        const table = page.getByTestId(testId).locator('table')
        for (const type of GROUPS) {
          const c = await columns(table, type)
          const where = `${testId} / ${type}`
          expect(c.colspan, `${where}: không còn ô gộp`).toBe(false)
          expect(c.tds, `${where}: số ô = số cột`).toBe(c.ths)
          expect(c.cell.title, `${where}: tên nhóm ở cột Tiêu đề`).toBe(c.idx.title)
          expect(c.cell.store, `${where}: cửa hàng ở cột Cửa hàng`).toBe(c.idx.store)
          expect(c.cell.progress, `${where}: tiến độ ở cột Thực hiện / Đã nộp`).toBe(c.idx.progress)
          expect(c.createdText, `${where}: ngày tạo ở cột Ngày tạo`).toMatch(/\d{2}\/\d{2}\/\d{4}/)
          expect(c.storeText, `${where}: ô cửa hàng có chữ`).toMatch(/cửa hàng|dược sĩ/)
          // Tên nhóm không bị ép (lỗi 1 ký tự/dòng khi tag cùng hàng ở 1280px)
          expect(c.titleWidth, `${where}: tên nhóm bị ép hẹp`).toBeGreaterThanOrEqual(140)
          // Nội dung tiến độ theo từng ca biên
          if (type === 'broadcast') { expect(c.bar).toEqual({ now: '2', max: '3' }); expect(c.progressText).toContain('2/3 hoàn thành') }
          if (type === 'import_batch') { expect(c.bar, 'mất tiến độ ⇒ không vẽ thanh').toBeNull(); expect(c.progressText).toContain('—/— hoàn thành') }
          if (type === 'staff_broadcast') { expect(c.bar).toEqual({ now: '1', max: '2' }); expect(c.progressText).toContain('1/2 đã nộp') }
          if (type === 'staff') { expect(c.bar, 'max 0 ⇒ không vẽ thanh').toBeNull(); expect(c.progressText).toContain('0/0 đã nộp') }
        }
        // Bảng vừa khung, cột cuối trong vùng nhìn, trang không tràn
        const m = await table.locator('xpath=..').evaluate((el) => {
          const ths = el.querySelectorAll('thead th'); const last = ths[ths.length - 1]
          const main = document.querySelector('main')!
          return { sw: el.scrollWidth, cw: el.clientWidth, right: el.getBoundingClientRect().right, lastRight: last.getBoundingClientRect().right, msw: main.scrollWidth, mcw: main.clientWidth }
        })
        expect(m.sw, `${testId}: bảng tràn ngang`).toBeLessThanOrEqual(m.cw + 1)
        expect(m.lastRight, `${testId}: cột cuối ngoài vùng nhìn`).toBeLessThanOrEqual(m.right + 1)
        expect(m.msw, 'trang tràn ngang').toBeLessThanOrEqual(m.mcw + 1)
      }
    })
  }

  test('mở rộng/thu gọn 4 loại nhóm + chọn nhóm vẫn hoạt động', async ({ page }, info) => {
    await open(page, 1366, 'light', info.project.use.baseURL!)
    const scope = page.getByTestId('fx-tasklist-checkbox')
    const rows = scope.locator('table tbody tr')
    const base = await rows.count()

    // broadcast: bấm ô tiêu đề ⇒ +3 hàng con; bấm lại ⇒ thu gọn
    const bcTitle = scope.locator('tr[data-group-type="broadcast"] td[data-group-col="title"]')
    await bcTitle.click(); await expect(rows).toHaveCount(base + 3)
    await bcTitle.click(); await expect(rows).toHaveCount(base)
    // import: bấm ô tiến độ (ô khác cũng mở rộng như cũ) ⇒ +2
    const ibProgress = scope.locator('tr[data-group-type="import_batch"] td[data-group-col="progress"]')
    await ibProgress.click(); await expect(rows).toHaveCount(base + 2)
    await ibProgress.click(); await expect(rows).toHaveCount(base)
    // staff_broadcast: nút Mở rộng ⇒ +1 hàng cửa hàng
    const sbc = scope.locator('tr[data-group-type="staff_broadcast"]')
    await sbc.getByRole('button', { name: 'Mở rộng' }).click(); await expect(rows).toHaveCount(base + 1)
    await sbc.getByRole('button', { name: 'Thu gọn' }).click(); await expect(rows).toHaveCount(base)
    // staff (chưa có dược sĩ): nút đổi nhãn, không thêm hàng
    const st = scope.locator('tr[data-group-type="staff"]')
    await st.getByRole('button', { name: 'Mở rộng' }).click()
    await expect(st.getByRole('button', { name: 'Thu gọn' })).toBeVisible(); await expect(rows).toHaveCount(base)
    await st.getByRole('button', { name: 'Thu gọn' }).click()

    // Chọn nhóm broadcast ⇒ thanh hàng loạt "3 task đã chọn"; bỏ chọn ⇒ biến mất (KHÔNG bấm hành động)
    const box = scope.locator('tr[data-group-type="broadcast"] input[type="checkbox"]')
    await box.check()
    await expect(scope.locator('[data-bulk-bar]')).toContainText('3 task đã chọn')
    await box.uncheck()
    await expect(scope.locator('[data-bulk-bar]')).toHaveCount(0)
    // Bảng không có ô chọn: không có checkbox ở dòng nhóm
    await expect(page.getByTestId('fx-tasklist-nocheckbox').locator('tr[data-group-type] input[type="checkbox"]')).toHaveCount(0)
  })
})
