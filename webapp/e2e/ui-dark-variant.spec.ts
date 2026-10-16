import fs from 'node:fs'
import { test, expect, type Browser } from '@playwright/test'
import { SUPER_STATE } from './authState'

// `dark:` phải theo THEME CỦA APP (class .dark trên <html>), không theo theme hệ điều hành
// (globals.css `@custom-variant dark`, PM audit 16/10 F1). Trước khi sửa, Tailwind 4 dùng
// @media (prefers-color-scheme: dark): app tối + HĐH sáng ⇒ TagBadge/ô nhập giữ màu sáng; app sáng
// + HĐH tối ⇒ màu tối bật sai. Đo computed style trên catalog v2 (fixture, có TagBadge + ui/input).

const HAS_STATE = fs.existsSync(SUPER_STATE)
type Theme = 'light' | 'dark'

async function read(browser: Browser, baseURL: string, os: Theme, theme: Theme) {
  const ctx = await browser.newContext({ baseURL, storageState: SUPER_STATE, colorScheme: os, viewport: { width: 1366, height: 900 } })
  const page = await ctx.newPage()
  await page.goto('/ui-catalog/tasks-v2')
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme)
  await page.getByTestId('ui-catalog-v2').waitFor({ state: 'visible', timeout: 20_000 })
  const tag = await page.getByText('Training', { exact: true }).first().evaluate((el) => getComputedStyle(el).backgroundColor)
  const input = await page.getByRole('textbox', { name: 'Tiêu đề task' }).evaluate((el) => getComputedStyle(el).backgroundColor)
  await ctx.close()
  return { tag, input }
}

test.describe('dark: theo theme app @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có phiên super')

  test('HĐH sáng/tối không đổi màu; chỉ theme app đổi', async ({ browser }, info) => {
    const baseURL = info.project.use.baseURL ?? 'http://localhost:3000'
    const lightOsLight = await read(browser, baseURL, 'light', 'light')
    const lightOsDark = await read(browser, baseURL, 'dark', 'light')
    const darkOsLight = await read(browser, baseURL, 'light', 'dark')
    const darkOsDark = await read(browser, baseURL, 'dark', 'dark')
    expect(lightOsDark, 'app sáng: HĐH tối không được bật dark:').toEqual(lightOsLight)
    expect(darkOsLight, 'app tối: HĐH sáng không được tắt dark:').toEqual(darkOsDark)
    expect(darkOsDark.tag).not.toBe(lightOsLight.tag)
    expect(lightOsLight.input).toBe('rgba(0, 0, 0, 0)') // ô nhập trong suốt ở theme sáng
    expect(darkOsDark.input).not.toBe('rgba(0, 0, 0, 0)') // dark:bg-input/30 ở theme tối
  })
})
