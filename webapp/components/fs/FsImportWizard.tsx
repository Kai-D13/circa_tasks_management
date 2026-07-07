'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { readFsSheets, previewFsImport, createFsSession } from '@/app/actions/fsSessions'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { FileUp, X, Download, Store as StoreIcon, FileSpreadsheet, Tag } from 'lucide-react'

interface FsStore { id: string; name: string; code: string | null }
interface Preview {
  sheetName: string
  validCount: number
  invalid: { row: number; product_id: string | null; error: string }[]
  duplicates: string[]
  preview: { product_id: string; product_name: string }[]
}

const canon = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

const SAMPLE_CSV = ['product_id,product_name', '2005946,Sản phẩm mẫu A', '2005947,Sản phẩm mẫu B'].join('\n')
function downloadTemplate() {
  const blob = new Blob(['﻿' + SAMPLE_CSV], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'mau-san-pham-fs.csv'
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

// Default the sheet to the one whose name matches the chosen store, else first.
function matchSheet(list: string[], store: FsStore | undefined): string {
  if (store) {
    const target = canon(store.name)
    const exact = list.find((n) => canon(n) === target)
    if (exact) return exact
    const partial = list.find((n) => canon(n).includes(target) || target.includes(canon(n)))
    if (partial) return partial
  }
  return list[0] ?? ''
}

const SELECT_CLS = 'w-full h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30'

export function FsImportWizard({ fsStores }: { fsStores: FsStore[] }) {
  const router = useRouter()
  const [storeId, setStoreId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [sheets, setSheets] = useState<string[]>([])
  const [sheetName, setSheetName] = useState('')
  const [sessionName, setSessionName] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pending, startTransition] = useTransition()

  const selectedStore = fsStores.find((s) => s.id === storeId)

  function onStoreChange(id: string) {
    const store = fsStores.find((s) => s.id === id)
    setStoreId(id); setPreview(null)
    // Re-match the sheet to the NEW store (pass it explicitly — reading state here
    // would use the previous store).
    if (sheets.length) { const def = matchSheet(sheets, store); setSheetName(def); setSessionName(def) }
  }

  function onFile(f: File | null) {
    setFile(f); setSheets([]); setSheetName(''); setPreview(null)
    if (!f) return
    const fd = new FormData(); fd.append('file', f)
    startTransition(async () => {
      const r = await readFsSheets(fd)
      if ('error' in r && r.error) { toast.error(r.error); return }
      const list = (r as { sheets: string[] }).sheets
      setSheets(list)
      const def = matchSheet(list, selectedStore)
      setSheetName(def)
      setSessionName((prev) => prev || def)
    })
  }

  function onSheetChange(n: string) { setSheetName(n); setPreview(null); setSessionName(n) }

  function doPreview() {
    if (!file) { toast.error('Chưa chọn file'); return }
    if (!sheetName) { toast.error('Chưa chọn sheet'); return }
    const fd = new FormData(); fd.append('file', file)
    startTransition(async () => {
      const r = await previewFsImport(fd, sheetName)
      if ('error' in r && r.error) { toast.error(r.error); setPreview(null); return }
      setPreview(r as unknown as Preview)
    })
  }

  function doCreate() {
    if (!file || !storeId || !sheetName) return
    const fd = new FormData(); fd.append('file', file)
    startTransition(async () => {
      const r = await createFsSession(fd, { storeId, sheetName, sessionName })
      if ('error' in r && r.error) { toast.error(r.error); return }
      const res = r as { sessionId?: string; created?: number }
      toast.success(`Đã tạo phiên · ${res.created ?? ''} sản phẩm`, { duration: 5000 })
      setFile(null); setSheets([]); setSheetName(''); setSessionName(''); setPreview(null)
      // Land on Kết quả with the new session highlighted + a banner.
      router.push(`/fs/products?tab=result&session=${res.sessionId ?? ''}&created=${res.created ?? ''}`)
      router.refresh()
    })
  }

  const blocked = !preview || preview.invalid.length > 0 || preview.validCount === 0 || !storeId

  return (
    <div className="space-y-5">
      {/* 1 · Store */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <StoreIcon className="h-4 w-4 text-primary" /> Cửa hàng FS
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Chọn cửa hàng FS" value={storeId} onChange={(e) => onStoreChange(e.target.value)} className={cn(SELECT_CLS, 'sm:max-w-md')}>
            <option value="">— Chọn cửa hàng FS —</option>
            {fsStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {selectedStore?.code && <Badge className="bg-sky-100 text-sky-700 font-mono text-[11px]">{selectedStore.code}</Badge>}
        </div>
        {fsStores.length === 0 && <p className="text-xs text-muted-foreground">Chưa có cửa hàng FS nào trong hệ thống.</p>}
      </section>

      {/* 2 · File */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <FileUp className="h-4 w-4 text-primary" /> File sản phẩm
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="fs-import-file"
            type="file"
            aria-label="Chọn file sản phẩm FS"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            onClick={(e) => { (e.currentTarget as HTMLInputElement).value = '' }}
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            className="sr-only"
          />
          <label htmlFor="fs-import-file" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'cursor-pointer gap-1.5')}>
            <FileUp className="h-3.5 w-3.5" /> Chọn file Excel/CSV
          </label>
          {file && (
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary text-secondary-foreground text-xs font-medium pl-2.5 pr-1 py-1 max-w-[240px]">
              <span className="truncate">{file.name}</span>
              <button type="button" aria-label="Bỏ chọn file" onClick={() => onFile(null)} className="rounded-full p-0.5 hover:bg-primary/10">
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={downloadTemplate} className="gap-1.5">
            <Download className="h-3.5 w-3.5" /> Tải file mẫu
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">2 cột: <code>product_id</code>, <code>product_name</code>. Mỗi sheet = 1 cửa hàng.</p>
      </section>

      {/* 3 · Sheet + name (after upload) */}
      {sheets.length > 0 && (
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <FileSpreadsheet className="h-4 w-4 text-primary" /> Sheet dữ liệu
            </div>
            <select aria-label="Chọn sheet dữ liệu" value={sheetName} onChange={(e) => onSheetChange(e.target.value)} className={SELECT_CLS}>
              {sheets.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">Tự chọn sheet khớp tên cửa hàng — đổi lại nếu cần.</p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Tag className="h-4 w-4 text-primary" /> Tên phiên
            </div>
            <input
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              maxLength={120}
              placeholder="Tên phiên xử lý"
              className={SELECT_CLS}
            />
            <p className="text-xs text-muted-foreground">{sessionName.length}/120 ký tự.</p>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button size="sm" variant="outline" onClick={doPreview} disabled={pending || !file || !sheetName}>
          {pending ? 'Đang đọc…' : 'Xem trước'}
        </Button>
        <Button size="sm" onClick={doCreate} disabled={pending || blocked}>
          Tạo phiên
        </Button>
        {preview && !blocked && (
          <span className="text-xs text-muted-foreground">Sẽ tạo phiên cho <b>{selectedStore?.name}</b> · {preview.validCount} sản phẩm.</span>
        )}
      </div>

      {preview && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <span className="text-xs px-2 py-0.5 rounded font-medium bg-green-100 text-green-700">Hợp lệ {preview.validCount}</span>
            {preview.invalid.length > 0 && <span className="text-xs px-2 py-0.5 rounded font-medium bg-red-100 text-red-700">Lỗi {preview.invalid.length}</span>}
            {preview.duplicates.length > 0 && <span className="text-xs px-2 py-0.5 rounded font-medium bg-amber-100 text-amber-700">Trùng {preview.duplicates.length}</span>}
          </div>

          {preview.invalid.length > 0 && (
            <div className="rounded border border-red-200 bg-red-50 p-2 max-h-48 overflow-y-auto">
              <p className="text-xs font-medium text-red-700 mb-1">Sửa hết các dòng lỗi rồi tạo lại (không ghi từng phần):</p>
              <ul className="text-xs text-red-700 space-y-0.5">
                {preview.invalid.slice(0, 50).map((e, i) => (
                  <li key={i}>Dòng {e.row}{e.product_id ? ` (${e.product_id})` : ''}: {e.error}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.preview.length > 0 && (
            <div className="rounded border overflow-x-auto max-h-72">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left px-3 py-2 w-32">product_id</th>
                    <th className="text-left px-3 py-2">Tên sản phẩm</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {preview.preview.map((r) => (
                    <tr key={r.product_id}>
                      <td className="px-3 py-1.5 font-mono">{r.product_id}</td>
                      <td className="px-3 py-1.5">{r.product_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.validCount > preview.preview.length && (
            <p className="text-xs text-muted-foreground">… và {preview.validCount - preview.preview.length} sản phẩm hợp lệ khác.</p>
          )}
        </div>
      )}
    </div>
  )
}
