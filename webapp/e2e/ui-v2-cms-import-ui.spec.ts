import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'

// CMS-IMPORT-UI-1 (PM 22/11 `planning/reviews/2026-11-22-cms-import-ui-plan-pm.md` §3 / §5) — bố cục tạo / sửa / import / revision CMS.
// Phần 1 (không cần server): hợp đồng nguồn của khung + form (fluid, một <form>, không cap, không đổi handler).
// Phần 2 (fixture /ui-catalog/cms-v2, ĐÚNG component của route thật, dữ liệu giả, 0 ghi): ĐO hình học — UI-01 khung phủ <main>, lề
// 16 / 24px; UI-02 hai cột khi NỘI DUNG ≥ 960px (kỳ vọng suy từ bề rộng đo được ⇒ đúng cả khi sidebar mở / thu); UI-03 kết quả / K dùng
// toàn chiều ngang, không cuộn ngang trang; UI-04 đổi khổ / theme không remount form, không mất giá trị; UI-06 chạm ≥ 44px, input ≥ 16px.
// Ảnh ma trận: đặt CMS_SHOTS_DIR.

const ROOT = path.resolve(__dirname, '..')
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
const WIDTHS = [360, 390, 768, 1024, 1280, 1440, 1920, 2560] as const
const TOL = 2
const TWO_COL = 960

test.describe('CMS-IMPORT-UI-1 · hợp đồng nguồn (không server) @desktop', () => {
  test('khung: fluid, không cap / căn giữa ở page-root, lề + khoảng cách bằng pixel, có container cho hai cột', () => {
    const s = src('components/cms/admin/CmsWizardShell.tsx')
    const root = /<div data-ui-v2="page"[^>]*>/.exec(s)?.[0] ?? ''
    expect(root).toContain('data-layout-width="fluid"')
    expect(root).toContain('data-cms-wizard={kind}')
    expect(root).not.toMatch(/max-w-|mx-auto/)
    expect(root).toMatch(/p-\[16px\] md:p-\[24px\]/)
    expect(root).toMatch(/space-y-\[16px\] md:space-y-\[24px\]/)
    expect(s).toContain('@container/cms-wizard')
    expect(s).not.toMatch(/100vw|useEffect|useState|addEventListener/)
  })

  test('form: MỘT <form>, hai nhóm theo container 960px, không cây desktop / mobile song song; action + payload không đổi', () => {
    const s = src('components/cms/admin/CmsProgramForm.tsx')
    expect(s.match(/^\s*<form\b/gm)?.length).toBe(1) // chỉ thẻ JSX đầu dòng — không đếm chữ "<form>" trong chú thích
    expect(s.match(/name="scope"/g)?.length).toBe(1)
    expect(s.match(/name="quantity_basis"/g)?.length).toBe(1)
    expect(s).toContain('@min-[960px]/cms-wizard:grid-cols-2')
    expect(s).toContain('data-cms-form-group="info"')
    expect(s).toContain('data-cms-form-group="basis"')
    expect(s).not.toContain('rounded-v2-panel') // r1: nhóm mới radius ≤ 8px
    expect(s).not.toMatch(/flex-col-reverse|hidden md:|md:hidden/)
    // handler / payload giữ nguyên
    expect(s).toContain("const r = mode === 'create' ? await createCmsProgram(payload) : await updateCmsProgram(initial!.id, payload)")
    expect(s).toContain('const payload = selectable ? { ...v.value, quantity_basis: basis } : v.value')
    expect(s).toContain('if (fixtureBlocked()) return')
  })

  test('import: lưới Upload theo container, không lời mời kéo-thả, request / rào ghi không đổi', () => {
    const s = src('components/cms/admin/CmsImportFlow.tsx')
    expect(s).toContain('@min-[960px]/cms-wizard:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]')
    expect(s).not.toMatch(/kéo.{0,6}thả|onDrop|onDragOver/i)
    expect(s.match(/fetch\('\/api\/cms\/import\/preview'/g)?.length).toBe(1)
    expect(s.match(/fetch\('\/api\/cms\/import\/commit'/g)?.length).toBe(1)
    expect(s).toContain("if (commitBlock !== 'NONE') return")
    expect(s).toContain("disabled={commitBlock !== 'NONE'}")
    expect(s).toContain('key={result.runId}')
    // tóm tắt trước khi ghi nằm NGAY trước hàng nút ghi
    const iSum = s.indexOf('<CmsImportCommitSummary'), iAct = s.indexOf('data-cms-flow-actions', iSum), iCommit = s.indexOf('data-cms-commit={result.mode}')
    expect(iSum).toBeGreaterThan(0)
    expect(iAct).toBeGreaterThan(iSum)
    expect(iCommit).toBeGreaterThan(iAct)
    expect(s.slice(iSum, iAct)).not.toMatch(/<Cms(KCheckPanel|ImportResult)/)
  })

  test('stepper: bốn tên bước giữ nguyên, bước hiện tại aria-current="step", không biến thành link', () => {
    const s = src('components/cms/admin/CmsStepper.tsx')
    expect(s).toContain("['Thông tin', 'Upload', 'Chạy xử lý', 'Kết quả']")
    expect(s).toContain("aria-current={active ? 'step' : undefined}")
    expect(s).not.toMatch(/<Link|<a |<button/)
  })
})

async function openFx(page: Page, pageName: 'wizard' | 'revision', fx: string, theme: Theme, width: number) {
  await page.setViewportSize({ width, height: width < 768 ? 800 : 900 })
  await page.goto(`/ui-catalog/cms-v2/${pageName}?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator('main [data-cms-wizard]').waitFor({ state: 'visible', timeout: 20_000 })
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
}
/** Khung so với <main>: phủ kín (trừ scrollbar của main), lề theo breakpoint, không cuộn ngang. */
async function shellGeometry(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main') as HTMLElement
    const root = main.querySelector('[data-cms-wizard]') as HTMLElement
    const body = root.querySelector('[data-cms-wizard-body]') as HTMLElement
    const m = main.getBoundingClientRect(), r = root.getBoundingClientRect(), b = body.getBoundingClientRect()
    const cs = getComputedStyle(root)
    return {
      mainLeft: m.left, mainClient: main.clientWidth, rootLeft: r.left, rootWidth: r.width, bodyLeft: b.left, bodyWidth: b.width,
      padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight), maxWidth: cs.maxWidth, layout: root.getAttribute('data-layout-width'),
      docSw: document.documentElement.scrollWidth, iw: window.innerWidth, mainSw: main.scrollWidth,
    }
  })
}
function expectShell(g: Awaited<ReturnType<typeof shellGeometry>>, width: number, where: string) {
  expect(g.layout, where).toBe('fluid')
  expect(g.maxWidth, `${where}: page-root còn cap`).toBe('none')
  expect(Math.abs(g.rootLeft - g.mainLeft), `${where}: khung lệch mép trái <main>`).toBeLessThanOrEqual(TOL)
  expect(Math.abs(g.rootWidth - g.mainClient), `${where}: khung không phủ <main> (${g.rootWidth} / ${g.mainClient})`).toBeLessThanOrEqual(TOL)
  const pad = width >= 768 ? 24 : 16
  expect(g.padL, `${where}: lề trái`).toBe(pad)
  expect(g.padR, `${where}: lề phải`).toBe(pad)
  expect(Math.abs(g.bodyWidth - (g.rootWidth - 2 * pad)), `${where}: nội dung không dùng hết khung`).toBeLessThanOrEqual(TOL)
  expect(g.docSw, `${where}: trang cuộn ngang`).toBeLessThanOrEqual(g.iw + 1)
  expect(g.mainSw, `${where}: <main> cuộn ngang`).toBeLessThanOrEqual(g.mainClient + 1)
}
/** Hai khối cùng hàng (hai cột) hay xếp dọc — theo toạ độ thật. */
async function pair(page: Page, a: string, b: string) {
  return page.evaluate(([sa, sb]) => {
    const A = document.querySelector(`main ${sa}`)!.getBoundingClientRect(), B = document.querySelector(`main ${sb}`)!.getBoundingClientRect()
    return { sideBySide: Math.abs(A.top - B.top) <= 2 && B.left >= A.right - 1, stacked: B.top >= A.bottom - 1 && Math.abs(A.left - B.left) <= 2, aw: A.width, bw: B.width }
  }, [a, b])
}
async function touchAndInputs(page: Page, where: string) {
  const bad = await page.locator('main [data-cms-wizard] a:visible, main [data-cms-wizard] button:visible, main [data-cms-wizard] label:has(input[type="radio"]):visible, main [data-cms-wizard] label:has(input[type="checkbox"]):visible')
    .evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent ?? '').trim().slice(0, 40), h: Math.round(r.height), w: Math.round(r.width) } })
      .filter((x) => x.h > 0 && x.w > 0 && Math.min(x.h, x.w) < 44))
  expect(bad, `${where}: chạm < 44px`).toEqual([])
  const small = await page.locator('main [data-cms-wizard] input:visible:not([type="radio"]):not([type="checkbox"]):not([type="file"])')
    .evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)).filter((n) => n < 16))
  expect(small, `${where}: input < 16px`).toEqual([])
}

test.describe('CMS-IMPORT-UI-1 · hình học trên fixture (0 ghi) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  test.setTimeout(240_000)

  for (const theme of ['light', 'dark'] as Theme[]) {
    test(`UI-01 / UI-02 Thông tin — 8 khổ, ${theme}: khung phủ <main>, lề 16 / 24, hai nhóm theo bề rộng nội dung`, async ({ page }) => {
      for (const w of WIDTHS) {
        // (a) có lựa chọn cách tính ⇒ hai nhóm
        await openFx(page, 'wizard', 'info&b=on', theme, w)
        let where = `info selectable ${w} ${theme}`
        let g = await shellGeometry(page)
        expectShell(g, w, where)
        const p = await pair(page, '[data-cms-form-group="info"]', '[data-cms-form-group="basis"]')
        if (g.bodyWidth >= TWO_COL) {
          expect(p.sideBySide, `${where}: nội dung ${g.bodyWidth}px ≥ 960 phải hai cột`).toBe(true)
          expect(Math.abs(p.aw - p.bw), `${where}: hai nhóm không cân`).toBeLessThanOrEqual(TOL)
        } else expect(p.stacked, `${where}: nội dung ${g.bodyWidth}px < 960 phải một cột`).toBe(true)
        await expect(page.locator('main [data-cms-wizard] ol li[aria-current="step"]')).toHaveCount(1)
        if (w < 768) await touchAndInputs(page, where)
        await shot(page, `info-selectable-${w}-${theme}`)
        // (b) r1 UI-R1-01: KHÔNG có lựa chọn ⇒ một nhóm phủ hết bề ngang, không card "Cách tính CMS" rỗng, không radio / mode đoán
        await openFx(page, 'wizard', 'info', theme, w)
        where = `info no-select ${w} ${theme}`
        g = await shellGeometry(page)
        expectShell(g, w, where)
        await expect(page.locator('main [data-cms-form-group="basis"]')).toHaveCount(0)
        await expect(page.locator('main [data-cms-basis-field]')).toHaveCount(0)
        await expect(page.locator('main [data-cms-form-group="info"] [data-cms-tier-note]')).toHaveCount(1)
        const one = await page.evaluate(() => {
          const el = document.querySelector('main [data-cms-form-group="info"]') as HTMLElement
          return { w: el.getBoundingClientRect().width, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) }
        })
        expect(Math.abs(one.w - g.bodyWidth), `${where}: nhóm không phủ bề ngang nội dung`).toBeLessThanOrEqual(TOL)
        expect(one.radius, `${where}: radius nhóm > 8px`).toBeLessThanOrEqual(8)
        const q = await pair(page, '[data-cms-form-info-body] > :nth-child(1)', '[data-cms-form-info-body] > :nth-child(2)')
        if (g.bodyWidth >= TWO_COL) expect(q.sideBySide, `${where}: tên / ngày | phạm vi phải cạnh nhau`).toBe(true)
        else expect(q.stacked, `${where}: phải xếp dọc`).toBe(true)
        if (w < 768) await touchAndInputs(page, where)
        await shot(page, `info-noselect-${w}-${theme}`)
      }
    })

    test(`UI-01 / UI-03 Kết quả + kiểm K 83 SP — 8 khổ, ${theme}: bảng dùng toàn chiều ngang, không cuộn ngang trang`, async ({ page }) => {
      for (const w of WIDTHS) {
        await openFx(page, 'wizard', 'result-k83', theme, w)
        const where = `result-k83 ${w} ${theme}`
        const g = await shellGeometry(page)
        expectShell(g, w, where)
        const widths = await page.evaluate(() => ['[data-cms-import-result]', '[data-cms-kcheck]', '[data-cms-commit-summary]'].map((s) => document.querySelector(`main ${s}`)?.getBoundingClientRect().width ?? -1))
        for (const x of widths) expect(Math.abs(x - g.bodyWidth), `${where}: khối kết quả không dùng toàn chiều ngang (${x} / ${g.bodyWidth})`).toBeLessThanOrEqual(TOL)
        // tóm tắt trước khi ghi nằm sát trên hàng nút ghi
        const near = await page.evaluate(() => {
          const s = document.querySelector('main [data-cms-commit-summary]')!.getBoundingClientRect(), b = document.querySelector('main [data-cms-commit]')!.getBoundingClientRect()
          return b.top - s.bottom
        })
        expect(near, `${where}: tóm tắt cách nút ghi`).toBeGreaterThanOrEqual(0)
        expect(near, `${where}: tóm tắt cách nút ghi`).toBeLessThanOrEqual(w < 640 ? 140 : 40)
        if (w < 768) await touchAndInputs(page, where)
        await shot(page, `result-k83-${w}-${theme}`)
      }
    })

    test(`UI-02 / UI-07 các trạng thái bổ sung — 360 + 1280, ${theme}`, async ({ page }) => {
      const CASES: ['wizard' | 'revision', string][] = [['wizard', 'info&b=on'], ['wizard', 'upload-v2'], ['wizard', 'running'], ['wizard', 'upload-wrong-format'], ['wizard', 'result-none'],
        ['wizard', 'result-issues-partial'], ['wizard', 'edit-active'], ['wizard', 'edit-invalid'], ['revision', 'upload']]
      for (const [pg, fx] of CASES) for (const w of [360, 1280]) {
        await openFx(page, pg, fx, theme, w)
        const where = `${pg}/${fx} ${w} ${theme}`
        const g = await shellGeometry(page)
        expectShell(g, w, where)
        if (pg === 'wizard' && fx.startsWith('upload')) {
          const p = await pair(page, '[data-cms-upload-main]', '[data-cms-upload-guide]')
          if (g.bodyWidth >= TWO_COL) {
            expect(p.sideBySide, `${where}: Upload phải hai cột`).toBe(true)
            expect(p.aw / p.bw, `${where}: tỉ lệ thao tác / hướng dẫn ≈ 2 : 1`).toBeGreaterThan(1.8)
            expect(p.aw / p.bw).toBeLessThan(2.2)
          } else expect(p.stacked, `${where}: Upload phải một cột`).toBe(true)
          await expect(page.locator('main [data-cms-file]')).toBeVisible()
        }
        if (w < 768) await touchAndInputs(page, where)
        await shot(page, `${pg}-${fx.replace(/[^a-z0-9]+/gi, '-')}-${w}-${theme}`)
      }
    })
  }

  test('UI-04 đổi khổ + theme KHÔNG remount form, giữ tên / ngày / phạm vi / cách tính; 0 request ghi', async ({ page }) => {
    const writes: string[] = []
    page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'HEAD' && !/_next|ui-catalog/.test(r.url())) writes.push(`${r.method()} ${r.url()}`) })
    await openFx(page, 'wizard', 'info', 'light', 1440)
    const form = page.locator('main form[data-cms-program-form]')
    await expect(form).toHaveCount(1)
    await form.getByRole('textbox').first().fill('CMS thử bố cục 22/11')
    await form.locator('input[type="date"]').first().fill('2026-12-01')
    await form.locator('input[type="date"]').nth(1).fill('2026-12-31')
    await form.getByLabel('Chọn nhà thuốc').check()
    const basis = form.locator('[data-cms-basis-option] input[type="radio"]')
    if (await basis.count()) await basis.first().check()
    await form.evaluate((el) => { (el as HTMLElement & { __cmsMark?: number }).__cmsMark = 1 })
    for (const w of [360, 1024, 2560]) {
      await page.setViewportSize({ width: w, height: 900 })
      await page.evaluate(() => { document.documentElement.classList.toggle('dark') })
      expect(await form.evaluate((el) => (el as HTMLElement & { __cmsMark?: number }).__cmsMark), `${w}: form bị remount`).toBe(1)
      await expect(form.getByRole('textbox').first()).toHaveValue('CMS thử bố cục 22/11')
      await expect(form.locator('input[type="date"]').first()).toHaveValue('2026-12-01')
      await expect(form.locator('input[type="date"]').nth(1)).toHaveValue('2026-12-31')
      await expect(form.getByLabel('Chọn nhà thuốc')).toBeChecked()
      if (await basis.count()) await expect(basis.first()).toBeChecked()
    }
    expect(writes).toEqual([])
  })

  test('UI-06 vùng chọn file: tới được bằng bàn phím và thấy focus; tên file dài không bị cắt ngoài khung', async ({ page }) => {
    await openFx(page, 'wizard', 'upload-v2', 'light', 1280)
    const pick = page.locator('main [data-cms-file-pick]')
    await pick.locator('input[type="file"]').focus()
    const ring = await pick.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(ring, 'vùng chọn file không có vòng focus').not.toBe('none')
    const f = await page.evaluate(() => {
      const el = document.querySelector('main [data-cms-file]') as HTMLElement
      return { sw: el.scrollWidth, cw: el.clientWidth, ws: getComputedStyle(el.querySelector('span')!).textOverflow }
    })
    expect(f.sw).toBeLessThanOrEqual(f.cw + 1)
    expect(f.ws).not.toBe('ellipsis')
  })

  // ───── r1 (audit PM 22/11 §4) ─────
  for (const theme of ['light', 'dark'] as Theme[]) for (const w of [1280, 1920]) {
    test(`§4.1 sidebar thu / mở ${w} ${theme}: khung vẫn phủ <main>, cột theo bề rộng nội dung, không reload / mất dữ liệu`, async ({ page }) => {
      let navs = 0
      page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) navs++ })
      await openFx(page, 'wizard', 'info&b=on', theme, w)
      const form = page.locator('main form[data-cms-program-form]')
      await form.getByRole('textbox').first().fill('Giữ qua sidebar')
      await form.evaluate((el) => { (el as HTMLElement & { __m?: number }).__m = 7 })
      const base = navs
      const widths: number[] = []
      for (const label of ['Thu gọn thanh điều hướng', 'Mở rộng thanh điều hướng']) {
        await page.getByRole('button', { name: label }).click()
        await page.waitForTimeout(400)
        const g = await shellGeometry(page)
        expectShell(g, w, `${label} ${w} ${theme}`)
        widths.push(g.bodyWidth)
        const p = await pair(page, '[data-cms-form-group="info"]', '[data-cms-form-group="basis"]')
        expect(g.bodyWidth >= TWO_COL ? p.sideBySide : p.stacked, `${label}: bố cục không theo bề rộng nội dung ${g.bodyWidth}`).toBe(true)
        await expect(form.getByRole('textbox').first()).toHaveValue('Giữ qua sidebar')
        expect(await form.evaluate((el) => (el as HTMLElement & { __m?: number }).__m)).toBe(7)
        await shot(page, `sidebar-${label.startsWith('Thu') ? 'thu' : 'mo'}-${w}-${theme}`)
      }
      expect(widths[0], 'thu sidebar phải làm nội dung rộng hơn').toBeGreaterThan(widths[1] + 100)
      expect(navs, 'đổi sidebar không được điều hướng / reload').toBe(base)
    })
  }

  // KHÔNG phải zoom trình duyệt: Playwright không điều khiển được zoom của Chrome. Đây là kiểm REFLOW ở bề rộng CSS tương đương
  // (1440 ÷ 1,25 = 1152; 1440 ÷ 2 = 720; 1920 ÷ 1,25 = 1536; 1920 ÷ 2 = 960). Zoom thật kiểm tay sau deploy.
  test('§4.2 reflow ở bề rộng tương đương zoom 125% / 200% (không phải zoom thật): không cuộn ngang, nút cuối trang không bị che', async ({ page }) => {
    for (const [fx, last] of [['info&b=on', 'main [data-cms-form-actions] button[type="submit"]'], ['result-k83', 'main [data-cms-commit]']] as const)
      for (const [w, h] of [[1152, 720], [720, 450], [1536, 720], [960, 450]] as const) {
        await openFx(page, 'wizard', fx, 'light', w)
        await page.setViewportSize({ width: w, height: h })
        const g = await shellGeometry(page)
        expect(g.docSw, `${fx} ${w}: trang cuộn ngang`).toBeLessThanOrEqual(g.iw + 1)
        expect(Math.abs(g.rootWidth - g.mainClient)).toBeLessThanOrEqual(TOL)
        const btn = page.locator(last)
        await btn.scrollIntoViewIfNeeded()
        const b = (await btn.boundingBox())!
        expect(b.x, `${fx} ${w}: nút cuối lệch trái`).toBeGreaterThanOrEqual(0)
        expect(b.x + b.width, `${fx} ${w}: nút cuối tràn phải`).toBeLessThanOrEqual(w + 1)
        const top = await btn.evaluate((el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && !!t.closest('[data-cms-wizard]') && r.top >= 0 && r.bottom <= window.innerHeight }) // nút khoá có pointer-events none ⇒ kiểm điểm đó vẫn thuộc khung wizard (không lớp phủ ngoài) + nằm trong khung nhìn
        expect(top, `${fx} ${w}: nút cuối bị che`).toBe(true)
        await shot(page, `reflow-${fx.replace(/[^a-z0-9]+/gi, '-')}-${w}`)
      }
  })

  test('§4.3a Upload: file đã chọn giữ nguyên khi đổi khổ / theme — input không remount, không thêm request', async ({ page }) => {
    const calls: string[] = []
    page.on('request', (r) => { if (/\/api\/cms\//.test(r.url()) || (r.method() !== 'GET' && r.method() !== 'HEAD')) calls.push(`${r.method()} ${new URL(r.url()).pathname}`) })
    await openFx(page, 'wizard', 'upload-v2', 'light', 1440)
    const input = page.locator('main [data-cms-file-pick] input[type="file"]')
    await input.setInputFiles({ name: 'Bo-cuc-thu-22-11.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK-fake') })
    await expect(page.locator('main [data-cms-file]')).toContainText('Bo-cuc-thu-22-11.xlsx')
    await input.evaluate((el) => { (el as HTMLElement & { __m?: number }).__m = 3 })
    const before = calls.length
    for (const w of [360, 1024, 2560]) {
      await page.setViewportSize({ width: w, height: 900 })
      await page.evaluate(() => { document.documentElement.classList.toggle('dark') })
      expect(await input.evaluate((el) => ({ m: (el as HTMLInputElement & { __m?: number }).__m, n: (el as HTMLInputElement).files?.length, name: (el as HTMLInputElement).files?.[0]?.name })), `${w}`)
        .toEqual({ m: 3, n: 1, name: 'Bo-cuc-thu-22-11.xlsx' })
      await expect(page.locator('main [data-cms-file]')).toContainText('Bo-cuc-thu-22-11.xlsx')
      await expect(page.locator('main [data-cms-import-flow]')).toHaveAttribute('data-cms-import-flow', 'upload')
    }
    expect(calls.slice(before), 'đổi khổ / theme sinh request').toEqual([])
  })

  test('§4.3b Kết quả K: tick + nguồn giữ nguyên khi đổi khổ / theme, trạng thái khoá nút ghi không đổi, 0 request', async ({ page }) => {
    const calls: string[] = []
    page.on('request', (r) => { if (/\/api\/cms\//.test(r.url()) || (r.method() !== 'GET' && r.method() !== 'HEAD')) calls.push(`${r.method()} ${new URL(r.url()).pathname}`) })
    await openFx(page, 'wizard', 'result-k83', 'light', 1440)
    const row = page.locator('main [data-cms-k-row]').filter({ has: page.locator('input[type="checkbox"]:not(:disabled)') }).first()
    const pid = await row.getAttribute('data-cms-k-row')
    await row.getByRole('checkbox').check()
    await row.getByRole('textbox').fill('https://nguon.example/quy-cach')
    await row.evaluate((el) => { (el as HTMLElement & { __m?: number }).__m = 5 })
    const commit = page.locator('main [data-cms-commit]')
    const lock = { block: await commit.getAttribute('data-cms-commit-block'), disabled: await commit.isDisabled() }
    expect(lock.disabled, 'còn nháp K chưa gửi ⇒ nút ghi phải khoá').toBe(true)
    const before = calls.length
    for (const w of [360, 1024, 2560]) {
      await page.setViewportSize({ width: w, height: 900 })
      await page.evaluate(() => { document.documentElement.classList.toggle('dark') })
      const r = page.locator(`main [data-cms-k-row="${pid}"]`)
      expect(await r.evaluate((el) => (el as HTMLElement & { __m?: number }).__m), `${w}: dòng K bị remount`).toBe(5)
      await expect(r.getByRole('checkbox')).toBeChecked()
      await expect(r.getByRole('textbox')).toHaveValue('https://nguon.example/quy-cach')
      expect({ block: await commit.getAttribute('data-cms-commit-block'), disabled: await commit.isDisabled() }, `${w}: trạng thái khoá đổi`).toEqual(lock)
    }
    expect(calls.slice(before), 'đổi khổ / theme sinh request').toEqual([])
  })
})
