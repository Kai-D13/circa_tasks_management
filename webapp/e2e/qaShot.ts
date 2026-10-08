import fs from 'node:fs'
import type { Locator } from '@playwright/test'

// Ảnh QA (qa-artifacts/, gitignored) cho spec CRM. Windows Defender real-time quét PNG
// vừa ghi ⇒ ghi đè lần chạy sau đôi khi gặp `UNKNOWN: open` (khoá tạm thời). Chụp ra
// buffer rồi ghi có thử lại ngắn — ảnh chỉ là bằng chứng, không phải assert UI.
export async function saveLocatorShot(locator: Locator, file: string): Promise<void> {
  const buf = await locator.screenshot()
  for (let attempt = 1; ; attempt++) {
    try { fs.writeFileSync(file, buf); return } catch (e) {
      if (attempt >= 6) throw e
      await new Promise((r) => setTimeout(r, 250 * attempt))
    }
  }
}
