import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, STAFF_STATE } from './authState'

// ─────────────────────────────────────────────────────────────────────────────
// QR AFFILIATE — DISCLOSURE COMPACT (Step 3.1), hợp đồng RUNTIME
//
// Ảnh QR 220–240px trước đây chiếm gần trọn first viewport ở 360px và đẩy danh
// sách chiến dịch xuống dưới màn. Dưới `md` giờ chỉ còn một hàng compact; ảnh
// CHỈ MOUNT sau khi mở — không phải ẩn bằng CSS. Đó là khác biệt mà suite này
// tồn tại để khoá: `hidden md:block` vẫn để <img> nằm trong DOM và vẫn có thể
// tải ảnh, tức mục tiêu chỉ đạt một nửa mà test đọc thì vẫn "xanh".
//
// PHỤ THUỘC DỮ LIỆU: cửa hàng của tài khoản chạy test phải có QR đã cấu hình.
// Nếu chưa, card hiện trạng thái 'missing' — suite vẫn kiểm ĐÚNG yêu cầu
// "missing phải hiện ngay, không bắt mở disclosure" rồi skip phần ảnh, thay vì
// đỏ vì lý do vận hành. Không có card (flag tắt / role không hợp lệ) → skip.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL = process.env.E2E_STAFF_EMAIL
const PASSWORD = process.env.E2E_STAFF_PASSWORD
const QLCH_EMAIL = process.env.E2E_QLCH_EMAIL
const QLCH_PASSWORD = process.env.E2E_QLCH_PASSWORD

const CARD = 'text=Mã QR Circa Online'
const QR_IMG = 'img[alt^="Mã QR Affiliate"]'

// Locator PHẢI bọc trong card QR, không quét cả trang: nhánh QLCH có những
// control aria-expanded khác trên cùng landing, `.first()` toàn trang bắt nhầm
// nút rồi test đỏ ở chỗ chẳng liên quan (đã dính đúng bẫy này).
function qrCard(page: Page) {
  return page.locator('[data-slot="card"]').filter({ hasText: 'Mã QR Circa Online' }).first()
}
function qrToggle(page: Page) {
  return qrCard(page).locator('button[aria-controls][aria-expanded]')
}
function qrImg(page: Page) {
  return qrCard(page).locator(QR_IMG)
}

async function gotoTargets(page: Page) {
  await page.goto('/targets')
  await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn (xoá e2e/.auth rồi chạy lại)')
    .toHaveURL(/\/targets(\?|$)/)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

// Trả về 'qr' | 'missing' | 'absent' để mỗi test tự quyết định chạy tiếp hay skip.
async function qrCardMode(page: Page): Promise<'qr' | 'missing' | 'absent'> {
  if (await page.locator(CARD).count() === 0) return 'absent'
  const body = await page.locator('body').innerText()
  if (body.includes('Chưa cấu hình mã QR') || body.includes('Không tải được mã QR')) return 'missing'
  return 'qr'
}

// Mốc so sánh thứ tự: đáy của card chiến dịch CUỐI CÙNG. Không có chiến dịch
// nào thì lấy đáy empty-state, cuối cùng mới tới <h1> — luôn có một mốc thật
// để so, thay vì tụt xuống một phép so vô nghĩa với 0.
// Cùng một frame nên cả hai rect chịu cùng lượng cuộn ⇒ so trực tiếp là đúng.
async function measureOrder(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main')
    if (!main) return null
    const qrTitle = [...main.querySelectorAll('p')].find((el) => el.textContent?.trim() === 'Mã QR Circa Online')
    const qrCard = qrTitle?.closest('[data-slot="card"]') ?? qrTitle
    if (!qrCard) return null

    const links = [...main.querySelectorAll('a[href*="campaign="]')]
    if (links.length > 0) {
      return {
        qrTop: qrCard.getBoundingClientRect().top,
        refBottom: Math.max(...links.map((a) => a.getBoundingClientRect().bottom)),
        refName: `card chiến dịch cuối (${links.length} card)`,
      }
    }
    const empty = [...main.querySelectorAll('*')].find((el) => /chưa có chiến dịch/i.test(el.textContent ?? '')
      && el.children.length === 0)
    const ref = empty ?? main.querySelector('h1')
    if (!ref) return null
    return {
      qrTop: qrCard.getBoundingClientRect().top,
      refBottom: ref.getBoundingClientRect().bottom,
      refName: empty ? 'empty-state chiến dịch' : 'tiêu đề trang',
    }
  })
}

test.describe('qr disclosure @mobile', () => {
  test.use({ storageState: STAFF_STATE, viewport: { width: 360, height: 800 } })
  test.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD chưa set')

  test('đóng mặc định: ảnh QR KHÔNG nằm trong DOM (không phải chỉ bị ẩn)', async ({ page }) => {
    await gotoTargets(page)
    const mode = await qrCardMode(page)
    test.skip(mode === 'absent', 'không render QR card (flag tắt hoặc role không hợp lệ)')

    if (mode === 'missing') {
      // Yêu cầu: trạng thái lỗi/chưa cấu hình hiện NGAY, không giấu sau disclosure.
      await expect(qrToggle(page), 'missing/error không được có disclosure').toHaveCount(0)
      await expect(qrImg(page)).toHaveCount(0)
      return
    }

    // Chốt chính: count === 0 ⇒ không có <img> nào, khác hẳn "có nhưng display:none".
    await expect(qrImg(page), 'ảnh QR vẫn nằm trong DOM khi đóng').toHaveCount(0)
    const toggle = qrToggle(page)
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Vùng chạm 44px (rem co 6.25% ở root 15px nên phải đo pixel thật).
    const box = await toggle.boundingBox()
    expect(box!.height, `nút mở QR cao ${box!.height}px`).toBeGreaterThanOrEqual(44)
  })

  test('mở bằng CLICK → ảnh mount; đóng → unmount', async ({ page }) => {
    await gotoTargets(page)
    test.skip(await qrCardMode(page) !== 'qr', 'store chưa cấu hình QR')

    const toggle = qrToggle(page)
    await toggle.click()
    await expect(qrImg(page).first(), 'mở rồi mà ảnh không xuất hiện').toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await toggle.click()
    await expect(qrImg(page), 'đóng rồi mà ảnh vẫn còn trong DOM').toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  test('mở bằng BÀN PHÍM (Enter) → ảnh mount', async ({ page }) => {
    await gotoTargets(page)
    test.skip(await qrCardMode(page) !== 'qr', 'store chưa cấu hình QR')

    const toggle = qrToggle(page)
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(qrImg(page).first()).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  // Đường NGƯỜI DÙNG THẬT đi: modal là dialog modal, backdrop của nó chặn mọi
  // pointer event ở dưới ⇒ KHÔNG bấm được nút thu gọn khi modal đang mở. Phải
  // đóng modal trước (Escape / nút X) rồi mới thu gọn được.
  test('modal: Escape đóng modal, sau đó thu gọn sạch cả ảnh lẫn modal', async ({ page }) => {
    await gotoTargets(page)
    test.skip(await qrCardMode(page) !== 'qr', 'store chưa cấu hình QR')

    const toggle = qrToggle(page)
    await toggle.click()
    await page.getByRole('button', { name: 'Phóng to mã QR' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0)

    await toggle.click()
    await expect(qrImg(page), 'thu gọn rồi mà ảnh vẫn còn').toHaveCount(0)
    await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0)
  })

  // KHÔNG có test runtime cho "thu gọn TRONG KHI modal đang mở".
  // Đã thử và không làm được: modal của base-ui dựng backdrop + lớp inert nuốt
  // mọi pointer event ở dưới, nên cả click thường lẫn `force: true` đều không
  // tới được nút thu gọn — test viết ra chỉ đỏ vì lý do kỹ thuật, không phản
  // ánh hành vi sản phẩm. Invariant đó khoá bằng hàm thuần `qrToggleState`
  // (e2e/affiliate-qr-display.spec.ts), là chỗ duy nhất kiểm được nó.
  //
  // Ghi lại vì nó đã bắt bug thật: bản đầu gọi setOpenUrl BÊN TRONG updater của
  // setExpanded — updater phải thuần nên modal không đóng theo.

  test('thứ tự: card QR nằm SAU danh sách chiến dịch', async ({ page }) => {
    await gotoTargets(page)
    test.skip(await qrCardMode(page) === 'absent', 'không render QR card')

    const geom = await measureOrder(page)
    expect(geom, 'không đo được (thiếu card QR hoặc mốc so sánh)').not.toBeNull()
    // So MỐC THẬT chứ không phải `> 0`: `toBeGreaterThan(0)` vẫn xanh kể cả khi
    // QR nằm ngay đầu trang ở y=1, tức không khoá được thứ tự nào cả.
    expect(
      geom!.qrTop,
      `card QR (top ${geom!.qrTop}px) nằm TRƯỚC ${geom!.refName} (đáy ${geom!.refBottom}px)`,
    ).toBeGreaterThanOrEqual(geom!.refBottom)
  })
})

test.describe('qr desktop giữ nguyên @desktop', () => {
  test.use({ storageState: STAFF_STATE })
  test.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD chưa set')

  test('desktop: ảnh hiện NGAY, không cần mở disclosure', async ({ page }) => {
    await gotoTargets(page)
    test.skip(await qrCardMode(page) !== 'qr', 'store chưa cấu hình QR')

    // Hình thức desktop đã được stakeholder duyệt — disclosure không được
    // chạm tới nó. Ảnh phải có mặt mà không thao tác gì.
    await expect(qrImg(page).first()).toBeVisible()
    // Hàng compact vẫn nằm trong DOM (md:hidden) nhưng KHÔNG được nhìn thấy.
    const toggle = qrToggle(page)
    if (await toggle.count() > 0) await expect(toggle).toBeHidden()
  })
})

// ── QLCH (store_manager) ────────────────────────────────────────────────────
// Nhánh render RIÊNG (targets/page.tsx:616) nhưng DÙNG CHUNG CampaignCardList
// và AffiliateQrCard với Staff. Suite Staff ở trên không chạm tới nhánh này,
// nên sửa component mà chỉ chạy Staff là kiểm được đúng một nửa.
test.describe('qr disclosure QLCH @mobile', () => {
  test.use({ storageState: MANAGER_STATE, viewport: { width: 390, height: 844 } })
  test.skip(!QLCH_EMAIL || !QLCH_PASSWORD, 'E2E_QLCH_EMAIL / E2E_QLCH_PASSWORD chưa set')

  test('QLCH mobile: QR compact sau danh sách, mở thì ảnh xuất hiện', async ({ page }) => {
    await gotoTargets(page)
    const mode = await qrCardMode(page)
    test.skip(mode === 'absent', 'QLCH không render QR card (flag/role/store)')

    // Thứ tự phải đúng ở CẢ nhánh QLCH, không riêng Staff.
    const geom = await measureOrder(page)
    expect(geom, 'không đo được thứ tự trên nhánh QLCH').not.toBeNull()
    expect(
      geom!.qrTop,
      `QLCH: card QR (top ${geom!.qrTop}px) nằm TRƯỚC ${geom!.refName} (đáy ${geom!.refBottom}px)`,
    ).toBeGreaterThanOrEqual(geom!.refBottom)

    if (mode === 'missing') {
      await expect(qrToggle(page), 'missing/error không được có disclosure').toHaveCount(0)
      return
    }
    await expect(qrImg(page), 'QLCH: ảnh QR vẫn trong DOM khi đóng').toHaveCount(0)
    const toggle = qrToggle(page)
    await toggle.click()
    await expect(qrImg(page).first()).toBeVisible()
  })
})

test.describe('qr desktop QLCH giữ nguyên @desktop', () => {
  test.use({ storageState: MANAGER_STATE })
  test.skip(!QLCH_EMAIL || !QLCH_PASSWORD, 'E2E_QLCH_EMAIL / E2E_QLCH_PASSWORD chưa set')

  test('QLCH desktop: ảnh hiện ngay, không cần mở disclosure', async ({ page }) => {
    await gotoTargets(page)
    test.skip(await qrCardMode(page) !== 'qr', 'QLCH store chưa cấu hình QR')
    await expect(qrImg(page).first()).toBeVisible()
  })
})
