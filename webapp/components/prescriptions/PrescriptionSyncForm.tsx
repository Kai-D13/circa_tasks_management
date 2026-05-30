'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { syncPrescriptionProducts } from '@/app/actions/prescriptions'
import type { ProductRow } from '@/lib/prescriptions/types'

export function PrescriptionSyncForm() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [json, setJson]            = useState('')
  const [preview, setPreview]      = useState<ProductRow[] | null>(null)
  const [parseError, setParseError] = useState('')
  const [syncResult, setSyncResult] = useState<{
    matched_count: number
    unmatched_count: number
    unmatched_codes: string[]
  } | null>(null)

  function handleParse() {
    setParseError('')
    setPreview(null)
    setSyncResult(null)
    try {
      const parsed = JSON.parse(json)
      if (!Array.isArray(parsed) || parsed.length === 0) {
        setParseError('Dữ liệu phải là một mảng JSON không rỗng')
        return
      }
      const rows: ProductRow[] = parsed.map((item: Record<string, unknown>, i: number) => {
        const code = (item.order_code as string | undefined)?.trim()
        if (!code || !item.product_id || !item.sku_code || !item.lot_date)
          throw new Error(`Hàng ${i + 1}: thiếu order_code, product_id, sku_code hoặc lot_date`)
        return {
          order_code:      code.toUpperCase(),
          product_id:      String(item.product_id),
          product_name:    item.product_name ? String(item.product_name) : undefined,
          sku_code:        String(item.sku_code),
          lot_date:        String(item.lot_date),
          pos_code:        item.pos_code  ? String(item.pos_code)  : undefined,
          pos_name:        item.pos_name  ? String(item.pos_name)  : undefined,
          created_at_vn:   item.created_at_vn   ? String(item.created_at_vn)   : undefined,
          completed_at_vn: item.completed_at_vn ? String(item.completed_at_vn) : undefined,
          employee_name:   item.employee_name   ? String(item.employee_name)   : undefined,
        }
      })
      setPreview(rows)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'JSON không hợp lệ')
    }
  }

  function handleSync() {
    if (!preview) return
    startTransition(async () => {
      const result = await syncPrescriptionProducts(preview)
      if (result?.error) {
        toast.error(result.error)
        return
      }
      if (result?.success) {
        setSyncResult({
          matched_count:   result.matched_count ?? 0,
          unmatched_count: result.unmatched_count ?? 0,
          unmatched_codes: result.unmatched_codes ?? [],
        })
        setPreview(null)
        setJson('')
        if ((result.matched_count ?? 0) > 0) toast.success(`Đã đồng bộ ${result.matched_count} đơn hàng`)
        if ((result.unmatched_count ?? 0) > 0) toast.warning(`${result.unmatched_count} mã không tìm thấy trong hệ thống`)
        router.refresh()
      }
    })
  }

  const uniqueCodes = preview ? [...new Set(preview.map((p) => p.order_code))] : []

  return (
    <Card className="border-blue-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-blue-800">Đồng bộ hàng loạt</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {syncResult ? (
          <div className="space-y-2">
            <div className="flex gap-2 flex-wrap">
              <Badge className="bg-green-100 text-green-700">✓ {syncResult.matched_count} đơn hàng đã đồng bộ</Badge>
              {syncResult.unmatched_count > 0 && (
                <Badge className="bg-red-100 text-red-700">✗ {syncResult.unmatched_count} mã không tìm thấy</Badge>
              )}
            </div>
            {syncResult.unmatched_codes.length > 0 && (
              <div className="text-xs text-muted-foreground">
                <p className="font-medium mb-1">Mã không tìm thấy trong hệ thống:</p>
                <p className="font-mono">{syncResult.unmatched_codes.join(', ')}</p>
              </div>
            )}
            <Button variant="outline" size="sm" onClick={() => setSyncResult(null)}>
              Đồng bộ thêm
            </Button>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Dán JSON sản phẩm từ hệ thống nội bộ. Mỗi phần tử cần có:{' '}
              <code className="text-xs bg-muted px-1 rounded">order_code, product_id, sku_code, lot_date</code>.
            </p>
            <Textarea
              placeholder={'[\n  {"order_code":"DHC00878115","product_id":"7441","sku_code":"CIRCA.AND-RAB-001","lot_date":"V877-030827"},\n  ...\n]'}
              value={json}
              onChange={(e) => { setJson(e.target.value); setPreview(null); setParseError('') }}
              rows={6}
              className="font-mono text-xs"
            />
            {parseError && <p className="text-xs text-destructive">{parseError}</p>}

            <Button variant="outline" size="sm" onClick={handleParse} disabled={!json.trim()}>
              Kiểm tra dữ liệu
            </Button>

            {preview && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge className="bg-blue-100 text-blue-700">{preview.length} dòng sản phẩm</Badge>
                  <Badge className="bg-purple-100 text-purple-700">{uniqueCodes.length} mã DHC</Badge>
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {uniqueCodes.slice(0, 5).join(', ')}{uniqueCodes.length > 5 ? ` +${uniqueCodes.length - 5} khác` : ''}
                </div>
                <div className="border rounded overflow-auto max-h-40">
                  <table className="w-full text-xs">
                    <thead className="bg-muted">
                      <tr>
                        <th className="px-2 py-1 text-left">order_code</th>
                        <th className="px-2 py-1 text-left">sku_code</th>
                        <th className="px-2 py-1 text-left">lot_date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.slice(0, 10).map((p, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1 font-mono">{p.order_code}</td>
                          <td className="px-2 py-1 font-mono">{p.sku_code}</td>
                          <td className="px-2 py-1 font-mono">{p.lot_date}</td>
                        </tr>
                      ))}
                      {preview.length > 10 && (
                        <tr className="border-t">
                          <td colSpan={3} className="px-2 py-1 text-muted-foreground text-center">
                            +{preview.length - 10} hàng nữa
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <Button size="sm" disabled={pending} onClick={handleSync} className="bg-blue-600 hover:bg-blue-700">
                  {pending ? 'Đang đồng bộ...' : `Xác nhận đồng bộ ${uniqueCodes.length} mã DHC`}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
