#!/usr/bin/env node
// Sinh file mẫu import CMS r2 (9 cột, ProductID giả 999xxx) ra webapp/public/templates/Circa_Import_CMS.xlsx từ CHÍNH
// lib/cms/import/workbooks.ts (nạp qua jiti — devDependency). Chạy lại khi đổi template; spec cms-p1b-import kiểm file
// tĩnh khớp bộ sinh.  node scripts/gen-cms-import-template.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const jiti = createJiti(import.meta.url, { interopDefault: true })
const { buildCmsImportTemplateXlsx } = await jiti.import(path.join(ROOT, 'lib/cms/import/workbooks.ts'))
const out = path.join(ROOT, 'public', 'templates', 'Circa_Import_CMS.xlsx')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, buildCmsImportTemplateXlsx())
console.log(`đã ghi ${path.relative(ROOT, out)} (${fs.statSync(out).size} byte)`)
