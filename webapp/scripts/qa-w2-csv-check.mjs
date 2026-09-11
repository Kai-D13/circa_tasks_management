// QA file import KPI W2 tháng 09 (10–16/09/2026) — khoá theo TỪNG POS → ngưỡng,
// không chỉ tổng. Audit 113.7 P0: hai danh sách ngưỡng có CÙNG tổng 20.950 /
// min 340 / max 1.480 nhưng gán cho cửa hàng khác nhau ở 21/25 dòng ⇒ canary
// tổng hợp xanh dù phân bổ sai. Nguồn được duyệt (stakeholder 11/09): workbook
// Circa_KPI_Sep_W10-16.xlsx cột "NGƯỠNG ORDER" = round10(đơn Offline W1
// 03–09/09 × 1,40) — kiểm chéo BigQuery khớp 25/25.
//
//   cd webapp && node scripts/qa-w2-csv-check.mjs "C:/Users/.../mau-chien-dich-kpi-week-02-09_v2.csv"
//
// Fail nếu: thiếu/thừa POS, ngưỡng lệch dù chỉ 1 dòng, bonus ≠ 200000, ô trống.
import fs from 'node:fs'

const EXPECTED = {
  POS0013: 1480, // MIZUKI
  POS0018: 1430, // SIGNATURE
  POS0059: 1410, // TAM VIET
  POS0014: 1340, // SUNRISE
  POS0080: 1260, // AKARI
  POS0058: 1120, // BEVERLY
  POS0011: 1030, // URBAN
  POS0063: 990,  // MEDLY
  POS0069: 920,  // RAINBOW
  POS0070: 890,  // CITYLAND
  POS0062: 790,  // ASTORIA
  POS0009: 710,  // CENTRAL
  POS0019: 710,  // MIRA
  POS0079: 710,  // EHOME
  POS0012: 680,  // LUMINA
  POS0065: 680,  // SYMPHONY
  POS0016: 620,  // THỐNG NHẤT
  POS0066: 620,  // PHARMA ONE
  POS0060: 590,  // TAM AN
  POS0073: 570,  // ECO GREEN
  POS0067: 540,  // CELADON
  POS0015: 530,  // ELANA
  POS0077: 520,  // NAM VIET
  POS0017: 470,  // MORA
  POS0068: 340,  // FLORITA
}
const BONUS = 200000

const file = process.argv[2]
if (!file) { console.error('Cách dùng: node scripts/qa-w2-csv-check.mjs <đường dẫn CSV>'); process.exit(2) }
const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
const lines = raw.split('\n')
const head = lines[0].split(',')
const col = (name) => { const i = head.indexOf(name); if (i < 0) { console.error('FAIL: thiếu cột', name); process.exit(1) } return i }
const iPos = col('pos_code'), iThr = col('minimum_order_target'), iBps = col('order_bonus_per_staff')

let failed = false
const fail = (m) => { console.error('FAIL:', m); failed = true }
const seen = new Map()
for (const [n, l] of lines.slice(1).entries()) {
  const c = l.split(',')
  const pos = (c[iPos] ?? '').trim().toUpperCase()
  if (!pos) { fail(`dòng ${n + 2}: thiếu pos_code`); continue }
  if (seen.has(pos)) { fail(`dòng ${n + 2}: ${pos} trùng`); continue }
  const thr = c[iThr]?.trim(), bps = c[iBps]?.trim()
  seen.set(pos, thr)
  if (!(pos in EXPECTED)) { fail(`dòng ${n + 2}: ${pos} không thuộc 25 cửa hàng W2`); continue }
  if (thr === '' || thr === undefined) { fail(`dòng ${n + 2}: ${pos} minimum_order_target trống`); continue }
  if (!/^\d+$/.test(thr) || Number(thr) !== EXPECTED[pos]) fail(`dòng ${n + 2}: ${pos} ngưỡng ${thr} ≠ ${EXPECTED[pos]} (nguồn duyệt)`)
  if (Number(bps) !== BONUS) fail(`dòng ${n + 2}: ${pos} order_bonus_per_staff ${bps} ≠ ${BONUS}`)
}
for (const pos of Object.keys(EXPECTED)) if (!seen.has(pos)) fail(`thiếu ${pos}`)

const sum = Object.values(EXPECTED).reduce((a, b) => a + b, 0)
console.log(`kiểm ${seen.size} dòng · kỳ vọng 25 POS · tổng ngưỡng nguồn duyệt ${sum.toLocaleString('vi-VN')} · min ${Math.min(...Object.values(EXPECTED))} · max ${Math.max(...Object.values(EXPECTED))}`)
console.log(failed ? 'W2 CSV: FAIL — KHÔNG import' : 'W2 CSV: PASS 25/25 POS → ngưỡng đúng nguồn duyệt, bonus 200000')
process.exit(failed ? 1 : 0)
