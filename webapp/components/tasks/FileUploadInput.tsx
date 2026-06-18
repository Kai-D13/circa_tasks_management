'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { uploadViaGcs } from '@/lib/storage/uploadClient'
import { Button } from '@/components/ui/button'
import { Upload, X, CheckCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { RequiredOutput } from '@/types'

interface Props {
  taskId: string
  outputType: Exclude<RequiredOutput, 'text'>
  value: string
  onChange: (url: string) => void
}

const ACCEPT: Record<string, string> = {
  image: 'image/*',
  video: 'video/*',
  file:  '*/*',
}

const TYPE_LABEL: Record<string, string> = {
  image: 'ảnh',
  video: 'video',
  file:  'file',
}

export function FileUploadInput({ taskId, outputType, value, onChange }: Props) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    try {
      // Try GCS first (server-side flag). On 'fallback' use the Supabase path.
      const g = await uploadViaGcs(file, { purpose: 'task_result', taskId, outputType, filename: file.name })
      if (g !== 'fallback') {
        if ('error' in g) { toast.error(g.error); return }
        onChange(g.url)
        toast.success('Tải lên thành công')
        return
      }

      const supabase = createClient()
      const nameParts = file.name.split('.')
      const ext = nameParts.length > 1 ? nameParts.pop() : ''
      const path = `tasks/${taskId}/${outputType}/${Date.now()}${ext ? '.' + ext : ''}`

      const { error: uploadError } = await supabase.storage
        .from('task-uploads')
        .upload(path, file, { upsert: true })

      if (uploadError) throw uploadError

      const { data: { publicUrl } } = supabase.storage
        .from('task-uploads')
        .getPublicUrl(path)

      onChange(publicUrl)
      toast.success('Tải lên thành công')
    } catch {
      toast.error('Tải lên thất bại. Vui lòng thử lại.')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  if (value) {
    return (
      <div className="flex items-center gap-2 p-2.5 border rounded-md bg-green-50 border-green-200">
        <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
        <span className="text-xs text-green-800 font-medium flex-1">Đã tải lên thành công</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
          onClick={() => onChange('')}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    )
  }

  return (
    <>
      <div
        className="border-2 border-dashed rounded-md p-5 text-center cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => !uploading && inputRef.current?.click()}
      >
        {uploading ? (
          <div className="flex flex-col items-center gap-1.5">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground">Đang tải lên...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5">
            <Upload className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">Chọn {TYPE_LABEL[outputType]} từ thiết bị</p>
            <p className="text-xs text-muted-foreground">
              Hỗ trợ điện thoại (camera / thư viện ảnh) và máy tính
            </p>
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT[outputType]}
        className="hidden"
        onChange={handleFile}
        disabled={uploading}
      />
    </>
  )
}
