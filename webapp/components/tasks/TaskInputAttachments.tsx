'use client'

import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Upload, X, Loader2, FileText, Image as ImageIcon, Music } from 'lucide-react'
import { toast } from 'sonner'
import { TaskAttachment } from '@/types'

interface Props {
  uploadId: string
  value: TaskAttachment[]
  onChange: (attachments: TaskAttachment[]) => void
}

export interface TaskInputAttachmentsHandle {
  openFilePicker: () => void
}

const MAX_IMAGE_SIZE = 5  * 1024 * 1024
const MAX_DOC_SIZE   = 10 * 1024 * 1024
const MAX_AUDIO_SIZE = 15 * 1024 * 1024
const MAX_TOTAL_SIZE = 30 * 1024 * 1024
const MAX_COUNT      = 20
const ALLOWED_IMAGES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
const ALLOWED_AUDIO  = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/x-m4a', 'audio/m4a']

export const TaskInputAttachments = forwardRef<TaskInputAttachmentsHandle, Props>(
  function TaskInputAttachments({ uploadId, value, onChange }, ref) {
    const [uploading, setUploading] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    useImperativeHandle(ref, () => ({
      openFilePicker: () => { if (!uploading) inputRef.current?.click() },
    }), [uploading])

    async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
      const rawFiles = Array.from(e.target.files ?? [])
      if (!rawFiles.length) return

      if (value.length + rawFiles.length > MAX_COUNT) {
        toast.error(`Tối đa ${MAX_COUNT} file đính kèm mỗi task`)
        if (inputRef.current) inputRef.current.value = ''
        return
      }

      const currentTotal = value.reduce((s, a) => s + (a.size ?? 0), 0)
      const newTotal      = rawFiles.reduce((s, f) => s + f.size, 0)
      if (currentTotal + newTotal > MAX_TOTAL_SIZE) {
        toast.error('Tổng dung lượng file đính kèm vượt 30MB')
        if (inputRef.current) inputRef.current.value = ''
        return
      }

      const files = rawFiles.filter((file) => {
        if (file.type.startsWith('image/')) {
          if (!ALLOWED_IMAGES.includes(file.type)) {
            toast.error(`${file.name}: Chỉ hỗ trợ jpg, png, webp`)
            return false
          }
          if (file.size > MAX_IMAGE_SIZE) {
            toast.error(`${file.name}: Ảnh quá lớn (tối đa 5MB)`)
            return false
          }
        } else if (file.type.startsWith('audio/')) {
          if (!ALLOWED_AUDIO.includes(file.type)) {
            toast.error(`${file.name}: Định dạng audio không hỗ trợ`)
            return false
          }
          if (file.size > MAX_AUDIO_SIZE) {
            toast.error(`${file.name}: Audio quá lớn (tối đa 15MB)`)
            return false
          }
        } else if (file.size > MAX_DOC_SIZE) {
          toast.error(`${file.name}: File quá lớn (tối đa 10MB)`)
          return false
        }
        return true
      })
      if (!files.length) {
        if (inputRef.current) inputRef.current.value = ''
        return
      }

      setUploading(true)
      const supabase = createClient()
      const uploaded: TaskAttachment[] = []

      for (const file of files) {
        try {
          const path = `task-inputs/${uploadId}/${Date.now()}_${file.name}`
          const { error } = await supabase.storage
            .from('task-uploads')
            .upload(path, file, { upsert: false })
          if (error) throw error
          const { data: { publicUrl } } = supabase.storage
            .from('task-uploads')
            .getPublicUrl(path)
          uploaded.push({ url: publicUrl, name: file.name, type: file.type, size: file.size })
        } catch {
          toast.error(`Tải lên thất bại: ${file.name}`)
        }
      }

      if (uploaded.length) {
        onChange([...value, ...uploaded])
        toast.success(`Đã tải lên ${uploaded.length} tệp`)
      }
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }

    function remove(i: number) {
      onChange(value.filter((_, idx) => idx !== i))
    }

    function iconFor(type: string) {
      if (type.startsWith('image/')) return <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
      if (type.startsWith('audio/')) return <Music className="h-4 w-4 text-muted-foreground shrink-0" />
      return <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
    }

    return (
      <div className="space-y-2">
        {value.length > 0 && (
          <div className="space-y-1.5">
            {value.map((att, i) => (
              <div key={i} className="flex items-center gap-2 p-2 border rounded text-sm bg-muted/20">
                {iconFor(att.type)}
                <a
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 truncate text-primary hover:underline text-xs"
                >
                  {att.name}
                </a>
                {att.size && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {att.size < 1024 * 1024
                      ? `${(att.size / 1024).toFixed(0)}KB`
                      : `${(att.size / 1024 / 1024).toFixed(1)}MB`}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => remove(i)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <div
          className={`border-2 border-dashed rounded-md p-4 text-center cursor-pointer hover:bg-muted/40 transition-colors ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
          onClick={() => !uploading && inputRef.current?.click()}
        >
          {uploading ? (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Đang tải lên...
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Upload className="h-4 w-4" />
              Chọn ảnh, PDF, audio hoặc file (có thể chọn nhiều)
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          aria-label="Chọn file đính kèm"
          accept="image/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          className="hidden"
          onChange={handleFiles}
          disabled={uploading}
        />
      </div>
    )
  }
)
