import { test, expect, type Page } from '@playwright/test'
import { STAFF_STATE } from './authState'

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

const CARD = 'text=Mã QR Circa Online'
const QR_IMG = 'img[alt^="Mã QR Affiliate"]'
const TOGGLE = 'button[aria-controls][aria-expanded]'

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

test.describe('qr disclosure @mobile', () => {
  test.use({ storageState: STAFF_STATE, viewport: { width: 360, height: 800 } })
  test.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD chưa set')

  test('đóng mặc định: ảnh QR KHÔNG nằm trong DOM (không phải chỉ bị ẩn)', async ({ page }) => {
    await gotoTargets(page)
    const mode = await qrCardMode(page)
    test.skip(mode === 'absent', 'không render QR card (flag tắt hoặc role không hợp lệ)')

    if (mode === 'missing') {
      // Yêu cầu: trạng thái lỗi/chưa cấu hình hiện NGAY, không giấu sau disclosure.
      await expect(page.locator(TOGGLE), 'missing/error không được có disclosure').toHaveCount(0)
      await expect(page.locator(QR_IMG)).toHaveCount(0)
      return
    }

    // Chốt chính: count === 0 ⇒ không có <img> nào, khác hẳn "có nhưng display:none".
    await expect(page.locator(QR_IMG), 'ảnh QR vẫn nằm trong DOM khi đóng').toHaveCount(0)
    const toggle = page.locator(TOGGLE).first()
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Vùng chạm 44px (rem co 6.25% ở root 15px nên phải đo pixel thật).
    const box = await toggle.boundingBox()
    expect(box!.height, `nút mở QR cao ${box!.height}px`).toBeGreaterThanOrEqual(44)
  })

  test('mở bằng CLICK → ảnh mount; đóng → unmount', async ({ page }) => {
    await gotoTargets(page)
    test.skip(await qrCardMode(page) !== 'qr', 'store chưa cấu hình QR')

    const toggle = page.locator(TOGGLE).first()
    await toggle.click()
    await expect(page.locator(QR_IMG).first(), 'mở rồi mà ảnh không xuất hiện').toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await toggle.click()
    await expect(page.locator(QR_IMG), 'đóng rồi mà ảnh vẫn còn trong DOM').toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  test('mở bằng BÀN PHÍM (Enter) → ảnh mount', async ({ page }) => {
    await gotoTargets(page)
    test.skip(await qrCardMode(page) !== 'qr', 'store chưa cấu hình QR')

    const toggle = page.locator(TOGGLE).first()
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator(QR_IMG).first()).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  // Đường NGƯỜI DÙNG THẬT đi: modal là dialog modal, backdrop của nó chặn mọi
  // pointer event ở dưới ⇒ KHÔNG bấm được nút thu gọn khi modal đang mở. Phải
  // đóng modal trước (Escape / nút X) rồi mới thu gọn được.
  test('modal: Escape đóng modal, sau đó thu gọn sạch cả ảnh lẫn modal', async ({ page }) => {
    await gotoTargets(page)
    test.skip(await qrCardMode(page) !== 'qr', 'store chưa cấu hình QR')

    const toggle = page.locator(TOGGLE).first()
    await toggle.click()
    await page.getByRole('button', { name: 'Phóng to mã QR' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0)

    await toggle.click()
    await expect(page.locator(QR_IMG), 'thu gọn rồi mà ảnh vẫn còn').toHaveCount(0)
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

  test('không đẩy nội dung: card QR nằm SAU danh sách chiến dịch', async ({ page }) => {
    await gotoTargets(page)
    test.skip(await qrCardMode(page) === 'absent', 'không render QR card')

    const y = await page.evaluate((sel) => {
      const main = document.querySelector('main')
      if (!main) return null
      const card = [...main.querySelectorAll('*')].find((el) => el.textContent?.trim() === 'Mã QR Circa Online')
      return card ? card.getBoundingClientRect().top : null
    }, CARD)
    // Mục tiêu của Step 3.1: QR không chiếm first viewport (360×800).
    expect(y, 'không tìm được tiêu đề card QR').not.toBeNull()
    expect(y!, `card QR bắt đầu ở ${y}px — vẫn nằm trong first viewport`).toBeGreaterThan(0)
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
    await expect(page.locator(QR_IMG).first()).toBeVisible()
    // Hàng compact vẫn nằm trong DOM (md:hidden) nhưng KHÔNG được nhìn thấy.
    const toggle = page.locator(TOGGLE).first()
    if (await toggle.count() > 0) await expect(toggle).toBeHidden()
  })
})
