'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { formatDate } from '@/lib/dateUtils'
import { Eye, X, ChevronLeft, ChevronRight } from 'lucide-react'

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
  performer_name?: string | null
  submitted_by?: string | null
  performed_by?: string | null
}

// ── Image attachment shape (Batch 5C+: has thumbnailUrl; pre-5C: only url) ──
interface ImgAtt { url: string; thumbnailUrl?: string; name: string }

// ── Lightbox ─────────────────────────────────────────────────────────────────
function ImageLightbox({ images, initial, onClose }: {
  images: ImgAtt[]
  initial: number
  onClose: () => void
}) {
  const [idx, setIdx] = useState(initial)
  const img = images[idx]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      {/* Close */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Đóng"
        className="absolute top-4 right-4 text-white/70 hover:text-white"
      >
        <X className="h-6 w-6" />
      </button>

      {/* Prev */}
      {images.length > 1 && (
        <button
          type="button"
          aria-label="Ảnh trước"
          onClick={(e) => { e.stopPropagation(); setIdx((i) => (i - 1 + images.length) % images.length) }}
          className="absolute left-4 text-white/70 hover:text-white p-2"
        >
          <ChevronLeft className="h-7 w-7" />
        </button>
      )}

      {/* Image */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={img.url}
        src={img.url}
        alt={img.name}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[90vw] object-contain rounded shadow-2xl"
      />

      {/* Next */}
      {images.length > 1 && (
        <button
          type="button"
          aria-label="Ảnh tiếp"
          onClick={(e) => { e.stopPropagation(); setIdx((i) => (i + 1) % images.length) }}
          className="absolute right-4 text-white/70 hover:text-white p-2"
        >
          <ChevronRight className="h-7 w-7" />
        </button>
      )}

      {/* Counter */}
      {images.length > 1 && (
        <span className="absolute bottom-4 text-xs text-white/60">
          {idx + 1} / {images.length}
        </span>
      )}
    </div>
  )
}

// ── Image output in result dialog ─────────────────────────────────────────────
function ImageOutput({ val }: { val: unknown }) {
  const [lightbox, setLightbox] = useState<number | null>(null)

  // New format: array of attachment objects
  if (Array.isArray(val) && val.length > 0) {
    const imgs = val as ImgAtt[]
    return (
      <>
        <div className="grid grid-cols-3 gap-1.5">
          {imgs.map((att, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setLightbox(i)}
              className="aspect-square rounded border overflow-hidden bg-muted hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={att.name}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={att.thumbnailUrl ?? att.url}
                alt={att.name}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </button>
          ))}
        </div>
        {lightbox !== null && (
          <ImageLightbox images={imgs} initial={lightbox} onClose={() => setLightbox(null)} />
        )}
      </>
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

function imageCount(val: unknown): number {
  if (Array.isArray(val)) return val.length
  if (typeof val === 'string' && val) return 1
  return 0
}

export function TaskResultCard({ result }: { result: TaskResult }) {
  const outputKeys = Object.keys(result.output_data)

  // Ưu tiên hiển thị người thực hiện thật; fallback về tài khoản submit
  const displayName = result.performer_name ?? result.submitter_name ?? '—'
  // So sánh bằng ID để tránh false positive khi 2 người trùng tên
  const showSubmitAccount =
    result.performed_by &&
    result.submitted_by &&
    result.performed_by !== result.submitted_by

  return (
    <Dialog>
      <DialogTrigger
        className="w-full text-left rounded-md border px-3 py-2.5 hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">
              {displayName}
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
            Kết quả nộp — {displayName}
          </DialogTitle>
        </DialogHeader>

        <div className="-mt-2 space-y-0.5">
          <p className="text-xs text-muted-foreground">
            Nộp lúc {formatDate(result.submitted_at)}
          </p>
          {showSubmitAccount && (
            <p className="text-xs text-muted-foreground">
              Tài khoản nộp: <span className="text-foreground">{result.submitter_name}</span>
            </p>
          )}
        </div>

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
