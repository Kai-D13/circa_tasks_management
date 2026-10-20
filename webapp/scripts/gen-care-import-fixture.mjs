// CRM-CSKH B0 — sinh file import GIẢ dạng CSV UTF-8 (Q-124; 25 store, 10 header)
// từ chính builder mà Playwright dùng (e2e/careImportFixture.ts), để QA tay/thử
// wizard B2 bằng đúng dữ liệu test. Không có PII thật.
//
//   node scripts/gen-care-import-fixture.mjs <đường-dẫn-ra.csv> [--per-store N]
//
// Node ≥ 22.18/24 chạy thẳng file .ts (type stripping). Không ghi ra ngoài đường
// dẫn được chỉ định; KHÔNG commit file sinh ra (dùng thư mục tạm).
import fs from 'node:fs'
import path from 'node:path'
import { buildCareImportCsv, buildCareImportRows } from '../e2e/careImportFixture.ts'

const args = process.argv.slice(2)
const out = args.find((a) => !a.startsWith('--'))
if (!out) {
  console.error('Cách dùng: node scripts/gen-care-import-fixture.mjs <out.csv> [--per-store N]')
  process.exit(1)
}
const perIdx = args.indexOf('--per-store')
const customersPerStore = perIdx >= 0 ? Number(args[perIdx + 1]) : undefined
if (customersPerStore !== undefined && !(Number.isInteger(customersPerStore) && customersPerStore > 0)) {
  console.error('--per-store phải là số nguyên dương')
  process.exit(1)
}

const opts = customersPerStore ? { customersPerStore } : {}
const buf = buildCareImportCsv(opts)
fs.writeFileSync(path.resolve(out), buf)
const rows = buildCareImportRows(opts)
const customers = new Set(rows.map((r) => r.customer_external_id)).size
const stores = new Set(rows.map((r) => r.target_store_code)).size
console.log(`Đã ghi ${path.resolve(out)} — ${rows.length} dòng sản phẩm, ${customers} khách, ${stores} store, ${buf.length} byte`)
