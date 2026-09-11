import { createSign } from 'node:crypto'
import fs from 'node:fs'

// 113.11 (audit P1#1): client BigQuery TỐI GIẢN cho acceptance — đối soát số
// Offline với nguồn một cách ĐỘC LẬP. Cố ý KHÔNG import lib/targets/bigquery.ts
// hay lib/google/auth.ts: chúng là `server-only`, và bằng chứng đối soát không
// được đi qua chính code đang bị kiểm. Chỉ ĐỌC (scope bigquery.readonly).

interface ServiceAccount { client_email: string; private_key: string; project_id: string }

function readEnvFileValue(key: string): string | undefined {
  if (!fs.existsSync('.env.local')) return undefined
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && m[1] === key) return m[2]
  }
  return undefined
}

function loadSa(): ServiceAccount {
  const raw = (process.env.BQ_SERVICE_ACCOUNT_KEY ?? readEnvFileValue('BQ_SERVICE_ACCOUNT_KEY'))?.trim()
  if (!raw) throw new Error('thiếu BQ_SERVICE_ACCOUNT_KEY (process env hoặc .env.local)')
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
  const sa = JSON.parse(json) as ServiceAccount
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('BQ_SERVICE_ACCOUNT_KEY thiếu field')
  return sa
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }))}`
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key)
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64(sig)}` }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Google token lỗi (${res.status}): ${(await res.text()).slice(0, 200)}`)
  return ((await res.json()) as { access_token: string }).access_token
}

/** Chạy SQL (standard) và trả rows thô: giá trị là chuỗi đúng như REST API trả, null giữ null. */
export async function bqQuery(sql: string): Promise<Record<string, string | null>[]> {
  const sa = loadSa()
  const token = await accessToken(sa)
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${sa.project_id}/queries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30_000, maxResults: 1000 }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) throw new Error(`BigQuery lỗi (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as {
    jobComplete?: boolean; totalRows?: string
    schema?: { fields?: { name: string }[] }; rows?: { f: { v: string | null }[] }[]
  }
  if (!data.jobComplete) throw new Error('BigQuery job chưa xong trong 30s')
  const fields = (data.schema?.fields ?? []).map((f) => f.name)
  const rows = (data.rows ?? []).map((r) => Object.fromEntries(fields.map((n, i) => [n, r.f[i]?.v ?? null])))
  if (Number(data.totalRows ?? rows.length) !== rows.length) throw new Error(`BigQuery trả thiếu trang (${rows.length}/${data.totalRows})`)
  return rows
}
