// CMS P3a — XLSX chi trả của chương trình ĐÃ CHỐT (blueprint P3 §3; work order P3a luồng E). Lõi THUẦN + handler có deps
// tiêm vào (route thật: app/api/export/cms/payout/route.ts; test: deps giả, không DB):
//  · Nguồn duy nhất: rpc_cms_payout (SESSION — phạm vi HIỆN TẠI theo Q-208 / Q-217, marker QA trong DB). Không ghép tổng live.
//  · Định danh = SNAPSHOT lúc chốt (tên / email / nhà thuốc); đổi tên / email / store sau chốt không đổi file.
//  · Super: toàn chương trình, có email, sheet thông tin có Q-213 / policy / lý do; tổng = program_total = tổng run đã chốt.
//    SM: chỉ staff hiện thuộc phạm vi, KHÔNG email, nhãn "trong phạm vi của bạn", so với scope_total (không so tổng run).
//  · Đủ dòng (kể cả 0 đ — không lọc); Σ tiền = tổng trả về, lệch ⇒ 500 không file. Chưa chốt ⇒ 409, không file số 0.
//  · Không phải lệnh chuyển tiền; chương trình QA ghi nhãn "dữ liệu QA — không chi trả".
//  · 124: super có thêm metadata chứng nhận đối soát nguồn đã dùng chốt (id, bộ trường decision10, mốc dữ liệu, nhãn nguồn tham
//    chiếu, số dòng, vân tay decision10) — không actor / email / hash file. SM không có các dòng này.
//  · Ô: chuỗi ghi kiểu text (không công thức); tiền nguyên trong miền an toàn ⇒ số, ngoài miền ⇒ text đủ chữ số.
import * as XLSX from 'xlsx'
import { cmsDecCell, cmsIntCell } from './exportResults'
import { cmsSourceBasisLabel, cmsUnassignedRatioText, type CmsPayoutDto } from './payoutView'

type Cell = string | number | null
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const vnTime = (iso: string | null): string => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = new Date(t + 7 * 3600_000).toISOString()
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${d.slice(11, 19)}`
}
const vnDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`

export interface CmsPayoutExportProgram { id: string; name: string; startDate: string; endDate: string; status: string; isTest: boolean }
export interface CmsPayoutExportInput {
  program: CmsPayoutExportProgram
  payout: CmsPayoutDto
  exportedAt: Date
  scope: 'super' | 'sm'
}
export type CmsPayoutBuild = { ok: true; bytes: Uint8Array<ArrayBuffer>; rowCount: number; totalVnd: bigint }
  | { ok: false; error: 'PROGRAM_MISMATCH' | 'TOTAL_MISMATCH' | 'SCOPE_MISMATCH' }

export function buildCmsPayoutWorkbook(i: CmsPayoutExportInput): CmsPayoutBuild {
  const p = i.payout
  if (p.programId !== i.program.id) return { ok: false, error: 'PROGRAM_MISMATCH' }
  const isSuper = i.scope === 'super'
  // Vai hiển thị phải khớp phạm vi DB trả: super ⇔ viewer super (có email + program_total).
  if (isSuper !== (p.viewer === 'super')) return { ok: false, error: 'SCOPE_MISMATCH' }
  const sum = p.rows.reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0))
  if (sum !== BigInt(p.scopeTotal) || (isSuper && p.programTotal !== p.scopeTotal)) return { ok: false, error: 'TOTAL_MISMATCH' }

  const wb = XLSX.utils.book_new()
  const add = (name: string, rows: Cell[][]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map((c) => (c === null ? '' : c))))
    // Ép mọi ô chuỗi là text (không công thức / không ép kiểu ngày) — chuỗi bắt đầu '=' vẫn là text.
    for (const k of Object.keys(ws)) if (!k.startsWith('!') && typeof ws[k].v === 'string') ws[k].t = 's'
    XLSX.utils.book_append_sheet(wb, ws, name)
  }

  const head: Cell[] = ['STT', 'Dược sĩ (lúc chốt)', ...(isSuper ? ['Email (lúc chốt)'] : []), 'Nhà thuốc (lúc chốt)', 'Số SP có CMS', 'Tiền CMS (VND)']
  const sheet: Cell[][] = [head]
  p.rows.forEach((r, k) => {
    sheet.push([k + 1, r.name ?? '', ...(isSuper ? [r.email ?? ''] : []), r.storeName ?? '', r.productsWithCms, cmsIntCell(r.amountVnd)])
  })
  sheet.push([])
  sheet.push(['', isSuper ? 'Tổng toàn chương trình' : 'Tổng trong phạm vi của bạn', ...(isSuper ? [''] : []), '', '', cmsIntCell(p.scopeTotal)])
  add('Chi tra', sheet)

  const info: Cell[][] = [
    ['Chương trình', i.program.name],
    ['Kỳ', `${vnDate(i.program.startDate)} – ${vnDate(i.program.endDate)}`],
    ['Trạng thái', 'Đã chốt kỳ'],
    ['Thời điểm chốt (VN)', vnTime(p.lockedAt)],
    ['Mã phiên kết quả (run)', p.runId],
    ['Phiên bản quy tắc chốt', p.policyVersion],
    ['Phạm vi file', isSuper ? 'Toàn chương trình' : 'Trong phạm vi của bạn (nhà thuốc được phân công, theo phân công hiện tại)'],
    ['Số dòng', p.rows.length],
    [isSuper ? 'Tổng toàn chương trình (VND)' : 'Tổng trong phạm vi (VND)', cmsIntCell(p.scopeTotal)],
    ['Ghi chú', 'Gồm mọi dược sĩ có kết quả trong phiên đã chốt, kể cả 0 đ (không lọc). Tên / email / nhà thuốc là ảnh chụp lúc chốt.'],
    ['Lưu ý', 'File đối soát chi trả — KHÔNG phải lệnh chuyển tiền.'],
  ]
  if (p.isTest) info.splice(2, 0, ['Loại', 'Chương trình QA (dữ liệu thử) — KHÔNG chi trả'])
  if (isSuper && p.super) {
    const s = p.super
    info.push(
      ['Người chốt (id)', s.lockedBy],
      ['Dược sĩ có kết quả / có tiền', `${s.staffRows} / ${s.staffPaid}`],
      ['Lần tính bắt đầu (VN)', vnTime(s.runStartedAt)],
      ['Dòng ứng viên (trừ ngoài phạm vi)', s.candidateLines],
      ['GMV ứng viên dương (VND)', cmsDecCell(s.candidateGmv)],
      ['Dòng chưa gán', s.unassignedLines],
      ['GMV chưa gán dương (VND)', cmsDecCell(s.unassignedGmv)],
      ['Tỷ lệ GMV chưa gán', cmsUnassignedRatioText(s.unassignedGmv, s.candidateGmv)],
      ['Lý do xác nhận dòng chưa gán', s.ackReason ?? ''],
      ['Quy tắc áp dụng', s.policy.label === 'QA_ONLY_ASSUMPTION' ? 'Giả định QA (không phải quy tắc chi trả thật)' : (s.policy.label ?? '')],
      ['Cơ sở nguồn đầy đủ', cmsSourceBasisLabel(s.sourceCompleteBasis)],
      ['Nguồn đủ tới ngày', s.sourceCompleteThrough ? vnDate(s.sourceCompleteThrough) : ''],
    )
    if (s.sourceAttestationId && s.sourceAttestation) {
      const a = s.sourceAttestation
      info.push(
        ['Chứng nhận đối soát nguồn (id)', s.sourceAttestationId],
        ['Bộ trường đối soát', a.fieldSet],
        ['Mốc dữ liệu đối soát (VN)', vnTime(a.asOf)],
        ['Nguồn tham chiếu', a.referenceLabel],
        ['Số dòng đã đối soát', a.linesCompared],
        ['Chứng nhận lúc (VN)', vnTime(a.attestedAt)],
        ['Vân tay decision10 của lần tính', a.runRowsFp],
      )
    }
  }
  info.push(['Xuất lúc (VN)', vnTime(i.exportedAt.toISOString())])
  add('Thong tin', info)

  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer)
  return { ok: true, bytes, rowCount: p.rows.length, totalVnd: sum }
}

// ── Handler (deps tiêm vào) ─────────────────────────────────────────────────
export type CmsPayoutReadErr = 'FORBIDDEN' | 'NOT_LOCKED' | 'BAD_INPUT' | 'QUERY_FAILED'
export interface CmsPayoutExportDeps {
  session(): Promise<{ userId: string; role: string | null; email: string | null } | null>
  /** program + earnings + lock (P3a sau cờ chốt). */
  lockEnabled(): boolean
  access(role: string | null, email: string | null): { view: boolean; manage: boolean }
  program(id: string, manage: boolean): Promise<{ ok: true; data: CmsPayoutExportProgram | null } | { ok: false }>
  payout(programId: string): Promise<{ ok: true; data: CmsPayoutDto } | { ok: false; error: CmsPayoutReadErr }>
  now(): Date
}

const json = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: code, message }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export async function handleCmsPayoutExport(req: Request, deps: CmsPayoutExportDeps): Promise<Response> {
  const s = await deps.session()
  if (!s) return json(401, 'UNAUTHENTICATED', 'Chưa đăng nhập.')
  const acc = deps.access(s.role, s.email)
  if (!deps.lockEnabled() || !acc.view) return json(403, 'FORBIDDEN', 'Không có quyền xuất dữ liệu.')
  const url = new URL(req.url)
  const programId = url.searchParams.get('program') ?? ''
  const pinRun = url.searchParams.get('run')
  if (!UUID_RE.test(programId) || (pinRun !== null && !UUID_RE.test(pinRun))) return json(400, 'BAD_REQUEST', 'Tham số không hợp lệ.')
  const prog = await deps.program(programId, acc.manage)
  if (!prog.ok) return json(500, 'QUERY_FAILED', 'Không tải được chương trình.')
  if (!prog.data) return json(404, 'NOT_FOUND', 'Không tìm thấy chương trình.')
  const pay = await deps.payout(programId)
  if (!pay.ok) {
    if (pay.error === 'NOT_LOCKED') return json(409, 'NOT_LOCKED', 'Chương trình chưa chốt kỳ — chưa có số chi trả.')
    if (pay.error === 'FORBIDDEN') return json(404, 'NOT_FOUND', 'Không tìm thấy chương trình.')
    if (pay.error === 'BAD_INPUT') return json(400, 'BAD_REQUEST', 'Tham số không hợp lệ.')
    return json(500, 'QUERY_FAILED', 'Không tải được số chi trả.')
  }
  if (pinRun !== null && pinRun !== pay.data.runId) return json(409, 'RUN_CHANGED', 'Phiên kết quả không khớp số đã chốt — tải lại trang.')
  const built = buildCmsPayoutWorkbook({ program: prog.data, payout: pay.data, exportedAt: deps.now(), scope: acc.manage ? 'super' : 'sm' })
  if (!built.ok) return json(500, built.error, 'Số chi trả không khớp — không xuất file.')
  // Vết kiểm toán: ai xuất số chốt của chương trình / run nào, bao nhiêu dòng — chỉ id / số đếm, không email / tên / tiền.
  console.info(`[cms-payout-export] OK user=${s.userId} program=${programId} run=${pay.data.runId} scope=${acc.manage ? 'super' : 'sm'} rows=${built.rowCount}`)
  const stamp = new Date(deps.now().getTime() + 7 * 3600_000).toISOString().slice(0, 16).replace(/[-:T]/g, '')
  return new Response(built.bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cms-chi-tra-${programId.slice(0, 8)}-${stamp}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
