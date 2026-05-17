'use client'

import { useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import * as XLSX from 'xlsx'
import { toast } from 'sonner'
import { createBulkTasks } from '@/app/actions/tasks'
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
import { CheckCircle, XCircle, Upload, FileSpreadsheet } from 'lucide-react'

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

Quy trình xử lý:
- Kho kiểm tra lại video nhận hàng và phản hồi bằng chứng
- Operation đối chiếu trong trường hợp hai bên có bằng chứng khác nhau
- Trường hợp chỉ một bên có video → kết quả ghi nhận theo bên có bằng chứng

Lưu ý: Tất cả phản hồi cần có video bằng chứng đầy đủ.`

interface Store {
  id: string
  name: string
  code: string
}

interface StoreMatch {
  posCode: string
  storeId: string | null
  storeName: string | null
  rows: Record<string, string>[]
  found: boolean
}

function detectPosCodeColumn(headers: string[], rows: Record<string, string>[]): string {
  for (const header of headers) {
    const sample = rows.slice(0, 30).map((r) => String(r[header] ?? '').trim())
    const hits = sample.filter((v) => /^POS\d+$/i.test(v))
    if (hits.length > 0) return header
  }
  const keywords = ['pos', 'code', 'mã', 'store', 'cửa hàng', 'chi nhánh', 'pos_code']
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
  const [deadline, setDeadline] = useState(() => {
    const d = new Date()
    d.setHours(d.getHours() + 48)
    return d.toISOString().slice(0, 16)
  })
  const [requiredOutputs, setRequiredOutputs] = useState<RequiredOutput[]>(['video', 'text'])

  // File state
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [posCodeCol, setPosCodeCol] = useState('')

  const storeCodeMap = useMemo(
    () => new Map(stores.map((s) => [s.code.toUpperCase(), s])),
    [stores]
  )

  const storeMatches = useMemo<StoreMatch[]>(() => {
    if (!posCodeCol || rows.length === 0) return []
    const grouped: Record<string, Record<string, string>[]> = {}
    rows.forEach((row) => {
      const code = String(row[posCodeCol] ?? '').trim().toUpperCase()
      if (code) {
        grouped[code] = grouped[code] ?? []
        grouped[code].push(row)
      }
    })
    return Object.entries(grouped).map(([posCode, rowList]) => {
      const store = storeCodeMap.get(posCode)
      return {
        posCode,
        storeId:   store?.id ?? null,
        storeName: store?.name ?? null,
        rows:      rowList,
        found:     !!store,
      }
    })
  }, [rows, posCodeCol, storeCodeMap])

  const matched   = storeMatches.filter((s) => s.found)
  const unmatched = storeMatches.filter((s) => !s.found)

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    try {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      const parsed = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' })
      if (parsed.length === 0) { toast.error('File không có dữ liệu'); return }
      const hdrs = Object.keys(parsed[0])
      setHeaders(hdrs)
      setRows(parsed)
      setPosCodeCol(detectPosCodeColumn(hdrs, parsed))
      toast.success(`Đã đọc ${parsed.length} dòng từ file`)
    } catch {
      toast.error('Không đọc được file. Hãy dùng định dạng .xlsx hoặc .csv')
    }
  }

  function toggleOutput(val: RequiredOutput) {
    setRequiredOutputs((prev) =>
      prev.includes(val) ? prev.filter((o) => o !== val) : [...prev, val]
    )
  }

  function handleCreate() {
    if (!title.trim()) { toast.error('Vui lòng nhập tiêu đề task'); return }
    if (matched.length === 0) { toast.error('Không có store nào được match. Kiểm tra lại file và cột POS Code'); return }

    startTransition(async () => {
      const result = await createBulkTasks({
        title,
        description,
        priority,
        deadline,
        requiredOutputs,
        fileName,
        storeItems: matched.map((m) => ({
          storeId: m.storeId!,
          posCode: m.posCode,
          rows:    m.rows,
        })),
      })
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success(`Đã tạo ${result.count} tasks thành công!`)
        router.push('/tasks')
      }
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">Import Tasks từ File</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload file Excel/CSV có cột POS Code để tạo task hàng loạt theo từng store.
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
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Nhập tiêu đề task"
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="desc">Mô tả</Label>
                <Textarea
                  id="desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={8}
                  className="text-xs leading-relaxed"
                />
              </div>

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
                <div className="grid gap-1.5">
                  <Label htmlFor="deadline">Deadline</Label>
                  <Input
                    id="deadline"
                    type="datetime-local"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    className="text-xs"
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Output yêu cầu</Label>
                <div className="flex flex-wrap gap-3">
                  {OUTPUT_OPTIONS.map(({ value, label }) => (
                    <label key={value} className="flex items-center gap-2 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={requiredOutputs.includes(value)}
                        onChange={() => toggleOutput(value)}
                        className="accent-primary h-4 w-4"
                      />
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
                {fileName ? (
                  <div className="space-y-1">
                    <FileSpreadsheet className="h-8 w-8 mx-auto text-green-600" />
                    <p className="text-sm font-medium">{fileName}</p>
                    <p className="text-xs text-muted-foreground">{rows.length} dòng dữ liệu</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Click để chọn file .xlsx hoặc .csv</p>
                  </div>
                )}
                <input
                  id="file-upload"
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>

              {headers.length > 0 && (
                <div className="grid gap-1.5">
                  <Label>Cột chứa POS Code</Label>
                  <Select value={posCodeCol} onValueChange={(v) => { if (v) setPosCodeCol(v) }}>
                    <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {headers.map((h) => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Hệ thống đã tự detect. Kiểm tra lại nếu cần.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Store matching preview */}
          {storeMatches.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  Preview Store Matching
                  <Badge className="bg-green-100 text-green-700">{matched.length} matched</Badge>
                  {unmatched.length > 0 && (
                    <Badge className="bg-red-100 text-red-700">{unmatched.length} không tìm thấy</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-64 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs px-3 py-2">POS Code</TableHead>
                        <TableHead className="text-xs px-3 py-2">Store</TableHead>
                        <TableHead className="text-xs px-3 py-2 text-right">Dòng</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {storeMatches.map((m) => (
                        <TableRow key={m.posCode}>
                          <TableCell className="text-xs px-3 py-1.5 font-mono">{m.posCode}</TableCell>
                          <TableCell className="text-xs px-3 py-1.5">
                            <div className="flex items-center gap-1.5">
                              {m.found ? (
                                <CheckCircle className="h-3.5 w-3.5 text-green-600 shrink-0" />
                              ) : (
                                <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                              )}
                              <span className={m.found ? '' : 'text-red-500'}>
                                {m.storeName ?? 'Không tìm thấy'}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs px-3 py-1.5 text-right text-muted-foreground">
                            {m.rows.length}
                          </TableCell>
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
      {matched.length > 0 && (
        <>
          <Separator />
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Sẽ tạo <strong>{matched.length} tasks</strong> cho {matched.length} store
              {unmatched.length > 0 && (
                <span className="text-red-500 ml-2">({unmatched.length} store không tìm thấy sẽ bị bỏ qua)</span>
              )}
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => router.back()} disabled={pending}>
                Huỷ
              </Button>
              <Button onClick={handleCreate} disabled={pending}>
                {pending ? 'Đang tạo...' : `Tạo ${matched.length} Tasks`}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
