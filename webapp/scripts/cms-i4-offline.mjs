#!/usr/bin/env node
// CMS I4 — công cụ OFFLINE kiểm nguồn + đối soát cả kỳ (PM 04/11 §I4; checklist planning/research/cms-i4-bi-checklist.md
// §2.5, §4 N4a / N4b). Không mạng, không DB, không BigQuery: chỉ đọc file BI / operator đã xuất. Lõi thuần ở
// e2e/cmsI4Offline.ts — đi qua CHÍNH normalize / quality / mapping / engine của app.
//
//   node scripts/cms-i4-offline.mjs check-products --products=<csv>
//   node scripts/cms-i4-offline.mjs check-sales --sales=<csv> [--context=<json>]            (context ⇒ kỳ + SP + mapping)
//   node scripts/cms-i4-offline.mjs n4a --sales=<csv> [--context=<json>] --out=<md>          (bảng kiểm dữ liệu THÔ)
//   node scripts/cms-i4-offline.mjs reconcile --sales=<csv> --context=<json> [--expected=<csv>] [--out=<md>]   (N4b)
//
// Dữ liệu thật KHÔNG được nằm trong Git: mọi đường dẫn vào / ra nằm trong một cây Git (có thư mục cha chứa `.git`) ⇒ từ chối
// (rc 2), trừ fixture GIẢ e2e/fixtures/cms-i4/ (chỉ đầu vào). stdout chỉ in số đếm / mã / hash (không email, không giá trị
// dòng); bảng chi tiết (email che) chỉ ghi vào --out ngoài Git.
// Thoát: 0 đạt · 1 dữ liệu có vấn đề / lệch · 2 sai tham số / đường dẫn / file.
// r2 (PM 04/11 I4-P1-2): MỌI lệnh dùng MỘT kết luận `readiness` của lõi (held như app · vi phạm hợp đồng ProductID canonical ·
// rỗng / 0 ứng viên = không có bằng chứng). rc 0 CHỈ khi readiness `ready` VÀ các phép so riêng của lệnh đạt (n4a: đủ ca; reconcile:
// engine = oracle, khớp số tay). `notProven` (trang BigQuery, snapshot trước, độ đủ toàn kỳ) luôn in ra — không phải "đạt".
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { die2, parseArgs, runCli } from './lib-cms-ops.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEBAPP = path.resolve(HERE, '..')
const FIXTURES = path.join(WEBAPP, 'e2e', 'fixtures', 'cms-i4')
/** Ngoại lệ "trong Git" CHỈ cho đúng 4 file giả này (spec quét: chỉ email @example.test / UUID 00000000-…). */
const FIXTURE_FILES = ['sales.csv', 'products.csv', 'context.json', 'expected.csv']

const norm = (p) => {
  const r = path.resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** Thư mục cha gần nhất có `.git` (thư mục hoặc file worktree) ⇒ đường dẫn nằm trong một cây Git. */
function gitTreeOf(p) {
  let d = path.resolve(p)
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}

function checkInput(flag, p) {
  if (!p) die2(`thiếu ${flag}=<đường dẫn>`)
  const abs = path.resolve(p)
  let real
  try { real = fs.realpathSync(abs) } catch { die2(`${flag}: không đọc được file`) }
  if (!fs.statSync(real).isFile()) die2(`${flag}: không phải file`)
  if (FIXTURE_FILES.some((f) => norm(real) === norm(path.join(FIXTURES, f)))) return real
  if (gitTreeOf(real)) die2(`${flag}: file nằm trong một cây Git — dữ liệu thật phải lưu NGOÀI Git (chỉ 4 fixture giả e2e/fixtures/cms-i4/ được phép)`)
  return real
}

function checkOutput(p) {
  const abs = path.resolve(p)
  const dir = path.dirname(abs)
  if (!fs.existsSync(dir)) die2('--out: thư mục chưa tồn tại')
  if (gitTreeOf(fs.realpathSync(dir))) die2('--out: đầu ra nằm trong một cây Git — ghi ra thư mục ngoài Git')
  if (fs.existsSync(abs)) die2('--out: file đã tồn tại — không ghi đè, chọn tên mới')
  return abs
}

const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

async function loadI4() {
  let createJiti
  try { ({ createJiti } = await import('jiti')) } catch { die2('thiếu gói jiti — chạy `npm ci` trong webapp/ rồi thử lại') }
  const jiti = createJiti(import.meta.url, { interopDefault: true })
  return jiti.import(path.join(WEBAPP, 'e2e', 'cmsI4Offline.ts'))
}

function readCsv(I, flag, file, columns, optional) {
  const r = I.cmsI4ReadCsv(new Uint8Array(fs.readFileSync(file)), columns, optional)
  if (!r.ok) die2(`${flag}: ${r.reason}`)
  return r
}

function readContext(I, file) {
  let json
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { die2('--context: JSON không hợp lệ') }
  const c = I.cmsI4ParseContext(json)
  if (!c.ok) die2(`--context: ${c.reason}`)
  return c.value
}

async function main() {
  const a = parseArgs(process.argv.slice(2), { values: ['--sales', '--products', '--context', '--expected', '--out'] })
  const allowed = {
    'check-products': ['--products'],
    'check-sales': ['--sales', '--context'],
    n4a: ['--sales', '--context', '--out'],
    reconcile: ['--sales', '--context', '--expected', '--out'],
  }
  const extra = Object.keys(a.values).filter((k) => !(allowed[a.cmd] ?? []).includes(k))
  if (!allowed[a.cmd] || a.bad.length || extra.length) {
    console.log('dùng: node scripts/cms-i4-offline.mjs <check-products --products=<csv> | check-sales --sales=<csv> [--context=<json>] | n4a --sales=<csv> [--context=<json>] --out=<md> | reconcile --sales=<csv> --context=<json> [--expected=<csv>] [--out=<md>]>')
    return 2
  }
  // Kiểm MỌI đường dẫn trước khi đọc bất kỳ file nào.
  const files = {}
  for (const k of ['--sales', '--products', '--context', '--expected']) if (a.values[k] !== undefined) files[k] = checkInput(k, a.values[k])
  if (a.cmd === 'n4a' && a.values['--out'] === undefined) die2('n4a cần --out=<md ngoài Git> (bảng chi tiết không in ra stdout)')
  if (a.cmd === 'reconcile' && !files['--context']) die2('reconcile cần --context=<json>')
  const out = a.values['--out'] !== undefined ? checkOutput(a.values['--out']) : null
  const I = await loadI4()

  if (a.cmd === 'check-products') {
    const csv = readCsv(I, '--products', files['--products'], I.CMS_PRODUCT_COLUMNS)
    const r = I.cmsI4CheckProducts(csv.rows)
    console.log(`I4 check-products ${j({ accepted: r.readiness.status === 'ready', ...r, extraColumns: csv.extraColumns.length })}`)
    return r.readiness.status === 'ready' ? 0 : 1
  }

  const csv = readCsv(I, '--sales', files['--sales'], I.CMS_SALES_COLUMNS)
  const ctx = files['--context'] ? readContext(I, files['--context']) : null

  if (a.cmd === 'check-sales') {
    // Có --context ⇒ CÙNG đánh giá với reconcile (kỳ, SP, mapping, ngưỡng chưa gán, OVERFLOW qua engine của app).
    const r = I.cmsI4CheckSales(csv.rows, ctx ?? undefined)
    console.log(`I4 check-sales ${j({ accepted: r.readiness.status === 'ready', ...r, extraColumns: csv.extraColumns.length })}`)
    return r.readiness.status === 'ready' ? 0 : 1
  }

  if (a.cmd === 'n4a') {
    const r = I.cmsI4N4a(csv.rows, ctx ? { sellers: I.cmsI4Sellers(ctx), program: I.cmsI4Program(ctx) } : {})
    // Mẫu N4a chọn lệch có chủ đích (QLCH / ONLINE / huỷ …) ⇒ chỉ áp phần HỢP ĐỒNG của readiness (không ngưỡng chưa gán / kỳ).
    const rd = I.cmsI4CheckSales(csv.rows).readiness
    fs.writeFileSync(out, `# N4a — kiểm dữ liệu thô (KHÔNG kết luận tiền)\n\n${I.cmsI4N4aMarkdown(r)}\n`, { flag: 'wx', mode: 0o600 })
    const missing = Object.entries(r.coverage).filter(([, v]) => v === 0).map(([k]) => k)
    const manual = Object.entries(r.coverage).filter(([, v]) => v === null).map(([k]) => k)
    const accepted = rd.status === 'ready' && missing.length === 0
    console.log(`I4 n4a ${j({ accepted, readiness: rd, rows: r.rows.length, orders: new Set(r.rows.map((x) => x.orderCode)).size, invalidRows: r.rows.filter((x) => x.issues.length).length, coverage: r.coverage, missing, manual, scope: 'contract', out: path.basename(out) })}`)
    return accepted ? 0 : 1
  }

  // reconcile (N4b)
  let expected
  if (files['--expected']) {
    const e = readCsv(I, '--expected', files['--expected'], I.CMS_I4_EXPECTED_COLUMNS, I.CMS_I4_EXPECTED_OPTIONAL)
    const p = I.cmsI4ParseExpected(e.rows)
    if (!p.ok) die2(`--expected: ${p.reason}`)
    expected = p.value
  }
  const r = I.cmsI4Reconcile({ ...ctx, rows: csv.rows, expected })
  const expBad = r.expected !== null && (r.expected.mismatches.length > 0 || r.expected.missingInEngine.length > 0 || r.expected.notInExpected.length > 0)
  const accepted = r.readiness.status === 'ready' && r.oracleMismatches.length === 0 && !expBad
  if (out) {
    const rd = r.readiness
    const mm = (list) => list.map((m) => `- ${m.pair}: ${m.fields.map((f) => `${f.name} kỳ vọng ${f.expected} / thực ${f.actual}`).join('; ')} — ${m.hint}`).join('\n') || '- (không)'
    fs.writeFileSync(out, [
      '# N4b — đối soát tiền cả kỳ (offline)', '',
      accepted ? '**Kết luận: ĐẠT các gate kiểm được offline.**'
        : rd.status === 'ready' ? '**Kết luận: KHÔNG ĐẠT — lệch engine / oracle / số tính tay (chi tiết dưới).**'
          : `**Kết luận: KHÔNG ĐẠT — snapshot không sẵn sàng (held: ${rd.held.join(', ') || '—'} · hợp đồng: ${rd.contract.join(', ') || '—'} · không có bằng chứng: ${rd.noEvidence.join(', ') || '—'}). Bảng và so khớp dưới CHỈ để chẩn đoán, không phải chứng nhận khớp.**`,
      `Chưa chứng minh offline: ${rd.notProven.join(', ')}.`, '',
      `input hash \`${r.inputHash}\``, '', I.cmsI4N4bMarkdown(r), '',
      '## Engine ↔ oracle độc lập', mm(r.oracleMismatches), '',
      '## So với số tính tay', r.expected ? `${r.expected.matched} / ${r.expected.compared} khớp (trong đó ${r.expected.matchedWithoutPair} cặp kỳ vọng 0 không có dòng ở engine)` : '(không có file kỳ vọng)',
      ...(r.expected ? [mm(r.expected.mismatches), ...r.expected.missingInEngine.map((m) => `- ${m.pair}: ${m.fields.map((f) => `${f.name} kỳ vọng ${f.expected} / thực ${f.actual}`).join('; ')} — ${m.hint}`), ...r.expected.notInExpected.map((x) => `- ${x}: engine > 0 nhưng không có trong file kỳ vọng`)] : []),
      '', '## Cảnh báo ngữ cảnh', ...r.warnings.map((w) => `- ${w}`), '',
    ].join('\n'), { flag: 'wx', mode: 0o600 })
  }
  const exp = r.expected && { compared: r.expected.compared, matched: r.expected.matched, matchedWithoutPair: r.expected.matchedWithoutPair, mismatches: r.expected.mismatches.length, missingInEngine: r.expected.missingInEngine.length, notInExpected: r.expected.notInExpected.length }
  console.log(`I4 reconcile ${j({ accepted, readiness: r.readiness, normalize: r.normalize, totals: r.totals, pairs: r.pairs.length, oracleMismatches: r.oracleMismatches.length, expected: exp, warnings: r.warnings.length, inputHash: r.inputHash, out: out ? path.basename(out) : null })}`)
  return accepted ? 0 : 1
}

await runCli(main)
