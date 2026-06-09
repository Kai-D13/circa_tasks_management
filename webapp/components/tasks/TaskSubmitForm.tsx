'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { submitTask } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FileUploadInput } from '@/components/tasks/FileUploadInput'
import { MultiImageUpload, type ImageAttachment } from '@/components/tasks/MultiImageUpload'
import { RequiredOutput, UserRole } from '@/types'

interface Props {
  taskId: string
  requiredOutputs: RequiredOutput[]
  role?: UserRole
  isStoreLevelTask?: boolean
  storeStaff?: { id: string; full_name: string }[]
}

const OUTPUT_LABEL: Record<RequiredOutput, string> = {
  text:  'Ghi chú văn bản',
  image: 'Ảnh',
  video: 'Video',
  file:  'File đính kèm',
}

export function TaskSubmitForm({ taskId, requiredOutputs, role, isStoreLevelTask, storeStaff }: Props) {
  const [pending, startTransition] = useTransition()
  const [strOutputs, setStrOutputs] = useState<Record<string, string>>({})
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [performedBy, setPerformedBy] = useState<string>('')

  const outputList = requiredOutputs.length > 0 ? requiredOutputs : (['text'] as RequiredOutput[])
  const needsImage = outputList.includes('image')

  // Store Manager submit store-level task → phải chọn staff thực hiện
  const requiresPerformer = role === 'store_manager' && isStoreLevelTask === true
  const hasStaff = (storeStaff?.length ?? 0) > 0
  // Chỉ render dropdown khi có staff; nếu không có, block submit với thông báo rõ
  const needsPerformerSelect = requiresPerformer && hasStaff

  function set(key: string, value: string) {
    setStrOutputs((prev) => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    const missingStr = outputList
      .filter((t) => t !== 'image')
      .filter((t) => !strOutputs[t]?.trim())
    if (missingStr.length > 0) {
      toast.error(`Vui lòng điền đầy đủ: ${missingStr.map((t) => OUTPUT_LABEL[t]).join(', ')}`)
      return
    }
    if (needsImage && images.length === 0) {
      toast.error('Vui lòng nộp ít nhất 1 ảnh')
      return
    }
    if (requiresPerformer && !performedBy) {
      toast.error('Vui lòng chọn nhân viên đã thực hiện ca này')
      return
    }

    const outputData: Record<string, unknown> = { ...strOutputs }
    if (needsImage) outputData['image'] = images

    startTransition(async () => {
      const result = await submitTask(
        taskId,
        outputData,
        needsPerformerSelect ? performedBy : null,
      )
      if (result?.error) toast.error(result.error)
      else toast.success('Đã nộp kết quả thành công!')
    })
  }

  // Cửa hàng chưa có nhân viên → không thể nộp bằng tài khoản cửa hàng
  if (requiresPerformer && !hasStaff) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <p className="font-medium">Không thể nộp bằng tài khoản cửa hàng</p>
        <p className="text-xs mt-1 text-destructive/80">
          Cửa hàng chưa có nhân viên nào. Vui lòng yêu cầu admin thêm nhân viên trước khi nộp.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {outputList.map((type) => (
        <div key={type} className="grid gap-1">
          <Label className="text-xs font-medium">
            {OUTPUT_LABEL[type]}
            <span className="text-red-500 ml-0.5">*</span>
          </Label>
          {type === 'text' ? (
            <Textarea
              placeholder="Nhập nội dung ghi chú..."
              value={strOutputs[type] ?? ''}
              onChange={(e) => set(type, e.target.value)}
              rows={3}
            />
          ) : type === 'image' ? (
            <MultiImageUpload
              taskId={taskId}
              value={images}
              onChange={setImages}
            />
          ) : (
            <FileUploadInput
              taskId={taskId}
              outputType={type}
              value={strOutputs[type] ?? ''}
              onChange={(url) => set(type, url)}
            />
          )}
        </div>
      ))}

      {/* Dropdown chọn nhân viên thực hiện — chỉ hiện khi Store Manager nộp thay */}
      {needsPerformerSelect && (
        <div className="grid gap-1 rounded-md border border-amber-200 bg-amber-50 p-3">
          <Label className="text-xs font-medium text-amber-900">
            Nhân viên đã thực hiện ca này
            <span className="text-red-500 ml-0.5">*</span>
          </Label>
          <p className="text-xs text-amber-700 mb-1">
            Bạn đang nộp bằng tài khoản cửa hàng. Chọn nhân viên thực tế thực hiện để admin tracking được.
          </p>
          <Select value={performedBy} onValueChange={(v) => setPerformedBy(v ?? '')}>
            <SelectTrigger className="h-9 text-sm bg-white">
              <SelectValue>
                {storeStaff?.find((s) => s.id === performedBy)?.full_name ?? 'Chọn nhân viên...'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {storeStaff!.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Đang nộp...' : 'Nộp kết quả'}
        </Button>
      </div>
    </form>
  )
}
