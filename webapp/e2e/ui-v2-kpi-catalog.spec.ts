import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'

// UI v2 Phase 2 "Chiến dịch KPI" — K0 (component dùng chung) trên /ui-catalog/kpi-v2: render ĐÚNG component
// KPI thật với fixture giả cố định ⇒ không phụ thuộc dữ liệu prod; ảnh catalog commit được.
// Kiểm HÀNH VI + token, không chỉ ảnh: chưa đồng bộ ⇒ '—' không vẽ 0%; đường "Trung bình/ngày cần đạt" CHỈ GMV
// với giá trị thật > 0 (PM P1 16/10); tone nhịp độ theo ngưỡng performanceTone; token KPI chỉ trong v2.

const HAS_STATE = fs.existsSync(SUPER_STATE)
const THEMES = ['light', 'dark'] as const
// Giá trị canvas K0 (docs/ui/UI_V2_KPI.md)
const RGB = {
  light: { series: 'rgb(232, 98, 42)', ok: 'rgb(47, 158, 91)', text3: 'rgb(111, 105, 100)' },
  dark: { series: 'rgb(243, 116, 63)', ok: 'rgb(91, 191, 126)', text3: 'rgb(138, 132, 128)' },
}

async function open(page: Page, theme: (typeof THEMES)[number]) {
  await page.goto('/ui-catalog/kpi-v2')
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.getByTestId('ui-catalog-kpi-v2').waitFor({ state: 'visible', timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
}

const fillColor = (page: Page, testId: string) =>
  page.getByTestId(testId).locator('[role="progressbar"] > div').first().evaluate((el) => getComputedStyle(el).backgroundColor)

async function noPageOverflow(page: Page) {
  const g = await page.evaluate(() => {
    const m = document.querySelector('main')!
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, msw: m.scrollWidth, mcw: m.clientWidth }
  })
  expect(g.sw, 'trang cuộn ngang').toBeLessThanOrEqual(g.iw + 1)
  expect(g.msw, '<main> cuộn ngang').toBeLessThanOrEqual(g.mcw + 1)
}

test.describe('ui v2 KPI K0 catalog @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const theme of THEMES) {
    test(`ProgressMeter 4 trạng thái + TierTrack + tone theo token (${theme})`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: info.project.use.baseURL! }])
      await open(page, theme)
      const c = RGB[theme]
      // 4 trạng thái
      expect(await fillColor(page, 'fx-meter-series')).toBe(c.series)
      expect(await fillColor(page, 'fx-meter-ok')).toBe(c.ok)
      expect(await fillColor(page, 'fx-meter-ended')).toBe(c.text3)
      const uns = page.getByTestId('fx-meter-unsynced')
      await expect(uns.locator('[role="progressbar"]'), 'chưa đồng bộ không được vẽ thanh').toHaveCount(0)
      await expect(uns.locator('[data-kpi-meter="unsynced"]')).toContainText('—')
      expect(await uns.locator('[aria-hidden="true"]').first().evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed')
      // Chữ số dùng màu chữ, KHÔNG màu chuỗi
      const valColor = await page.getByTestId('fx-meter-series').locator('span.tabular-nums').first().evaluate((el) => getComputedStyle(el).color)
      expect(valColor).not.toBe(c.series)
      // Cỡ thanh 5/6/8/10/12px
      const heights = await page.getByTestId('fx-meter-sizes').locator('[role="progressbar"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
      expect(heights).toEqual([5, 6, 8, 10, 12])
      // TierTrack: thang 0–120 (mốc cao nhất 110 + 10), fill 40,2/120, vạch 90/100/110
      const next = page.getByTestId('fx-tier-next')
      const g = await next.locator('[role="progressbar"]').evaluate((el) => {
        const tb = el.getBoundingClientRect()
        const fill = el.querySelector('[data-tier-fill]')!.getBoundingClientRect()
        const marks = [...el.parentElement!.querySelectorAll('[data-tier-mark]')].map((m) => {
          const r = m.getBoundingClientRect(); return (r.left + r.width / 2 - tb.left) / tb.width
        })
        return { fill: fill.width / tb.width, marks, max: el.getAttribute('aria-valuemax') }
      })
      expect(g.max).toBe('120')
      expect(g.fill).toBeCloseTo(40.2 / 120, 2)
      expect(g.marks[0]).toBeCloseTo(90 / 120, 2)
      expect(g.marks[1]).toBeCloseTo(100 / 120, 2)
      expect(g.marks[2]).toBeCloseTo(110 / 120, 2)
      expect(await next.locator('[data-tier-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tier-card')))).toEqual(['next', 'pending', 'pending'])
      expect(await next.locator('[data-tier-fill]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(c.series)
      const reached = page.getByTestId('fx-tier-reached')
      expect(await reached.locator('[data-tier-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tier-card')))).toEqual(['reached', 'reached', 'reached'])
      expect(await reached.locator('[data-tier-fill]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(c.ok)
      const tUns = page.getByTestId('fx-tier-unsynced')
      await expect(tUns.locator('[data-tier-fill]'), 'chưa đồng bộ không vẽ phần đã đạt').toHaveCount(0)
      // r1.1 (PM P1): chưa đồng bộ ⇒ phần tiến độ là trang trí — không progressbar, không công bố 0; vạch mốc giữ
      await expect(tUns.locator('[role="progressbar"]')).toHaveCount(0)
      await expect(tUns.locator('[data-tier-mark]')).toHaveCount(3)
      // 5 bậc ⇒ danh sách dọc (mỗi thẻ một hàng)
      const five = await page.getByTestId('fx-tier-five').locator('[data-tier-card]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
      expect(new Set(five).size, '5 bậc phải xếp dọc').toBe(1)
      await noPageOverflow(page)
    })
  }

  test('đường "Trung bình/ngày cần đạt": CHỈ GMV, giá trị thật > 0; null/0/Số đơn/AOV/Số khách không vẽ', async ({ page }) => {
    await open(page, 'light')
    const gmv = page.getByTestId('fx-chart-gmv-required')
    await expect(gmv.locator('[data-required-line]')).toHaveCount(1)
    const legend = gmv.locator('[data-required-legend]')
    await expect(legend).toContainText('Trung bình/ngày cần đạt:')
    await expect(legend).toContainText(/\d{1,3}(\.\d{3})+₫/) // số ĐẦY ĐỦ (không rút gọn) trong chú giải chữ
    // Đoạn đường bắt đầu từ HÔM NAY (15/31) tới hết kỳ
    const seg = await gmv.locator('svg[role="img"]').evaluate((svg) => {
      const l = svg.querySelector('[data-required-line]')!
      const vb = (svg as SVGSVGElement).viewBox.baseVal
      return { x1: Number(l.getAttribute('x1')) / vb.width, x2: Number(l.getAttribute('x2')) / vb.width }
    })
    expect(seg.x1).toBeGreaterThan(0.45)
    expect(seg.x2).toBeGreaterThan(0.95)
    for (const id of ['fx-chart-gmv-null', 'fx-chart-gmv-zero', 'fx-chart-orders', 'fx-chart-aov', 'fx-chart-customer']) {
      await expect(page.getByTestId(id).locator('[data-required-line]'), `${id} không được vẽ đường`).toHaveCount(0)
      await expect(page.getByTestId(id).locator('[data-required-legend]')).toHaveCount(0)
    }
    // Ngày tương lai (16→31) = vạch thấp, chỉ hiển thị trong v2
    const futures = gmv.locator('[data-future-day]')
    await expect(futures).toHaveCount(16)
    expect(await futures.first().evaluate((el) => getComputedStyle(el).display)).not.toBe('none')
  })

  for (const theme of THEMES) {
    test(`1440 (${theme}): không tràn, 2 cột panel, biểu đồ đủ 6+2 khối`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await open(page, theme)
      await noPageOverflow(page)
      await expect(page.locator('[data-testid^="fx-chart-"] svg[role="img"]')).toHaveCount(8)
    })
  }

  // r1.1 (PM P1): chưa đồng bộ = MỌI pct không hữu hạn (null/NaN/Infinity) hoặc tone 'unsynced' ⇒ luôn '—',
  // KHÔNG thanh/role progressbar, KHÔNG công bố 0 — bất kể chuỗi caller (fixture cố truyền '0%').
  test('biên chưa đồng bộ: null/NaN/Infinity/tone unsynced ⇒ "—", không 0%, không progressbar', async ({ page }) => {
    await open(page, 'light')
    for (const id of ['fx-meter-edge-null', 'fx-meter-edge-nan', 'fx-meter-edge-inf', 'fx-meter-edge-tone']) {
      const m = page.getByTestId(id)
      await expect(m.locator('[data-kpi-meter]'), `${id} phải ở trạng thái chưa đồng bộ`).toHaveAttribute('data-kpi-meter', 'unsynced')
      await expect(m.locator('span.tabular-nums'), `${id} phải hiện —`).toHaveText('—')
      await expect(m.getByText('0%'), `${id} không được công bố 0%`).toHaveCount(0)
      await expect(m.locator('[role="progressbar"]'), `${id} không được có progressbar`).toHaveCount(0)
    }
    for (const id of ['fx-tier-edge-nan', 'fx-tier-edge-tone']) {
      const t = page.getByTestId(id)
      await expect(t.locator('[data-tier-track] > div').first().locator('span').first(), `${id} số lớn phải là —`).toHaveText('—')
      await expect(t.getByText('0%', { exact: true }), `${id} không được công bố 0%`).toHaveCount(0)
      await expect(t.locator('[role="progressbar"]'), `${id}: phần tiến độ chưa đồng bộ là trang trí, không progressbar`).toHaveCount(0)
      await expect(t.locator('[data-tier-fill]')).toHaveCount(0)
      await expect(t.locator('[data-tier-mark]'), `${id} vẫn giữ vạch mốc`).toHaveCount(3)
    }
  })

  // r1.1 (PM P1): đường "cần/ngày" cần ĐIỂM daily thật trong [đầu kỳ, hôm nay]; daily rỗng ⇒ không vẽ,
  // còn ngày đã đồng bộ với doanh thu 0 THẬT thì vẫn vẽ (không chặn nhầm số 0 thật).
  test('đường cần/ngày: daily rỗng ⇒ không vẽ; daily có số 0 thật ⇒ vẫn vẽ', async ({ page }) => {
    await open(page, 'light')
    await expect(page.getByTestId('fx-chart-gmv-empty-daily').locator('[data-required-line]')).toHaveCount(0)
    await expect(page.getByTestId('fx-chart-gmv-empty-daily').locator('[data-required-legend]')).toHaveCount(0)
    await expect(page.getByTestId('fx-chart-gmv-real-zero').locator('[data-required-line]')).toHaveCount(1)
    await expect(page.getByTestId('fx-chart-gmv-real-zero').locator('[data-required-legend]')).toHaveCount(1)
  })

  test('PaceBadge: ≥100 success · ≥80 warning · <80 danger · null trung tính "—"', async ({ page }) => {
    await open(page, 'light')
    const badges = page.getByTestId('fx-badge-pace').locator('span.inline-flex')
    await expect(badges).toHaveCount(4)
    const cls = await badges.evaluateAll((els) => els.map((e) => e.className))
    expect(cls[0]).toContain('text-status-success')
    expect(cls[1]).toContain('text-status-warning')
    expect(cls[2]).toContain('text-status-danger')
    expect(cls[3]).toContain('text-status-neutral')
    await expect(badges.nth(3)).toHaveText('—')
  })

  test('ngoài phạm vi v2 (/ui-catalog): token KPI rỗng', async ({ page }) => {
    await page.goto('/ui-catalog')
    await page.getByTestId('ui-catalog').waitFor({ state: 'visible', timeout: 20_000 })
    const v = await page.evaluate(() => ['--v2-series', '--v2-ok', '--v2-series-soft'].map((k) => getComputedStyle(document.body).getPropertyValue(k).trim()))
    expect(v).toEqual(['', '', ''])
  })
})

test.describe('ui v2 KPI K0 catalog @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('360/390: không tràn, nhãn vạch bậc không chồng nhau', async ({ page }) => {
    await open(page, 'light')
    await noPageOverflow(page)
    for (const id of ['fx-tier-next', 'fx-tier-reached', 'fx-tier-unsynced', 'fx-tier-five']) {
      const boxes = await page.getByTestId(id).locator('[data-tier-label-row]').evaluateAll((els) => els.map((e) => {
        const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: Math.round(r.top) }
      }))
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        const overlap = a.t === b.t && a.l < b.r - 1 && b.l < a.r - 1
        expect(overlap, `${id}: nhãn vạch ${i} và ${j} chồng nhau`).toBe(false)
      }
    }
  })
})

test.describe('ui v2 KPI K0 — ảnh catalog @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('catalog KPI light+dark (fixture, commit được)', async ({ page }) => {
    test.setTimeout(120_000)
    for (const theme of THEMES) {
      await open(page, theme)
      await page.evaluate(() => {
        document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
        const main = document.querySelector('main'); const outer = main?.parentElement
        if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
        if (main instanceof HTMLElement) main.style.overflow = 'visible'
      })
      await page.waitForTimeout(250)
      expect(await page.getByTestId('ui-catalog-kpi-v2').screenshot({ animations: 'disabled' })).toMatchSnapshot(`catalog-kpi-v2-${theme}.png`, { maxDiffPixelRatio: 0.01 })
    }
  })
})

// Guardrail tĩnh: file K0 không có màu thô (pastel/status/hex) — màu đi qua token.
test.describe('ui v2 KPI K0 — guardrail màu thô @desktop', () => {
  test('component KPI K0 + ProgressBar không màu thô', () => {
    const root = path.resolve(__dirname, '..')
    const files = [
      'components/kpi/KpiProgressMeter.tsx', 'components/kpi/TierTrack.tsx', 'components/kpi/PaceBadge.tsx',
      'components/kpi/CampaignDailyChart.tsx', 'components/ds/ProgressBar.tsx', 'lib/kpi/progressTone.ts',
    ]
    const RAW = /\b(?:bg|text|border|fill|stroke)-(?:green|red|amber|sky|blue|teal|gray|emerald|rose|orange|yellow|slate)-\d{2,3}\b|#[0-9a-fA-F]{6}\b/g
    for (const f of files) expect(fs.readFileSync(path.join(root, f), 'utf8').match(RAW) ?? [], `${f} còn màu thô`).toEqual([])
  })
})
