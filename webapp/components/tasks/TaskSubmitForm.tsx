'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { submitTask } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { FileUploadInput } from '@/components/tasks/FileUploadInput'
import { MultiImageUpload, type ImageAttachment } from '@/components/tasks/MultiImageUpload'
import { RequiredOutput } from '@/types'

interface Props {
  taskId: string
  requiredOutputs: RequiredOutput[]
}

const OUTPUT_LABEL: Record<RequiredOutput, string> = {
  text:  'Ghi chú văn bản',
  image: 'Ảnh',
  video: 'Video',
  file:  'File đính kèm',
}

export function TaskSubmitForm({ taskId, requiredOutputs }: Props) {
  const [pending, startTransition] = useTransition()
  // String outputs (text, video, file)
  const [strOutputs, setStrOutputs] = useState<Record<string, string>>({})
  // Image output — array of attachment objects
  const [images, setImages] = useState<ImageAttachment[]>([])

  const outputList = requiredOutputs.length > 0 ? requiredOutputs : (['text'] as RequiredOutput[])
  const needsImage = outputList.includes('image')

  function set(key: string, value: string) {
    setStrOutputs((prev) => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    // Client-side validation
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

    // Build outputData: string keys stay as strings; image becomes array
    const outputData: Record<string, unknown> = { ...strOutputs }
    if (needsImage) outputData['image'] = images

    startTransition(async () => {
      const result = await submitTask(taskId, outputData)
      if (result?.error) toast.error(result.error)
      else toast.success('Đã nộp kết quả thành công!')
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {outputList.map((type) => (
        <div key={type} className="grid gap-1.5">
          <Label>
            {OUTPUT_LABEL[type]}
            <span className="text-red-500 ml-0.5">*</span>
          </Label>
          {type === 'text' ? (
            <Textarea
              placeholder="Nhập nội dung ghi chú..."
              value={strOutputs[type] ?? ''}
              onChange={(e) => set(type, e.target.value)}
              rows={5}
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
      {/* Full-width on mobile, right-aligned on sm+ */}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? 'Đang nộp...' : 'Nộp kết quả'}
        </Button>
      </div>
    </form>
  )
}
