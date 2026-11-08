#!/usr/bin/env node
// Sinh file mẫu import CMS ra webapp/public/templates/ từ CHÍNH lib/cms/import/workbooks.ts (nạp qua jiti — devDependency):
//   Circa_Import_CMS.xlsx            — mẫu r2 9 cột nhiều bậc (ProductID giả 999xxx);
//   Circa_Import_CMS_muc_co_dinh.xlsx — CMS đơn giản S1 (PM 08/11): 7 cột business + 2 cột bổ sung (K, tư vấn), ProductID giả.
// Chạy lại khi đổi template; spec cms-p1b-import / cms-simple-import kiểm file tĩnh khớp bộ sinh.  node scripts/gen-cms-import-template.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const jiti = createJiti(import.meta.url, { interopDefault: true })
const { buildCmsImportTemplateXlsx, buildCmsSimpleTemplateXlsx } = await jiti.import(path.join(ROOT, 'lib/cms/import/workbooks.ts'))
for (const [name, build] of [['Circa_Import_CMS.xlsx', buildCmsImportTemplateXlsx], ['Circa_Import_CMS_muc_co_dinh.xlsx', buildCmsSimpleTemplateXlsx]]) {
  const out = path.join(ROOT, 'public', 'templates', name)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, build())
  console.log(`đã ghi ${path.relative(ROOT, out)} (${fs.statSync(out).size} byte)`)
}
