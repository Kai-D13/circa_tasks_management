'use client'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { formatDate } from '@/lib/dateUtils'
import { Eye } from 'lucide-react'

export const OUTPUT_LABEL: Record<string, string> = {
  image: 'Ảnh',
  video: 'Video',
  file:  'File đính kèm',
  text:  'Ghi chú văn bản',
}

function getFileName(url: string): string {
  try {
    return decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? url)
  } catch {
    return url.split('/').pop() ?? url
  }
}

export interface TaskResult {
  id: string
  submitted_at: string
  output_data: Record<string, unknown>
  submitter_name: string | null
}

// Handles both new (array of attachment objects) and legacy (string URL) image formats
function ImageOutput({ val }: { val: unknown }) {
  // New format: array of { url, name, type, size }
  if (Array.isArray(val) && val.length > 0) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {val.map((att: { url: string; name: string }, i) => (
          <a key={i} href={att.url} target="_blank" rel="noreferrer" className="block group">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={att.url}
              alt={att.name}
              className="w-full h-32 rounded border object-cover group-hover:opacity-90 transition-opacity"
            />
          </a>
        ))}
      </div>
    )
  }
  // Legacy format: single string URL
  if (typeof val === 'string') {
    return (
      <a href={val} target="_blank" rel="noreferrer" className="block group">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={val}
          alt={getFileName(val)}
          className="w-full max-h-64 rounded-md border object-contain bg-muted group-hover:opacity-90 transition-opacity"
        />
        <span className="text-xs text-primary mt-1 block break-all">{getFileName(val)}</span>
      </a>
    )
  }
  return null
}

function OutputItem({ outputKey, val }: { outputKey: string; val: unknown }) {
  if (outputKey === 'image') {
    return <ImageOutput val={val} />
  }
  if (typeof val !== 'string') return null

  if (outputKey === 'video') {
    return (
      <a href={val} target="_blank" rel="noreferrer"
        className="flex items-center gap-1.5 text-sm text-primary underline underline-offset-2 break-all">
        {getFileName(val)}
      </a>
    )
  }
  if (outputKey === 'file') {
    return (
      <a href={val} download={getFileName(val)}
        className="flex items-center gap-1.5 text-sm text-primary underline underline-offset-2 break-all">
        {getFileName(val)}
      </a>
    )
  }
  return <p className="text-sm whitespace-pre-wrap leading-relaxed">{val}</p>
}

// Count how many images in an output value (array or single)
function imageCount(val: unknown): number {
  if (Array.isArray(val)) return val.length
  if (typeof val === 'string' && val) return 1
  return 0
}

export function TaskResultCard({ result }: { result: TaskResult }) {
  const outputKeys = Object.keys(result.output_data)

  return (
    <Dialog>
      <DialogTrigger
        className="w-full text-left rounded-md border px-3 py-2.5 hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">
              {result.submitter_name ?? '—'}
            </span>
            <div className="flex gap-1 flex-wrap">
              {outputKeys.map((k) => {
                const val = result.output_data[k]
                const label = k === 'image'
                  ? `${OUTPUT_LABEL[k]} (${imageCount(val)})`
                  : (OUTPUT_LABEL[k] ?? k)
                return (
                  <span key={k} className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-sm font-medium">
                    {label}
                  </span>
                )
              })}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 text-muted-foreground">
            <span className="text-xs">{formatDate(result.submitted_at)}</span>
            <Eye className="h-3.5 w-3.5" />
          </div>
        </div>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Kết quả nộp — {result.submitter_name ?? '—'}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground -mt-2">
          Nộp lúc {formatDate(result.submitted_at)}
        </p>

        <div className="space-y-4 mt-1 max-h-[60vh] overflow-y-auto pr-1">
          {outputKeys.map((key) => (
            <div key={key} className="space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {OUTPUT_LABEL[key] ?? key}
              </p>
              <OutputItem outputKey={key} val={result.output_data[key]} />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
