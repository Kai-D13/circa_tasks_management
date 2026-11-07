// CMS-UNCAPPED-1 — nạp module app CŨ (commit 60a2231 = candidate trước CMS-Q-220, engine còn TRẦN ở bậc cuối hữu hạn) cho harness QA
// cần dữ liệu "lịch sử": run công bố / đóng băng theo luật cũ (at_cap, dòng AT_CAP). Giải nén `git archive <sha> webapp/lib` vào
// webapp/qa-artifacts/ (gitignore) một lần; module nạp qua jiti với alias '@' trỏ cây cũ — không đụng cây làm việc / Git index.
// Chỉ dùng trong QA local (PGlite / PG15 nhúng). Không phải đường chạy app.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
export const CMS_LEGACY_SHA = '60a223101294ed001c864f92c4116fac561472c0'
export const CMS_LEGACY_DIR = path.join(HERE, '..', 'qa-artifacts', 'cms125-legacy-60a2231')

/** Giải nén (nếu chưa có) và kiểm đúng là bản TRƯỚC CMS-Q-220; trả hàm nạp module theo đường dẫn tương đối webapp/. */
export function cmsLegacy() {
  if (!fs.existsSync(path.join(CMS_LEGACY_DIR, 'webapp', 'lib', 'cms', 'salesSync.ts'))) {
    fs.mkdirSync(CMS_LEGACY_DIR, { recursive: true })
    const tar = execFileSync('git', ['-C', REPO, 'archive', '--format=tar', CMS_LEGACY_SHA, 'webapp/lib'], { maxBuffer: 512 << 20 })
    const x = spawnSync('tar', ['-xf', '-', '-C', CMS_LEGACY_DIR], { input: tar })
    if (x.status !== 0) throw new Error(`giải nén app cũ lỗi: ${x.stderr}`)
  }
  const cfg = fs.readFileSync(path.join(CMS_LEGACY_DIR, 'webapp', 'lib', 'cms', 'engine', 'config.ts'), 'utf8')
  const isLegacy = !cfg.includes('FINITE_LAST_TIER') && cfg.includes('capQuantity: tiers[tiers.length - 1].to')
  const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(CMS_LEGACY_DIR, 'webapp') } })
  return { isLegacy, load: (rel) => jiti.import(path.join(CMS_LEGACY_DIR, 'webapp', rel)) }
}
