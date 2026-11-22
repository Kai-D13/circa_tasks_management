'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createCmsProgram, updateCmsProgram } from '@/app/actions/cmsPrograms'
import { useFixtureActionBlocked } from '@/components/kpi/KpiFixtureBoundary'
import { Notice } from '@/components/ds/Notice'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CMS_PROGRAM_DATE_MAX, CMS_PROGRAM_DATE_MIN, normalizeCmsProgramInput } from '@/lib/cms/programInput'
import type { CmsInvalidStore, CmsStoreOption } from '@/lib/cms/server/catalog'
import {
  CMS_BASIS_SOURCE_NOTE, CMS_QUANTITY_BASES, CMS_QUANTITY_BASIS_HINT, CMS_QUANTITY_BASIS_LABEL,
  type CmsProgramBasis, type CmsQuantityBasis,
} from '@/lib/cms/calc/basisUi'

// CMS P1-c — bước "Thông tin" A2 (tạo) và màn sửa /[id]/edit (U3 / U17; SPEC §4.7). Không có ô target danh mục (đọc
// từ Excel). is_test / trạng thái KHÔNG gửi từ client (server quyết — H9). Server action + RPC 121 kiểm lại mọi thứ;
// form chỉ kiểm sớm cùng luật (programInput) để báo lỗi gần người dùng. Q-214: chương trình đã kích hoạt chỉ dời
// ngày bắt đầu sang SAU hôm nay.
// PM review P1-c P1: nhà thuốc ĐÃ CHỌN nhưng không còn là OS đang hoạt động (`invalidStores`) hiện ở khối riêng với nút
// "Bỏ chọn" tường minh — không tự loại, không buộc chuyển "Tất cả"; còn mục không hợp lệ ⇒ chặn lưu kèm hướng dẫn.
// `data-cms-pending-payload`: đúng dữ liệu sắp gửi (dữ liệu của chính người dùng) — để test fixture kiểm payload khi
// boundary chặn action.
// CMS-CALC-RET-2 P5.1 (spec §2 / §8.1): `basis.selectable` (cờ CMS_CALC_MODES_ENABLED + DB có đường program_modes) ⇒ fieldset radio
// "Cách tính lượng" BẮT BUỘC, không chọn sẵn khi tạo / nháp chưa được admin chọn; chương trình đã kích hoạt chỉ hiện (gửi lại đúng
// cách tính hiện tại — server + DB chặn đổi). Không selectable ⇒ không gửi khoá quantity_basis (đường 121 như cũ).
// CMS-IMPORT-UI-1 (PM 22/11 §3.2): MỘT <form>, hai nhóm "Thông tin chương trình" | "Cách tính CMS" — hai cột khi nội dung của khung
// (container cms-wizard) ≥ 960px, một cột bên dưới; radio cách tính xếp dọc; footer trong luồng trang. Chỉ đổi bố cục.

export interface CmsProgramFormInitial {
  id: string
  name: string
  startDate: string
  endDate: string
  scope: 'all' | 'stores'
  storeIds: string[]
  /** Đã kích hoạt (chưa bắt đầu) ⇒ ràng buộc Q-214. */
  active: boolean
}

export interface CmsProgramFormBasis {
  /** Hiện lựa chọn cách tính (cờ + năng lực DB). */
  selectable: boolean
  /** Cách tính hiện tại khi sửa (undefined khi tạo; null = không đọc được). */
  current?: CmsProgramBasis | null
}

const FIELD = 'h-[44px] md:h-[36px] w-full rounded-v2-control border border-input bg-card px-3 text-[16px] md:text-sm'

// Nhóm của form: panel v2, tiêu đề nhóm cùng cỡ với các panel CMS khác.
// r1 (PM UI-R1-01): radius nhóm mới = 8px (circa-ui: card ≤ 8px), không dùng panel 12px.
const GROUP = 'min-w-0 space-y-4 rounded-lg border bg-card p-4 md:p-5'
// Không có lựa chọn cách tính ⇒ chỉ MỘT nhóm: tên + ngày | phạm vi chia hai cột trong nhóm khi nội dung ≥ 960px (không card rỗng, không cap trang).
const INFO_SPLIT = 'grid min-w-0 gap-4 @min-[960px]/cms-wizard:grid-cols-2 @min-[960px]/cms-wizard:gap-[24px] @min-[960px]/cms-wizard:items-start'
const TIER_NOTE = 'text-[13px] text-muted-foreground'
const GROUP_TITLE = 'text-[14px] font-semibold'

const INVALID_REASON: Record<CmsInvalidStore['reason'], string> = {
  inactive: 'đã ngừng hoạt động', not_os: 'không phải nhà thuốc OS', unknown: 'không còn trong danh sách',
}

export function CmsProgramForm({ mode, initial, stores, storesError, invalidStores = [], today, basis: basisCfg }: {
  mode: 'create' | 'edit'
  initial?: CmsProgramFormInitial
  basis?: CmsProgramFormBasis
  stores: CmsStoreOption[]
  storesError: boolean
  /** Nhà thuốc đã chọn (sửa chương trình) nhưng không còn hợp lệ để chọn. */
  invalidStores?: CmsInvalidStore[]
  today: string
}) {
  const router = useRouter()
  const fixtureBlocked = useFixtureActionBlocked()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState(initial?.name ?? '')
  const [startDate, setStartDate] = useState(initial?.startDate ?? '')
  const [endDate, setEndDate] = useState(initial?.endDate ?? '')
  const [scope, setScope] = useState<'all' | 'stores'>(initial?.scope ?? 'all')
  const [picked, setPicked] = useState<Set<string>>(new Set(initial?.storeIds ?? []))
  const [storeQ, setStoreQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendingPayload, setPendingPayload] = useState<string | null>(null)
  const selectable = basisCfg?.selectable === true
  const cur = basisCfg?.current
  // Đã kích hoạt: cách tính bất biến (chỉ hiện). Nháp: chọn sẵn CHỈ khi admin đã chọn trước đó (legacy / pending phải chọn lại).
  const basisLocked = selectable && initial?.active === true
  const [basis, setBasis] = useState<CmsQuantityBasis | null>(
    basisLocked ? cur?.basis ?? null : cur && cur.source === 'admin' ? cur.basis : null,
  )
  const invalidPicked = invalidStores.filter((x) => picked.has(x.id))
  const validPicked = stores.filter((x) => picked.has(x.id)).length
  const unpick = (id: string) => setPicked((prev) => { const n = new Set(prev); n.delete(id); return n })
  const shownStores = useMemo(() => {
    const k = storeQ.trim().toLowerCase()
    return k ? stores.filter((s) => s.name.toLowerCase().includes(k) || s.code.toLowerCase().includes(k)) : stores
  }, [stores, storeQ])

  function submit(next: 'detail' | 'upload') {
    setError(null)
    setPendingPayload(null)
    if (scope === 'stores' && invalidPicked.length > 0) {
      setError(`Bỏ chọn ${invalidPicked.length} nhà thuốc không còn hợp lệ trước khi lưu (mục "Nhà thuốc không còn hợp lệ" bên dưới)`)
      return
    }
    const v = normalizeCmsProgramInput({ name, start_date: startDate, end_date: endDate, scope, store_ids: [...picked] })
    if (!v.ok) { setError(v.error); return }
    if (initial?.active && v.value.start_date <= today) {
      setError('Chương trình đã kích hoạt chỉ được dời ngày bắt đầu sang một ngày sau hôm nay')
      return
    }
    if (selectable && !basis) {
      setError(basisLocked ? 'Không đọc được cách tính của chương trình — tải lại trang' : 'Chọn cách tính lượng cho chương trình')
      return
    }
    const payload = selectable ? { ...v.value, quantity_basis: basis } : v.value
    setPendingPayload(JSON.stringify(payload))
    if (fixtureBlocked()) return
    startTransition(async () => {
      const r = mode === 'create' ? await createCmsProgram(payload) : await updateCmsProgram(initial!.id, payload)
      if (!r.ok) { setError(r.error); return }
      toast.success(mode === 'create' ? 'Đã lưu nháp chương trình' : 'Đã lưu thay đổi')
      router.push(next === 'upload' ? `/targets/campaigns/cms/${r.id}/import?from=new` : `/targets/campaigns/cms/${r.id}`)
      router.refresh()
    })
  }

  return (
    <form
      data-cms-program-form={mode}
      data-cms-pending-payload={pendingPayload ?? undefined}
      className="min-w-0 space-y-[16px] md:space-y-[24px]"
      onSubmit={(e) => { e.preventDefault(); submit(mode === 'create' ? 'upload' : 'detail') }}
    >
      <div data-cms-form-grid={selectable ? 'two' : 'one'} className={cn('grid min-w-0 gap-[16px] md:gap-[24px]', selectable && '@min-[960px]/cms-wizard:grid-cols-2 @min-[960px]/cms-wizard:items-start')}>
      <section data-cms-form-group="info" aria-labelledby="cms-form-info-h" className={GROUP}>
      <h2 id="cms-form-info-h" className={GROUP_TITLE}>Thông tin chương trình</h2>
      <div data-cms-form-info-body className={selectable ? 'space-y-4' : INFO_SPLIT}>
      <div className="min-w-0 space-y-4">
      <label className="block space-y-1.5">
        <span className="text-[13px] font-medium">Tên chương trình <span aria-hidden="true" className="text-status-danger">*</span></span>
        <input className={FIELD} value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium">Từ ngày <span aria-hidden="true" className="text-status-danger">*</span></span>
          <input type="date" className={FIELD} value={startDate} min={CMS_PROGRAM_DATE_MIN} max={CMS_PROGRAM_DATE_MAX} required onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium">Đến ngày <span aria-hidden="true" className="text-status-danger">*</span></span>
          <input type="date" className={FIELD} value={endDate} min={startDate || CMS_PROGRAM_DATE_MIN} max={CMS_PROGRAM_DATE_MAX} required onChange={(e) => setEndDate(e.target.value)} />
        </label>
      </div>
      {initial?.active && (
        <p className="text-[12px] text-muted-foreground">Chương trình đã kích hoạt: ngày bắt đầu mới phải sau hôm nay. Muốn áp dụng hồi tố, tạo chương trình nháp rồi kích hoạt có xác nhận.</p>
      )}

      </div>
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-[13px] font-medium">Phạm vi</legend>
        <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
          {(['all', 'stores'] as const).map((s) => (
            <label key={s} className="inline-flex min-h-[44px] items-center gap-2 text-[14px]">
              <input type="radio" name="scope" value={s} checked={scope === s} onChange={() => setScope(s)} className="size-4" />
              {s === 'all' ? 'Tất cả nhà thuốc OS đang hoạt động' : 'Chọn nhà thuốc'}
            </label>
          ))}
        </div>
        {scope === 'stores' && (
          storesError ? (
            <Notice tone="danger" role="alert" title="Không tải được danh sách nhà thuốc">Thử tải lại trang.</Notice>
          ) : (
            <div className="space-y-2 rounded-v2-control border p-3">
              <input className={FIELD} placeholder="Tìm nhà thuốc" value={storeQ} onChange={(e) => setStoreQ(e.target.value)} aria-label="Tìm nhà thuốc" />
              {invalidPicked.length > 0 && (
                <Notice tone="warning" title={`Nhà thuốc không còn hợp lệ (${invalidPicked.length})`} className="[&_ul]:mt-1">
                  <span data-cms-invalid-stores className="block text-[12px]">Đã chọn trước đây nhưng nay không thể áp dụng. Bỏ chọn để lưu; hệ thống không tự loại.</span>
                  <ul className="divide-y">
                    {invalidPicked.map((x) => (
                      <li key={x.id} data-cms-invalid-store={x.id} className="flex min-h-[44px] items-center gap-2 text-[14px]">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{x.name ?? 'Nhà thuốc không xác định'}{x.code ? <span className="ml-1.5 text-[12px] text-muted-foreground">{x.code}</span> : null}</span>
                          <span className="block text-[12px] text-muted-foreground">{INVALID_REASON[x.reason]}</span>
                        </span>
                        <Button type="button" variant="outline" onClick={() => unpick(x.id)} className="h-[44px] md:h-[32px] shrink-0">Bỏ chọn</Button>
                      </li>
                    ))}
                  </ul>
                </Notice>
              )}
              <p className="text-[12px] text-muted-foreground tabular-nums">Đã chọn {validPicked} / {stores.length} nhà thuốc đang hoạt động</p>
              <ul className="max-h-64 overflow-y-auto divide-y">
                {shownStores.map((s) => (
                  <li key={s.id}>
                    <label className="flex min-h-[44px] items-center gap-2 text-[14px]">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={picked.has(s.id)}
                        onChange={(e) => setPicked((prev) => {
                          const n = new Set(prev)
                          if (e.target.checked) n.add(s.id); else n.delete(s.id)
                          return n
                        })}
                      />
                      <span className="min-w-0 truncate">{s.name}</span>
                      <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">{s.code}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
      </fieldset>
      </div>
      {!selectable && <p data-cms-tier-note className={TIER_NOTE}>Cách tính bậc: <span className="font-medium text-foreground">Lũy tiến</span> · target danh mục đọc từ file Excel.</p>}
      </section>

      {selectable && (
      <section data-cms-form-group="basis" aria-labelledby="cms-form-basis-h" className={GROUP}>
      <h2 id="cms-form-basis-h" className={GROUP_TITLE}>Cách tính CMS</h2>
        <fieldset data-cms-basis-field className="min-w-0 space-y-2">
          <legend className="text-[13px] font-medium">Cách tính lượng <span aria-hidden="true" className="text-status-danger">*</span></legend>
          {basisLocked ? (
            <p data-cms-basis-locked={cur?.basis ?? 'unknown'} className="rounded-v2-control border bg-muted/40 p-3 text-[14px]">
              {cur?.basis ? CMS_QUANTITY_BASIS_LABEL[cur.basis] : 'Không đọc được cách tính'}
              <span className="mt-1 block text-[12px] text-muted-foreground">Chương trình đã kích hoạt — không đổi được cách tính.</span>
            </p>
          ) : (
            <>
              {cur && CMS_BASIS_SOURCE_NOTE[cur.source] && cur.source !== 'admin' && (
                <p data-cms-basis-note={cur.source} className="text-[12px] text-muted-foreground">{CMS_BASIS_SOURCE_NOTE[cur.source]} — chọn một cách tính.</p>
              )}
              <div className="grid gap-2" role="radiogroup" aria-label="Cách tính lượng">
                {CMS_QUANTITY_BASES.map((b) => (
                  <label
                    key={b}
                    data-cms-basis-option={b}
                    className={cn('flex min-h-[44px] cursor-pointer gap-2.5 rounded-v2-control border bg-card p-3 text-[14px] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', basis === b && 'border-primary bg-primary/5')}
                  >
                    <input type="radio" name="quantity_basis" value={b} checked={basis === b} onChange={() => setBasis(b)} className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block font-medium">{CMS_QUANTITY_BASIS_LABEL[b]}</span>
                      <span className="mt-0.5 block max-w-[68ch] text-[12px] text-muted-foreground">{CMS_QUANTITY_BASIS_HINT[b]}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="max-w-[68ch] text-[12px] text-muted-foreground">Áp dụng cho mọi sản phẩm của chương trình; không đặt trong file Excel. Đổi cách tính khi còn nháp làm mất hiệu lực lần kiểm tra file trước đó. Sau khi kích hoạt không đổi được.</p>
            </>
          )}
        </fieldset>
      <p data-cms-tier-note className={TIER_NOTE}>Cách tính bậc: <span className="font-medium text-foreground">Lũy tiến</span> · target danh mục đọc từ file Excel.</p>
      </section>
      )}
      </div>

      {error && <Notice tone="danger" role="alert">{error}</Notice>}

      <div data-cms-form-actions className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Link
          href={mode === 'edit' && initial ? `/targets/campaigns/cms/${initial.id}` : '/targets/campaigns/cms'}
          className={cn(buttonVariants({ variant: 'ghost' }), 'h-[44px] md:h-[36px]')}
        >
          Huỷ
        </Link>
        {mode === 'create' && (
          <Button type="button" variant="outline" disabled={pending} onClick={() => submit('detail')} className="h-[44px] md:h-[36px]">
            Lưu nháp
          </Button>
        )}
        <Button type="submit" disabled={pending} className="h-[44px] md:h-[36px] font-semibold">
          {mode === 'create' ? 'Tiếp tục · Upload file' : 'Lưu thay đổi'}
        </Button>
      </div>
    </form>
  )
}
