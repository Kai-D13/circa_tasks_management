import { test, expect, type Page } from '@playwright/test'
import { STAFF_STATE } from './authState'

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT SHEET (MobileHeader) — hợp đồng RUNTIME
//
// M1.1 (audit P1#2). M1 gom bốn nút icon trên header mobile vào một bottom
// sheet mở từ avatar, và dialog con (Sửa hồ sơ / Đổi mật khẩu) phải mount NGOÀI
// sheet: base-ui Popup có `translate` nên nó thành containing block, dialog con
// lồng bên trong sẽ bám vào sheet chứ không bám viewport. Cơ chế: bấm hàng ⇒
// đóng sheet ⇒ đợi animation xong (`onOpenChangeComplete`, kèm lưới an toàn
// 300ms) ⇒ mới mount dialog con.
//
// Đây là loại logic KHÔNG test tĩnh được: không có hàm thuần nào để gọi, sai
// thì biểu hiện là hai lớp nổi chồng nhau hoặc trang kẹt scroll-lock — chỉ thấy
// khi chạy thật. Suite này khoá đúng các invariant đó:
//   · avatar mở ĐÚNG MỘT sheet
//   · sheet đủ bốn hàng (Sửa hồ sơ · Đổi mật khẩu · Giao diện · Đăng xuất)
//   · bấm hàng ⇒ sheet ĐÓNG rồi dialog con MỞ (không bao giờ cùng lúc)
//   · đóng dialog con KHÔNG mở lại sheet
//   · đổi giao diện đổi thật theme
//   · không bao giờ hai overlay cùng lúc, và scroll-lock luôn được trả lại
//   · focus vào TRONG dialog khi mở, và QUAY VỀ AVATAR khi đóng (M1.2)
//
// Focus (M1.2, audit P2): dialog con mount SAU khi sheet và hàng bấm vào đã
// unmount, nên mặc định "trả focus về trigger hoặc phần tử vừa focus" của
// base-ui không còn gì để bám — focus rơi về <body>, người dùng bàn phím /
// screen reader mất chỗ đứng. Đã truyền `finalFocus` đích danh nút avatar;
// suite này khoá điều đó cho CẢ Huỷ lẫn Escape.
//
// Cần tài khoản STAFF: hàng "Sửa hồ sơ" chỉ render cho role staff.
// Thiếu E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD thì skip, không đỏ.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL = process.env.E2E_STAFF_EMAIL
const PASSWORD = process.env.E2E_STAFF_PASSWORD

const POPUP = '[data-slot="dialog-content"]'
const OVERLAY = '[data-slot="dialog-overlay"]'

// Mô tả phần tử đang giữ focus — đủ để đọc ra "đang ở đâu" khi assert đỏ.
async function focusInfo(page: Page) {
  return page.evaluate((popupSel) => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return { where: 'body', label: null as string | null }
    return {
      where: el.closest(popupSel) ? 'dialog' : 'page',
      label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName,
    }
  }, POPUP)
}

async function expectFocusInsideDialog(page: Page, where: string) {
  await expect
    .poll(async () => (await focusInfo(page)).where, { message: `${where}: focus không nằm trong dialog` })
    .toBe('dialog')
}

// Đóng dialog xong focus PHẢI về nút avatar, không rơi về <body>.
async function expectFocusBackOnAvatar(page: Page, where: string) {
  await expect
    .poll(async () => (await focusInfo(page)).label, { message: `${where}: focus không quay lại nút avatar` })
    .toBe('Tài khoản')
}

// Scroll-lock: không phụ thuộc chi tiết cài đặt của base-ui (overflow hidden,
// padding bù thanh cuộn…). Chụp trạng thái LÚC CHƯA MỞ GÌ rồi so lại sau khi
// đóng hết — kẹt lock kiểu gì cũng lệch.
async function scrollLockState(page: Page) {
  return page.evaluate(() => {
    const body = getComputedStyle(document.body)
    const html = getComputedStyle(document.documentElement)
    return `${html.overflow}|${body.overflow}|${body.paddingRight}|${body.position}`
  })
}

// Một lớp nổi tại một thời điểm. Hai overlay = sheet chưa gỡ mà dialog con đã
// mount ⇒ đúng lỗi mà `onOpenChangeComplete` sinh ra để tránh.
// Đếm theo DOM (`data-slot`) chứ KHÔNG theo role: dialog modal của base-ui gắn
// aria-hidden lên phần còn lại của trang, nên `getByRole('dialog')` sẽ báo 0
// cho một sheet còn sót lại — đúng thứ cần bắt thì lại vô hình.
async function expectSingleLayer(page: Page, where: string) {
  await expect(page.locator(OVERLAY), `${where}: phải có đúng MỘT overlay`).toHaveCount(1)
  await expect(page.locator(POPUP), `${where}: phải có đúng MỘT lớp nổi`).toHaveCount(1)
}

function sheet(page: Page) {
  return page.getByRole('dialog', { name: 'Tài khoản' })
}

async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'Tài khoản' }).click()
  await expect(sheet(page), 'avatar không mở được account sheet').toBeVisible()
}

test.describe('account sheet (MobileHeader) @mobile', () => {
  // M1.2: dùng chung phiên đã đăng nhập (e2e/auth.setup.ts), context vẫn riêng.
  test.use({ storageState: STAFF_STATE })

  test.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD chưa set')

  test.beforeEach(async ({ page }) => {
    await page.goto('/tasks')
    await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn (xoá e2e/.auth rồi chạy lại)')
      .toHaveURL(/\/tasks(\?|$)/)
  })

  test('avatar mở đúng một sheet, đủ bốn hàng', async ({ page }) => {
    const before = await scrollLockState(page)

    await openSheet(page)
    await expectSingleLayer(page, 'sheet vừa mở')

    const rows = sheet(page)
    await expect(
      rows.getByRole('button', { name: 'Sửa hồ sơ' }),
      'thiếu hàng "Sửa hồ sơ" — tài khoản chạy test không phải staff?',
    ).toBeVisible()
    await expect(rows.getByRole('button', { name: 'Đổi mật khẩu' })).toBeVisible()
    await expect(rows.getByRole('button', { name: 'Đổi giao diện' })).toBeVisible()
    await expect(rows.getByRole('button', { name: 'Đăng xuất' })).toBeVisible()

    await expectFocusInsideDialog(page, 'sheet vừa mở')

    await page.keyboard.press('Escape')
    await expect(page.locator(POPUP), 'Escape không đóng sheet').toHaveCount(0)
    await expectFocusBackOnAvatar(page, 'đóng sheet bằng Escape')
    await expect
      .poll(() => scrollLockState(page), { message: 'scroll-lock không được trả lại sau khi đóng sheet' })
      .toBe(before)
  })

  // Hai hàng cùng cơ chế requestChild ⇒ khoá cả hai, không chỉ một.
  // Hai đường đóng (Huỷ / Escape) đi qua hai nhánh khác nhau của base-ui
  // (`Close` vs dismiss bằng bàn phím) ⇒ khoá cả hai, vì focus restoration chỉ
  // hỏng ở một nhánh là đủ để người dùng bàn phím mất chỗ đứng.
  for (const row of [
    { label: 'Sửa hồ sơ',    dialog: 'Sửa thông tin cá nhân' },
    { label: 'Đổi mật khẩu', dialog: 'Đổi mật khẩu' },
  ]) {
    for (const closeBy of ['Huỷ', 'Escape'] as const) {
      test(`"${row.label}" — sheet đóng rồi dialog con mở, đóng bằng ${closeBy} trả focus về avatar`, async ({ page }) => {
        const before = await scrollLockState(page)

        await openSheet(page)
        await sheet(page).getByRole('button', { name: row.label }).click()

        const child = page.getByRole('dialog', { name: row.dialog })
        await expect(child, `bấm "${row.label}" không mở được dialog con`).toBeVisible()

        // Sheet phải đã gỡ hẳn — invariant chính của requestChild. Gate THẬT là
        // expectSingleLayer (đếm DOM); dòng role ở đây chỉ là mô tả bổ sung.
        await expectSingleLayer(page, `dialog con "${row.dialog}"`)
        await expect(sheet(page), 'sheet vẫn còn khi dialog con đã mở').toHaveCount(0)
        await expectFocusInsideDialog(page, `dialog con "${row.dialog}"`)

        if (closeBy === 'Huỷ') {
          await child.getByRole('button', { name: 'Huỷ' }).click()
        } else {
          await page.keyboard.press('Escape')
        }

        await expect(page.locator(POPUP), 'đóng dialog con xong vẫn còn lớp nổi (sheet mở lại?)').toHaveCount(0)
        await expectFocusBackOnAvatar(page, `đóng "${row.dialog}" bằng ${closeBy}`)
        await expect
          .poll(() => scrollLockState(page), { message: 'scroll-lock không được trả lại sau khi đóng dialog con' })
          .toBe(before)
      })
    }
  }

  test('hàng "Giao diện" đổi thật theme, sheet vẫn mở', async ({ page }) => {
    await openSheet(page)

    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
    const start = await isDark()

    await sheet(page).getByRole('button', { name: 'Đổi giao diện' }).click()
    await expect.poll(isDark, { message: 'bấm "Giao diện" không đổi theme' }).toBe(!start)

    // Đổi giao diện là hành động tại chỗ, KHÔNG được đóng sheet (khác hai hàng
    // mở dialog con) — người dùng còn có thể bấm tiếp hàng khác.
    await expect(sheet(page), 'đổi giao diện làm đóng sheet').toBeVisible()
    await expectSingleLayer(page, 'sau khi đổi giao diện')

    // Trả về trạng thái ban đầu để không rớt theme sang test kế (dùng chung
    // localStorage khi ai đó chạy với storageState).
    await sheet(page).getByRole('button', { name: 'Đổi giao diện' }).click()
    await expect.poll(isDark).toBe(start)
  })
})
