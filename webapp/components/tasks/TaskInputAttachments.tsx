'use client'

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Upload, X, Loader2, FileText, Image as ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { TaskAttachment } from '@/types'

interface Props {
  uploadId: string
  value: TaskAttachment[]
  onChange: (attachments: TaskAttachment[]) => void
}

export function TaskInputAttachments({ uploadId, value, onChange }: Props) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
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

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="space-y-1.5">
          {value.map((att, i) => (
            <div key={i} className="flex items-center gap-2 p-2 border rounded text-sm bg-muted/20">
              {att.type.startsWith('image/') ? (
                <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
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
            Chọn ảnh, PDF hoặc file (có thể chọn nhiều)
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
        className="hidden"
        onChange={handleFiles}
        disabled={uploading}
      />
    </div>
  )
}
