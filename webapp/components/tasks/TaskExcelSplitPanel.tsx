'use client'

import { useState, useMemo, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CheckCircle, XCircle, Upload, FileSpreadsheet, AlertTriangle, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// Keep in sync with the server limits in createImportedStoreTasks.
const MAX_ROWS   = 2000
const MAX_STORES = 30

export interface ExcelSplitState {
  file:         File
  sheetName:    string
  posColumn:    string
  ready:        boolean
  inScopeCount: number
}

interface Store { id: string; name: string; code: string }

interface Props {
  stores:          Store[]
  allowedStoreIds: string[]
  onChange:        (state: ExcelSplitState | null) => void  // must be stable (useCallback)
}

function detectPosCodeColumn(headers: string[], rows: Record<string, unknown>[]): string {
  for (const header of headers) {
    const sample = rows.slice(0, 30).map((r) => String(r[header] ?? '').trim())
    if (sample.some((v) => /^POS\d+$/i.test(v))) return header
  }
  const keywords = ['pos', 'code', 'store', 'mã', 'cửa hàng', 'chi nhánh']
  for (const header of headers) {
    if (keywords.some((k) => header.toLowerCase().includes(k))) return header
  }
  return headers[0] ?? ''
}

export function TaskExcelSplitPanel({ stores, allowedStoreIds, onChange }: Props) {
  const [file, setFile]               = useState<File | null>(null)
  const [workbook, setWorkbook]       = useState<XLSX.WorkBook | null>(null)
  const [sheetNames, setSheetNames]   = useState<string[]>([])
  const [selectedSheet, setSelected]  = useState('')
  const [rows, setRows]               = useState<Record<string, unknown>[]>([])
  const [headers, setHeaders]         = useState<string[]>([])
  const [posCodeCol, setPosCodeCol]   = useState('')

  const storeByCode = useMemo(
    () => new Map(stores.map((s) => [s.code.toUpperCase(), s])),
    [stores]
  )
  const allowedKey = allowedStoreIds.join(',')

  // Group + classify each POS against the scope allow-list.
  const { inScope, outside } = useMemo(() => {
    const allowed = new Set(allowedKey ? allowedKey.split(',') : [])
    const grouped = new Map<string, number>()
    if (posCodeCol) {
      for (const row of rows) {
        const code = String(row[posCodeCol] ?? '').trim().toUpperCase()
        if (code) grouped.set(code, (grouped.get(code) ?? 0) + 1)
      }
    }
    const inS: { posCode: string; storeName: string; count: number }[] = []
    const out: { posCode: string; reason: string; count: number }[] = []
    for (const [code, count] of grouped) {
      const store = storeByCode.get(code)
      if (store && allowed.has(store.id)) inS.push({ posCode: code, storeName: store.name, count })
      else out.push({ posCode: code, reason: store ? 'ngoài phạm vi chọn' : 'không tồn tại', count })
    }
    return { inScope: inS, outside: out }
  }, [rows, posCodeCol, storeByCode, allowedKey])

  const overRows  = rows.length > MAX_ROWS
  const overStore = inScope.length > MAX_STORES
  const ready =
    !!file && !!selectedSheet && !!posCodeCol &&
    rows.length > 0 && inScope.length > 0 &&
    outside.length === 0 && !overRows && !overStore

  useEffect(() => {
    if (!file) { onChange(null); return }
    onChange({ file, sheetName: selectedSheet, posColumn: posCodeCol, ready, inScopeCount: inScope.length })
  }, [file, selectedSheet, posCodeCol, ready, inScope.length, onChange])

  const inputId = 'excel-split-file'

  function resetFile() {
    setFile(null); setWorkbook(null); setSheetNames([]); setSelected('')
    setRows([]); setHeaders([]); setPosCodeCol('')
    const input = document.getElementById(inputId) as HTMLInputElement | null
    if (input) input.value = ''
  }

  function parseSheet(wb: XLSX.WorkBook, sheetName: string) {
    const sheet = wb.Sheets[sheetName]
    // raw:false matches the server parse (dates as readable text, not serial numbers).
    const parsed = sheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false }) : []
    setRows(parsed)
    const hdrs = parsed.length > 0 ? Object.keys(parsed[0]) : []
    setHeaders(hdrs)
    setPosCodeCol(detectPosCodeColumn(hdrs, parsed))
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > 20 * 1024 * 1024) {
      toast.error('File quá lớn (tối đa 20MB)')
      resetFile()
      return
    }
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' })
      if (wb.SheetNames.length === 0) { toast.error('File không có sheet nào'); resetFile(); return }
      setFile(f); setWorkbook(wb); setSheetNames(wb.SheetNames)
      setSelected(wb.SheetNames[0]); parseSheet(wb, wb.SheetNames[0])
    } catch {
      toast.error('Không đọc được file. Hãy dùng .xlsx hoặc .csv')
      resetFile()
    }
  }

  function handleSheetChange(name: string) {
    setSelected(name)
    if (workbook) parseSheet(workbook, name)
  }

  return (
    <div className="rounded border bg-background/60 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <FileSpreadsheet className="h-4 w-4 text-primary shrink-0" />
        <span className="text-xs font-medium">Chia file Excel theo cửa hàng (tuỳ chọn)</span>
      </div>
      <p className="text-[11px] text-muted-foreground leading-snug">
        Đính kèm 1 file tổng có cột POS Code — hệ thống tách dữ liệu và tạo task riêng cho từng cửa hàng
        trong phạm vi đã chọn. Bỏ trống nếu muốn gửi cùng một nội dung cho mọi cửa hàng.
      </p>

      <div className="relative">
        <div
          className="border-2 border-dashed rounded-lg p-4 text-center cursor-pointer hover:bg-muted/40 transition-colors"
          onClick={() => document.getElementById(inputId)?.click()}
        >
          {file ? (
            <div className="space-y-0.5">
              <FileSpreadsheet className="h-6 w-6 mx-auto text-green-600" />
              <p className="text-xs font-medium">{file.name}</p>
              <p className="text-[11px] text-muted-foreground">{rows.length} dòng &#183; sheet {selectedSheet}</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              <Upload className="h-6 w-6 mx-auto text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Click để chọn file .xlsx hoặc .csv</p>
            </div>
          )}
          <input
            id={inputId}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            aria-label="Chon file Excel"
            onChange={handleFileChange}
          />
        </div>
        {file && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); resetFile() }}
            className="absolute top-1.5 right-1.5 rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            aria-label="Xoa file"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {sheetNames.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1">
            <Label className="text-[11px]">Sheet</Label>
            <Select value={selectedSheet} onValueChange={(v) => { if (v) handleSheetChange(v) }}>
              <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {sheetNames.map((s) => (<SelectItem key={s} value={s}>{s}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          {headers.length > 0 && (
            <div className="grid gap-1">
              <Label className="text-[11px]">Cột POS Code</Label>
              <Select value={posCodeCol} onValueChange={(v) => { if (v) setPosCodeCol(v) }}>
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {headers.map((h) => (<SelectItem key={h} value={h}>{h}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {file && rows.length > 0 && posCodeCol && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <span className="rounded bg-green-100 text-green-700 px-1.5 py-0.5">{inScope.length} cửa hàng trong phạm vi</span>
            {outside.length > 0 && <span className="rounded bg-red-100 text-red-700 px-1.5 py-0.5">{outside.length} POS ngoài phạm vi</span>}
            <span className="text-muted-foreground">{rows.length} dòng</span>
          </div>

          {(overRows || overStore) && (
            <div className="flex items-start gap-1.5 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                {overRows  && <>Vượt {MAX_ROWS.toLocaleString('vi-VN')} dòng (hiện {rows.length.toLocaleString('vi-VN')}). </>}
                {overStore && <>Vượt {MAX_STORES} cửa hàng (hiện {inScope.length}). </>}
                Hãy tách nhỏ file.
              </span>
            </div>
          )}

          {outside.length > 0 && (
            <div className="flex items-start gap-1.5 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                POS ngoài phạm vi đã chọn: {outside.slice(0, 8).map((o) => o.posCode).join(', ')}
                {outside.length > 8 ? ` +${outside.length - 8} khác` : ''}. Không thể tạo cho tới khi file chỉ chứa POS trong phạm vi.
              </span>
            </div>
          )}

          <div className="max-h-44 overflow-y-auto rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[11px] px-2 py-1.5">POS</TableHead>
                  <TableHead className="text-[11px] px-2 py-1.5">Cửa hàng</TableHead>
                  <TableHead className="text-[11px] px-2 py-1.5 text-right">Dòng</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inScope.map((m) => (
                  <TableRow key={m.posCode}>
                    <TableCell className="text-[11px] px-2 py-1 font-mono">{m.posCode}</TableCell>
                    <TableCell className="text-[11px] px-2 py-1">
                      <span className="flex items-center gap-1"><CheckCircle className="h-3 w-3 text-green-600 shrink-0" />{m.storeName}</span>
                    </TableCell>
                    <TableCell className="text-[11px] px-2 py-1 text-right text-muted-foreground">{m.count}</TableCell>
                  </TableRow>
                ))}
                {outside.map((o) => (
                  <TableRow key={o.posCode} className="bg-destructive/5">
                    <TableCell className="text-[11px] px-2 py-1 font-mono">{o.posCode}</TableCell>
                    <TableCell className="text-[11px] px-2 py-1">
                      <span className="flex items-center gap-1 text-red-500"><XCircle className="h-3 w-3 shrink-0" />{o.reason}</span>
                    </TableCell>
                    <TableCell className="text-[11px] px-2 py-1 text-right text-muted-foreground">{o.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {ready && (
            <p className={cn('text-[11px] text-muted-foreground')}>
              Khi bấm &quot;Tạo Task&quot;, sẽ tạo {inScope.length} task — mỗi cửa hàng nhận file dữ liệu riêng.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
