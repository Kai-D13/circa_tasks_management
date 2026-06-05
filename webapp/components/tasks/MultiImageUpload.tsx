'use client'

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { resizeImageBlob, getImageDimensions } from '@/lib/imageUtils'
import { Camera, Plus, X, Loader2, AlertCircle, RotateCcw, Image as ImageIcon } from 'lucide-react'

// ── Public shape (stored in output_data / task input_data) ──────────────────
export interface ImageAttachment {
  url:            string
  thumbnailUrl?:  string   // optional — absent in records created before Batch 5C
  path?:          string   // storage path — absent in pre-Batch D records
  thumbnailPath?: string
  fileId?:        string   // task_uploaded_files.id — used to link on submit
  name:           string
  type:           string
  size:           number   // original file size before client compression
  width?:         number
  height?:        number
}

// ── Internal per-file upload state ──────────────────────────────────────────
type UploadStatus = 'queued' | 'processing' | 'uploading' | 'done' | 'error'

interface UploadSlot {
  id:       string   // stable UUID key
  file:     File
  preview:  string   // local object URL for instant grid preview
  status:   UploadStatus
  progress: number   // 0–100 (simulated via lifecycle steps)
  error?:   string
}

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_COUNT     = 50
const MAX_PER_IMAGE = 20 * 1024 * 1024   // 20 MB raw; compressed before upload
const CONCURRENCY   = 3
const ORIGINAL_EDGE = 1920               // longest edge of stored original
const THUMB_EDGE    = 400                // longest edge of thumbnail
const JPEG_QUALITY  = 0.82
// Only formats the canvas resize path handles reliably. HEIC/HEIF excluded
// because browser Canvas support is inconsistent.
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'] as const
type AllowedMime = typeof ALLOWED_TYPES[number]

interface Props {
  taskId:   string
  value:    ImageAttachment[]
  onChange: (atts: ImageAttachment[]) => void
}

export function MultiImageUpload({ taskId, value, onChange }: Props) {
  const [slots, setSlots] = useState<UploadSlot[]>([])
  const galleryRef = useRef<HTMLInputElement>(null)
  const cameraRef  = useRef<HTMLInputElement>(null)

  // Always-current refs so async callbacks read the latest prop/state values.
  const valueRef = useRef(value)
  valueRef.current = value
  const slotsRef = useRef(slots)
  slotsRef.current = slots

  // IDs the user cancelled while queued. runQueue checks this before processing
  // each slot so cancelled uploads are skipped even if already in the queue.
  const cancelledRef = useRef<Set<string>>(new Set())

  // ── slot state helpers ────────────────────────────────────────────────────

  function patchSlot(id: string, patch: Partial<UploadSlot>) {
    setSlots((prev) => prev.map((s) => s.id === id ? { ...s, ...patch } : s))
  }

  /** Remove slots from state and revoke their preview object URLs. */
  function pruneSlots(ids: Set<string>) {
    setSlots((prev) => {
      prev.filter((s) => ids.has(s.id)).forEach((s) => URL.revokeObjectURL(s.preview))
      return prev.filter((s) => !ids.has(s.id))
    })
  }

  function removeSlot(id: string) {
    cancelledRef.current.add(id)  // signal runQueue to skip this slot
    pruneSlots(new Set([id]))
  }

  // ── upload logic ──────────────────────────────────────────────────────────

  /** Upload one slot: resize both sizes → upload thumbnail → upload original. */
  async function processSlot(slot: UploadSlot): Promise<ImageAttachment | null> {
    const supabase = createClient()
    patchSlot(slot.id, { status: 'processing', progress: 10 })

    // Session is cached client-side — no network round-trip
    const { data: { session } } = await supabase.auth.getSession()
    const userId = session?.user.id ?? null

    const base      = `tasks/${taskId}/image/${Date.now()}_${slot.id.slice(0, 8)}`
    const origPath  = `${base}_orig.jpg`
    const thumbPath = `${base}_thumb.jpg`

    try {
      // 1. Resize original + thumbnail in parallel (client-side, no network)
      const [origBlob, thumbBlob] = await Promise.all([
        resizeImageBlob(slot.file, ORIGINAL_EDGE, JPEG_QUALITY),
        resizeImageBlob(slot.file, THUMB_EDGE,    JPEG_QUALITY),
      ])
      const dims = await getImageDimensions(thumbBlob)
      patchSlot(slot.id, { progress: 40 })

      // 2. Upload thumbnail (smaller → faster round-trip)
      const { error: te } = await supabase.storage
        .from('task-uploads').upload(thumbPath, thumbBlob, { contentType: 'image/jpeg', upsert: false })
      if (te) throw te
      patchSlot(slot.id, { status: 'uploading', progress: 65 })

      // 3. Upload original — on failure, best-effort delete the orphaned thumbnail
      const { error: oe } = await supabase.storage
        .from('task-uploads').upload(origPath, origBlob, { contentType: 'image/jpeg', upsert: false })
      if (oe) {
        supabase.storage.from('task-uploads').remove([thumbPath]).catch(() => {})
        throw oe
      }
      patchSlot(slot.id, { progress: 90 })

      // 4. Resolve public URLs (no extra network call)
      const { data: { publicUrl: url } }      = supabase.storage.from('task-uploads').getPublicUrl(origPath)
      const { data: { publicUrl: thumbUrl } } = supabase.storage.from('task-uploads').getPublicUrl(thumbPath)

      // 5. Register metadata — best-effort (don't fail the upload if this fails)
      let fileId: string | undefined
      const { data: fileRecord } = await supabase
        .from('task_uploaded_files')
        .insert({
          task_id:        taskId,
          path:           origPath,
          thumbnail_path: thumbPath,
          mime_type:      'image/jpeg',
          size_bytes:     origBlob.size,
          uploaded_by:    userId,
        })
        .select('id')
        .maybeSingle()
      fileId = fileRecord?.id ?? undefined

      patchSlot(slot.id, { status: 'done', progress: 100 })

      return {
        url,
        thumbnailUrl:  thumbUrl,
        path:          origPath,
        thumbnailPath: thumbPath,
        fileId,
        name:   slot.file.name,
        type:   'image/jpeg',
        size:   slot.file.size,
        width:  dims.width,
        height: dims.height,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      patchSlot(slot.id, { status: 'error', progress: 0, error: msg })
      return null
    }
  }

  /**
   * Run newSlots through processSlot with CONCURRENCY workers.
   * After all workers finish, merge successful results into `value` and remove
   * done slots (+ revoke their object URLs) in a single state update so the
   * slot count never double-counts.
   */
  async function runQueue(newSlots: UploadSlot[]) {
    const completed: ImageAttachment[] = []
    const completedIds = new Set<string>()
    let i = 0

    async function next(): Promise<void> {
      if (i >= newSlots.length) return
      const slot = newSlots[i++]
      if (cancelledRef.current.has(slot.id)) {
        // User cancelled while queued — skip processing, clean up the ref entry.
        cancelledRef.current.delete(slot.id)
        return next()
      }
      const result = await processSlot(slot)
      if (result) {
        completed.push(result)
        completedIds.add(slot.id)
      }
      return next()
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, newSlots.length) }, next))

    if (completed.length > 0) {
      // Flush successful results into parent value …
      onChange([...valueRef.current, ...completed])
      toast.success(`Đã tải lên ${completed.length} ảnh`)
      // … then remove the done slots so they're not counted in the slot grid
      // or the remaining-slot counter.
      pruneSlots(completedIds)
    }
    const failCount = newSlots.length - completed.length
    if (failCount > 0) {
      toast.error(`${failCount} ảnh tải lên thất bại — bấm nút thử lại`)
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    const fileArr   = Array.from(files)
    // Done slots are pruned from `slots` immediately after merge, so they're
    // NOT in slotsRef.current. remaining = total cap - already committed.
    const remaining = MAX_COUNT - valueRef.current.length
      - slotsRef.current.filter((s) => s.status !== 'done').length

    if (fileArr.length > remaining) {
      toast.error(`Chỉ còn chỗ cho ${remaining} ảnh (tối đa ${MAX_COUNT})`)
      return
    }

    const valid = fileArr.filter((f) => {
      if (!ALLOWED_TYPES.includes(f.type.toLowerCase() as AllowedMime)) {
        toast.error(`${f.name}: chỉ hỗ trợ jpg, png, webp`)
        return false
      }
      if (f.size > MAX_PER_IMAGE) {
        toast.error(`${f.name}: tối đa 20MB/ảnh`)
        return false
      }
      return true
    })
    if (!valid.length) return

    const newSlots: UploadSlot[] = valid.map((f) => ({
      id:       crypto.randomUUID(),
      file:     f,
      preview:  URL.createObjectURL(f),
      status:   'queued' as UploadStatus,
      progress: 0,
    }))

    setSlots((prev) => [...prev, ...newSlots])
    if (galleryRef.current) galleryRef.current.value = ''
    if (cameraRef.current)  cameraRef.current.value  = ''

    await runQueue(newSlots)
  }

  async function retrySlot(slot: UploadSlot) {
    patchSlot(slot.id, { status: 'queued', progress: 0, error: undefined })
    const result = await processSlot({ ...slot, status: 'queued', progress: 0, error: undefined })
    if (result) {
      // Use functional-style update via valueRef so concurrent retries don't
      // overwrite each other — each retry always appends to the latest value.
      onChange([...valueRef.current, result])
      pruneSlots(new Set([slot.id]))
    }
  }

  function removeValue(i: number) {
    onChange(valueRef.current.filter((_, idx) => idx !== i))
  }

  // ── derived ───────────────────────────────────────────────────────────────
  const activeSlots  = slots.filter((s) => s.status !== 'done')
  const isUploading  = slots.some((s) => s.status === 'processing' || s.status === 'uploading')
  const totalVisible = value.length + activeSlots.length
  const canAdd       = totalVisible < MAX_COUNT

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      {/* Committed images (already in value — uploaded & saved) */}
      {value.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-5">
          {value.map((att, i) => (
            <div key={i} className="relative group aspect-square rounded border overflow-hidden bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={att.thumbnailUrl ?? att.url}
                alt={att.name}
                className="w-full h-full object-cover"
                loading="lazy"
              />
              <button
                type="button"
                aria-label="Xóa ảnh"
                onClick={() => removeValue(i)}
                className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* In-progress upload slots (queued / processing / uploading / error) */}
      {activeSlots.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-5">
          {activeSlots.map((slot) => (
            <div key={slot.id} className="relative aspect-square rounded border overflow-hidden bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={slot.preview} alt={slot.file.name} className="w-full h-full object-cover" />

              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50">
                {slot.status === 'error' ? (
                  <>
                    <AlertCircle className="h-4 w-4 text-red-400" />
                    <button
                      type="button"
                      onClick={() => retrySlot(slot)}
                      className="mt-1 flex items-center gap-0.5 text-[10px] text-white bg-black/40 px-1.5 py-0.5 rounded hover:bg-black/60"
                    >
                      <RotateCcw className="h-2.5 w-2.5" />
                      Thử lại
                    </button>
                  </>
                ) : (
                  <>
                    <Loader2 className="h-4 w-4 text-white animate-spin" />
                    <span className="text-[10px] text-white mt-0.5">{slot.progress}%</span>
                  </>
                )}
              </div>

              {(slot.status === 'queued' || slot.status === 'error') && (
                <button
                  type="button"
                  aria-label="Huỷ"
                  onClick={() => removeSlot(slot.id)}
                  className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canAdd && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={isUploading}
            onClick={() => galleryRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 border-2 border-dashed rounded-md py-3 text-sm text-muted-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
          >
            {isUploading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Đang tải lên...</>
            ) : (
              <><Plus className="h-4 w-4" />{value.length === 0 ? 'Chọn ảnh' : 'Thêm ảnh'}</>
            )}
          </button>
          <button
            type="button"
            disabled={isUploading}
            onClick={() => cameraRef.current?.click()}
            title="Chụp ảnh"
            aria-label="Chụp ảnh bằng camera"
            className="flex items-center justify-center gap-1.5 border rounded-md px-3 text-sm text-muted-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
          >
            <Camera className="h-4 w-4" />
          </button>
        </div>
      )}

      {value.length === 0 && activeSlots.length === 0 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <ImageIcon className="h-3.5 w-3.5" />
          Tối đa {MAX_COUNT} ảnh · jpg, png, webp · ảnh sẽ được nén tự động
        </p>
      )}

      {(value.length > 0 || activeSlots.length > 0) && (
        <p className="text-xs text-muted-foreground">
          {value.length}/{MAX_COUNT} ảnh cho lần nộp này
          {activeSlots.length > 0 && ` · ${activeSlots.length} đang tải lên`}
        </p>
      )}

      {/* Gallery picker — explicit MIME list for browser filter dialog */}
      <input
        ref={galleryRef}
        type="file"
        multiple
        accept="image/jpeg,image/jpg,image/png,image/webp"
        aria-label="Chọn ảnh từ thư viện"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={isUploading}
      />
      {/* Camera capture — keep image/* so iOS shows the camera option */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Chụp ảnh bằng camera"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={isUploading}
      />
    </div>
  )
}
