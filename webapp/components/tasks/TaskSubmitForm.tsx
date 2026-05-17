'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { submitTask } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { FileUploadInput } from '@/components/tasks/FileUploadInput'
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
  const [outputs, setOutputs] = useState<Record<string, string>>({})

  const outputList = requiredOutputs.length > 0 ? requiredOutputs : (['text'] as RequiredOutput[])

  function set(key: string, value: string) {
    setOutputs((prev) => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    const missing = outputList.filter((type) => !outputs[type]?.trim())
    if (missing.length > 0) {
      toast.error(`Vui lòng điền đầy đủ: ${missing.map((t) => OUTPUT_LABEL[t]).join(', ')}`)
      return
    }

    startTransition(async () => {
      const result = await submitTask(taskId, outputs)
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
              value={outputs[type] ?? ''}
              onChange={(e) => set(type, e.target.value)}
              rows={3}
            />
          ) : (
            <FileUploadInput
              taskId={taskId}
              outputType={type}
              value={outputs[type] ?? ''}
              onChange={(url) => set(type, url)}
            />
          )}
        </div>
      ))}
      <Button type="submit" disabled={pending} size="sm">
        {pending ? 'Đang nộp...' : 'Nộp kết quả'}
      </Button>
    </form>
  )
}
