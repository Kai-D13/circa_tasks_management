'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import * as XLSX from 'xlsx'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { createImportedStoreTasks } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RequiredOutput } from '@/types'
import { CheckCircle, XCircle, Upload, FileSpreadsheet, AlertTriangle } from 'lucide-react'

// Keep in sync with the server limits in createImportedStoreTasks.
const MAX_ROWS   = 2000
const MAX_STORES = 30

const OUTPUT_OPTIONS: { value: RequiredOutput; label: string }[] = [
  { value: 'video', label: 'Video' },
  { value: 'image', label: 'Ảnh' },
  { value: 'text',  label: 'Ghi chú' },
  { value: 'file',  label: 'File' },
]

const DEFAULT_DESCRIPTION = `Operations gửi danh sách các TRF ghi nhận nhập kho bị thiếu số lượng so với phiếu TRF đã chuyển.

Cửa hàng vui lòng:
1. Kiểm tra chi tiết các trường hợp chênh lệch trong file đính kèm và đối chiếu với video đóng hàng.
2. Với các trường hợp chưa chính xác, vui lòng cung cấp video đóng hàng, ghi rõ video thuộc TRF nào.
3. Phản hồi trong vòng 48 giờ kể từ thời điểm nhận thông báo.

Lưu ý: Tất cả phản hồi cần có video bằng chứng đầy đủ.`

interface Store {
  id: string
  name: string
  code: string
}

interface StoreMatch {
  posCode: string
  storeName: string | null
  rows: Record<string, unknown>[]
  found: boolean
}

function detectPosCodeColumn(headers: string[], rows: Record<string, unknown>[]): string {
  for (const header of headers) {
    const sample = rows.slice(0, 30).map((r) => String(r[header] ?? '').trim())
    if (sample.some((v) => /^POS\d+$/i.test(v))) return header
  }
  const keywords = ['pos', 'code', 'mã', 'store', 'cửa hàng', 'chi nhánh']
  for (const header of headers) {
    if (keywords.some((k) => header.toLowerCase().includes(k))) return header
  }
  return headers[0] ?? ''
}

export function ImportTasksClient({ stores }: { stores: Store[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // Task metadata
  const [title, setTitle] = useState('Kiểm tra TRF thiếu hàng')
  const [description, setDescription] = useState(DEFAULT_DESCRIPTION)
  const [priority, setPriority] = useState<'urgent' | 'normal'>('urgent')
  const now = new Date()
  const in48h = new Date(Date.now() + 48 * 3600 * 1000)
  const [startDate, setStartDate] = useState(now.toISOString().slice(0, 10))
  const [startTime, setStartTime] = useState(now.toISOString().slice(11, 16))
  const [deadlineDate, setDeadlineDate] = useState(in48h.toISOString().slice(0, 10))
  const [deadlineTime, setDeadlineTime] = useState(in48h.toISOString().slice(11, 16))
  const [requiredOutputs, setRequiredOutputs] = useState<RequiredOutput[]>(['video', 'text'])

  // File state
  const [file, setFile] = useState<File | null>(null)
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null)
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [posCodeCol, setPosCodeCol] = useState('')

  const storeCodeMap = useMemo(
    () => new Map(stores.map((s) => [s.code.toUpperCase(), s])),
    [stores]
  )

  const storeMatches = useMemo<StoreMatch[]>(() => {
    if (!posCodeCol || rows.length === 0) return []
    const grouped: Record<string, Record<string, unknown>[]> = {}
    for (const row of rows) {
      const code = String(row[posCodeCol] ?? '').trim().toUpperCase()
      if (!code) continue
      grouped[code] = grouped[code] ?? []
      grouped[code].push(row)
    }
    return Object.entries(grouped).map(([posCode, rowList]) => {
      const store = storeCodeMap.get(posCode)
      return { posCode, storeName: store?.name ?? null, rows: rowList, found: !!store }
    })
  }, [rows, posCodeCol, storeCodeMap])

  const matched   = storeMatches.filter((s) => s.found)
  const unmatched = storeMatches.filter((s) => !s.found)

  // Blocking conditions (mirror the server). Confirm stays disabled until clear.
  const overRows   = rows.length > MAX_ROWS
  const overStores = matched.length > MAX_STORES
  const startISO   = startDate && startTime ? `${startDate}T${startTime}` : ''
  const deadISO    = deadlineDate && deadlineTime ? `${deadlineDate}T${deadlineTime}` : ''
  const badDates   = !startISO || !deadISO || new Date(deadISO) <= new Date(startISO)
  const canConfirm =
    !!file && !!selectedSheet && !!posCodeCol &&
    rows.length > 0 && matched.length > 0 &&
    !overRows && !overStores && !!title.trim() && !badDates && requiredOutputs.length > 0

  function parseSheet(wb: XLSX.WorkBook, sheetName: string) {
    const sheet = wb.Sheets[sheetName]
    // raw:false → match the server parse (dates as readable text, not serials).
    const parsed = sheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false }) : []
    setRows(parsed)
    const hdrs = parsed.length > 0 ? Object.keys(parsed[0]) : []
    setHeaders(hdrs)
    setPosCodeCol(detectPosCodeColumn(hdrs, parsed))
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    try {
      const buffer = await f.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      if (wb.SheetNames.length === 0) { toast.error('File không có sheet nào'); return }
      setFile(f)
      setWorkbook(wb)
      setSheetNames(wb.SheetNames)
      const first = wb.SheetNames[0]
      setSelectedSheet(first)
      parseSheet(wb, first)
      toast.success(`Đã đọc ${wb.SheetNames.length} sheet từ file`)
    } catch {
      toast.error('Không đọc được file. Hãy dùng định dạng .xlsx hoặc .csv')
    }
  }

  function handleSheetChange(sheetName: string) {
    setSelectedSheet(sheetName)
    if (workbook) parseSheet(workbook, sheetName)
  }

  function toggleOutput(val: RequiredOutput) {
    setRequiredOutputs((prev) =>
      prev.includes(val) ? prev.filter((o) => o !== val) : [...prev, val]
    )
  }

  function handleCreate() {
    if (!file || !canConfirm) return
    startTransition(async () => {
      const supabase = createClient()
      // Upload the original master file; the server re-parses + validates it.
      const tmpId = crypto.randomUUID()
      const masterPath = `task-inputs/import/${tmpId}/${Date.now()}_${file.name}`
      const { error: upErr } = await supabase.storage
        .from('task-uploads').upload(masterPath, file, { upsert: false })
      if (upErr) { toast.error(`Tải file lên thất bại: ${upErr.message}`); return }

      const result = await createImportedStoreTasks({
        masterPath,
        sheetName:       selectedSheet,
        posColumn:       posCodeCol,
        title,
        description,
        priority,
        startDate:       startISO,
        deadline:        deadISO,
        requiredOutputs,
      })
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success(
          `Đã tạo ${result.count} task` +
          (result.skipped ? ` — bỏ qua ${result.skipped} POS không khớp` : '')
        )
        router.push('/tasks')
      }
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Import Tasks từ File Excel</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload 1 file tổng có cột POS Code. Hệ thống tách dữ liệu theo từng cửa hàng và tạo 1 task/cửa hàng,
          mỗi task đính kèm đúng phần dữ liệu của cửa hàng đó.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* === LEFT: Task Config === */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Cấu hình Task</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-1.5">
                <Label htmlFor="title">Tiêu đề *</Label>
                <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nhập tiêu đề task" />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="desc">Mô tả</Label>
                <Textarea id="desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={8} className="text-xs leading-relaxed" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Bắt đầu <span className="text-destructive">*</span></Label>
                  <div className="flex gap-1.5">
                    <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-9 text-xs bg-background flex-1" />
                    <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="h-9 text-xs bg-background w-[80px]" />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label>Deadline <span className="text-destructive">*</span></Label>
                  <div className="flex gap-1.5">
                    <Input type="date" value={deadlineDate} onChange={(e) => setDeadlineDate(e.target.value)} className="h-9 text-xs bg-background flex-1" />
                    <Input type="time" value={deadlineTime} onChange={(e) => setDeadlineTime(e.target.value)} className="h-9 text-xs bg-background w-[80px]" />
                  </div>
                </div>
              </div>
              {badDates && (startISO || deadISO) && (
                <p className="text-xs text-destructive">Deadline phải sau ngày bắt đầu.</p>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Độ ưu tiên</Label>
                  <Select value={priority} onValueChange={(v) => { if (v) setPriority(v as 'urgent' | 'normal') }}>
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="urgent">Urgent</SelectItem>
                      <SelectItem value="normal">Normal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Output yêu cầu</Label>
                <div className="flex flex-wrap gap-3">
                  {OUTPUT_OPTIONS.map(({ value, label }) => (
                    <label key={value} className="flex items-center gap-2 cursor-pointer text-sm">
                      <input type="checkbox" checked={requiredOutputs.includes(value)} onChange={() => toggleOutput(value)} className="accent-primary h-4 w-4" />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* === RIGHT: File Upload + Preview === */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Upload File</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:bg-muted/40 transition-colors"
                onClick={() => document.getElementById('file-upload')?.click()}
              >
                {file ? (
                  <div className="space-y-1">
                    <FileSpreadsheet className="h-8 w-8 mx-auto text-green-600" />
                    <p className="text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{rows.length} dòng · sheet “{selectedSheet}”</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Click để chọn file .xlsx hoặc .csv</p>
                  </div>
                )}
                <input id="file-upload" type="file" accept=".xlsx,.xls,.csv" className="hidden" aria-label="Chọn file Excel" onChange={handleFileChange} />
              </div>

              {sheetNames.length > 0 && (
                <div className="grid gap-1.5">
                  <Label>Sheet dữ liệu</Label>
                  <Select value={selectedSheet} onValueChange={(v) => { if (v) handleSheetChange(v) }}>
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {sheetNames.map((s) => (<SelectItem key={s} value={s}>{s}</SelectItem>))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">File có {sheetNames.length} sheet — chọn đúng sheet chứa dữ liệu cần chia.</p>
                </div>
              )}

              {headers.length > 0 && (
                <div className="grid gap-1.5">
                  <Label>Cột chứa POS Code</Label>
                  <Select value={posCodeCol} onValueChange={(v) => { if (v) setPosCodeCol(v) }}>
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {headers.map((h) => (<SelectItem key={h} value={h}>{h}</SelectItem>))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Hệ thống đã tự detect. Kiểm tra lại nếu cần.</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Store matching preview */}
          {storeMatches.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
                  Preview
                  <Badge className="bg-green-100 text-green-700">{matched.length} cửa hàng</Badge>
                  {unmatched.length > 0 && (
                    <Badge className="bg-red-100 text-red-700">{unmatched.length} POS không khớp</Badge>
                  )}
                  <span className="text-xs font-normal text-muted-foreground">{rows.length} dòng</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(overRows || overStores) && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>
                      {overRows   && <>File vượt giới hạn {MAX_ROWS.toLocaleString('vi-VN')} dòng (hiện {rows.length.toLocaleString('vi-VN')}). </>}
                      {overStores && <>Vượt giới hạn {MAX_STORES} cửa hàng (hiện {matched.length}). </>}
                      Vui lòng tách nhỏ file.
                    </span>
                  </div>
                )}
                {unmatched.length > 0 && (
                  <p className="text-xs text-amber-700">
                    POS không khớp (sẽ bị bỏ qua): {unmatched.map((u) => u.posCode).join(', ')}
                  </p>
                )}
                <div className="max-h-64 overflow-y-auto -mx-2">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs px-3 py-2">POS Code</TableHead>
                        <TableHead className="text-xs px-3 py-2">Cửa hàng</TableHead>
                        <TableHead className="text-xs px-3 py-2 text-right">Dòng</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {storeMatches.map((m) => (
                        <TableRow key={m.posCode}>
                          <TableCell className="text-xs px-3 py-1.5 font-mono">{m.posCode}</TableCell>
                          <TableCell className="text-xs px-3 py-1.5">
                            <div className="flex items-center gap-1.5">
                              {m.found
                                ? <CheckCircle className="h-3.5 w-3.5 text-green-600 shrink-0" />
                                : <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                              <span className={m.found ? '' : 'text-red-500'}>{m.storeName ?? 'Không tìm thấy'}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs px-3 py-1.5 text-right text-muted-foreground">{m.rows.length}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Action bar */}
      {storeMatches.length > 0 && (
        <>
          <Separator />
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Sẽ tạo <strong>{matched.length} task</strong> cho {matched.length} cửa hàng
              {unmatched.length > 0 && (
                <span className="text-red-500 ml-2">({unmatched.length} POS không khớp sẽ bị bỏ qua)</span>
              )}
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => router.back()} disabled={pending}>Huỷ</Button>
              <Button onClick={handleCreate} disabled={pending || !canConfirm}>
                {pending ? 'Đang tạo...' : `Tạo ${matched.length} Task`}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
