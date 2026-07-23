// P3-H H2 — Upload 25 QR PNG gốc lên GCS + verify. CHẠY SAU khi stakeholder
// audit 095/UI pass, TRƯỚC khi chạy migration 095 (thứ tự: ảnh sống → seed URL).
//
//   node scripts/upload-affiliate-qr.mjs [--verify-only]
//
// Nguồn ảnh: C:\webapp_management\QR_code_affiliate (không commit binary vào
// Git). Key: affiliate-qr/v1/<store_code>/<partner_code>.png — v1 immutable;
// thay QR sau này dùng v2, KHÔNG ghi đè object. Metadata: Content-Type
// image/png + Cache-Control public,max-age=31536000,immutable.
// Auth mirror lib/google/auth.ts (JWT RS256 → OAuth token, không SDK).
// Verify: GET từng public URL → HTTP 200 + content-type image/png + SHA-256
// khớp file gốc (mạnh hơn re-decode: byte-identical ⇒ decode được y nguyên —
// decode gốc đã chứng minh 25/25 trong docs/affiliate-qr-manifest.md).
// Không in secret/URI ra console.

import { createHash, createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const QR_DIR = 'C:/webapp_management/QR_code_affiliate'
const VERIFY_ONLY = process.argv.includes('--verify-only')

// Manifest (docs/affiliate-qr-manifest.md — decode 24/07, stakeholder duyệt).
const MANIFEST = [
  ['1. Circa Urban.png', 'POS0011', 'CIRCA-URBAN'],
  ['2. Circa Mizuki.png', 'POS0013', 'CIRCA-MIZUKI'],
  ['3. Circa Lumina.png', 'POS0012', 'CIRCA-LUMINA'],
  ['4. Circa Sunrise.png', 'POS0014', 'CIRCA-SUNRISE'],
  ['5. Circa Elara.png', 'POS0015', 'CIRCA-ELARA'],
  ['6. Circa Mora.png', 'POS0017', 'CIRCA-MORA'],
  ['7. Circa Thống Nhất.png', 'POS0016', 'CIRCA-THONGNHAT'],
  ['8. Circa Signature.png', 'POS0018', 'CIRCA-SIGNATURE'],
  ['9. Circa Beverly.png', 'POS0058', 'CIRCA-BEVERLY'],
  ['10. Circa Astoria.png', 'POS0062', 'CIRCA-ASTORIA'],
  ['11. Circa Tâm Việt.png', 'POS0059', 'CIRCA-TAMVIET'],
  ['12. Circa Cityland.png', 'POS0070', 'CIRCA-CITYLAND'],
  ['13. Circa Tâm An.png', 'POS0060', 'CIRCA-TAMAN'],
  ['14. Circa Mira.png', 'POS0019', 'CIRCA-MIRA'],
  ['15. Circa Medly.png', 'POS0063', 'CIRCA-MEDLY'],
  ['16. Circa Symphony.png', 'POS0065', 'CIRCA-SYMPHONY'],
  ['17. Circa Florita.png', 'POS0068', 'CIRCA-FLORITA'],
  ['18. Circa Pharmaone.png', 'POS0066', 'CIRCA-PHARMAONE'],
  ['19. Circa Central.png', 'POS0009', 'CIRCA-CENTRAL'],
  ['20. Circa Ecogreen.png', 'POS0073', 'CIRCA-ECOGREEN'],
  ['21. Circa Rainbow.png', 'POS0069', 'CIRCA-RAINBOW'],
  ['22. Circa Celadon.png', 'POS0067', 'CIRCA-CELADON'],
  ['23. Circa EHome.png', 'POS0079', 'CIRCA-EHOME'],
  ['24. Circa Nam Việt.png', 'POS0077', 'CIRCA-NAMVIET'],
  ['25. Circa Akari.png', 'POS0080', 'CIRCA-AKARI'],
]

// ── env từ webapp/.env.local (fallback process.env — chạy được cả trên server)
const here = path.dirname(fileURLToPath(import.meta.url))
const env = { ...process.env }
try {
  for (const line of readFileSync(path.join(here, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
} catch { /* .env.local không có → dùng process.env */ }

const BUCKET = env.GCS_BUCKET
const BASE = (env.GCS_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '')
if (!BUCKET || !BASE) { console.error('THIẾU GCS_BUCKET / GCS_PUBLIC_BASE_URL'); process.exit(2) }

function loadSA() {
  const raw = env.GCS_SA_KEY
  if (!raw) return null
  let json = raw.trim()
  if (!json.startsWith('{')) {
    try { json = Buffer.from(json, 'base64').toString('utf8') } catch { /* fall through */ }
  }
  try {
    const sa = JSON.parse(json)
    return sa.client_email && sa.private_key ? sa : null
  } catch { return null }
}

async function getToken(sa) {
  const b64url = (x) => Buffer.from(x).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/devstorage.read_write',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }))
  const assertion = `${unsigned}.${b64url(createSign('RSA-SHA256').update(unsigned).sign(sa.private_key))}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Google token failed (${res.status})`)
  return (await res.json()).access_token
}

// Multipart upload: metadata (contentType + cacheControl) + bytes trong 1 request.
async function uploadObject(token, key, bytes) {
  const boundary = 'qr_upload_boundary_5f2c'
  const meta = JSON.stringify({
    name: key,
    contentType: 'image/png',
    cacheControl: 'public,max-age=31536000,immutable',
  })
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  const res = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(BUCKET)}/o?uploadType=multipart`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(60_000),
    },
  )
  if (!res.ok) throw new Error(`upload ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
}

const sha = (b) => createHash('sha256').update(b).digest('hex')

let token = null
if (!VERIFY_ONLY) {
  const sa = loadSA()
  if (!sa) { console.error('GCS_SA_KEY chưa hợp lệ'); process.exit(2) }
  token = await getToken(sa)
}

let fail = 0
for (const [file, storeCode, partnerCode] of MANIFEST) {
  const key = `affiliate-qr/v1/${storeCode}/${partnerCode}.png`
  const local = readFileSync(path.join(QR_DIR, file))
  try {
    if (!VERIFY_ONLY) await uploadObject(token, key, local)
    // Verify công khai: 200 + image/png + SHA-256 byte-identical với file gốc.
    const res = await fetch(`${BASE}/${key}`, { signal: AbortSignal.timeout(30_000) })
    const ct = res.headers.get('content-type') ?? ''
    const remote = Buffer.from(await res.arrayBuffer())
    const ok = res.status === 200 && ct.includes('image/png') && sha(remote) === sha(local)
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${key}  (${res.status}, ${ct}, ${ok ? 'sha khớp' : 'SHA LỆCH/LỖI'})`)
    if (!ok) fail++
  } catch (err) {
    console.log(`FAIL ${key}  (${err instanceof Error ? err.message : String(err)})`)
    fail++
  }
}
console.log(`\n== ${VERIFY_ONLY ? 'VERIFY' : 'UPLOAD+VERIFY'}: ${MANIFEST.length - fail}/${MANIFEST.length} OK${fail ? ` · ${fail} FAIL` : ''}`)
process.exit(fail ? 1 : 0)
