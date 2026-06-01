'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useUserStore } from '@/store/userStore'
import { toast } from 'sonner'
import { createTask, updateTask, createBroadcastTask, createTaskSchedule } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, X, Paperclip, Link2, Settings } from 'lucide-react'
import { TaskInputAttachments, type TaskInputAttachmentsHandle } from '@/components/tasks/TaskInputAttachments'
import { cn } from '@/lib/utils'
import {
  Task, Store, UserProfile, RequiredOutput, UserRole,
  TaskPriority, TaskVisibility, TaskCategory, TaskAttachment,
} from '@/types'

const OUTPUT_OPTIONS: { value: RequiredOutput; label: string }[] = [
  { value: 'text',  label: 'Ghi chú' },
  { value: 'image', label: 'Ảnh' },
  { value: 'video', label: 'Video' },
  { value: 'file',  label: 'File' },
]

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Khẩn cấp',
  normal: 'Bình thường',
}
const CATEGORY_LABEL: Record<TaskCategory, string> = {
  training: 'Training',
  recall:   'Thu hồi / Kiểm kê',
  display:  'Trưng bày',
  audit:    'Kiểm tra',
  other:    'Khác',
}
const CATEGORY_DEFAULTS: Record<TaskCategory, {
  outputs: RequiredOutput[]; priority: TaskPriority; visibility: TaskVisibility
}> = {
  training: { outputs: ['text'],          priority: 'normal', visibility: 'store' },
  recall:   { outputs: ['text', 'image'], priority: 'urgent', visibility: 'store' },
  display:  { outputs: ['image'],         priority: 'normal', visibility: 'store' },
  audit:    { outputs: ['image', 'text'], priority: 'urgent', visibility: 'store' },
  other:    { outputs: [],               priority: 'normal', visibility: 'store' },
}

type Scope    = 'single' | 'multi' | 'all'
type TaskType = 'adhoc' | 'recurring'

interface Props {
  stores: Pick<Store, 'id' | 'name'>[]
  users: Pick<UserProfile, 'id' | 'full_name' | 'email' | 'store_id' | 'role'>[]
  currentUserRole: UserRole
  currentUserStoreId: string | null
  task?: Task
}

export function TaskForm({ stores, users, currentUserRole, currentUserStoreId, task }: Props) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const [category, setCategory]     = useState<TaskCategory>(task?.category ?? 'other')
  const [storeId, setStoreId]       = useState(task?.store_id ?? currentUserStoreId ?? '')
  const [assignedTo, setAssignedTo] = useState(task?.assigned_to ?? '')
  const [priority, setPriority]     = useState<TaskPriority>(task?.priority ?? 'normal')
  const [outputs, setOutputs]       = useState<RequiredOutput[]>(task?.required_outputs ?? [])
  const [taskType, setTaskType]     = useState<TaskType>('adhoc')

  // Recurring-only config
  const [frequency, setFrequency]           = useState<'daily' | 'weekly' | 'monthly'>('weekly')
  const [runTime, setRunTime]               = useState('08:00')
  const [weekdays, setWeekdays]             = useState<number[]>([1])
  const [monthDay, setMonthDay]             = useState(1)
  const [schedStartDate, setSchedStartDate] = useState('')
  const [schedEndDate, setSchedEndDate]     = useState('')
  const [deadlineOffset, setDeadlineOffset] = useState(24)

  const [scope, setScope]                       = useState<Scope>('single')
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([])

  const uploadIdRef       = useRef((task?.id) ?? crypto.randomUUID())
  const attachRef         = useRef<TaskInputAttachmentsHandle>(null)
  const existingInputData = task?.input_data as Record<string, unknown> | null
  const existingAttachments = (existingInputData?.attachments as TaskAttachment[]) ?? []

  const [attachments, setAttachments] = useState<TaskAttachment[]>(existingAttachments)
  // Attachment panel is visible by default when creating a task (or editing one
  // that already has attachments); the toolbar button just re-opens the picker.
  const [showAttachments, setShowAttachments]   = useState(!task || existingAttachments.length > 0)
  const [showLinks, setShowLinks]               = useState(false)
  const [showMobileConfig, setShowMobileConfig] = useState(false)
  const [links, setLinks] = useState<{ label: string; url: string }[]>(
    (existingInputData?.links as { label: string; url: string }[]) ?? []
  )

  // ── Draft (localStorage) — create mode only ──────────────────────────────
  const isCreate = !task
  const formRef  = useRef<HTMLFormElement>(null)
  const userId   = useUserStore((s) => s.profile?.id)
  const draftKey = isCreate && userId ? `circa.taskDraft.v1.${userId}` : null
  const [hasDraft, setHasDraft] = useState(false)
  const [dirtyTick, setDirtyTick] = useState(0)   // bumped by uncontrolled input onInput

  function collectDraft() {
    const f = formRef.current
    const dom = (name: string) =>
      ((f?.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null)?.value) ?? ''
    return {
      taskType, category, priority, storeId, assignedTo, scope, selectedStoreIds,
      outputs, links, attachments,
      frequency, runTime, weekdays, monthDay, schedStartDate, schedEndDate, deadlineOffset,
      title: dom('title'), description: dom('description'),
      start_date: dom('start_date'), deadline: dom('deadline'),
    }
  }

  // Detect existing draft (banner only — never auto-restore).
  // Keyed on draftKey, not [], because userId (hence the key) resolves from the
  // Zustand store only after the first render on a direct reload of /tasks/new —
  // a bare [] would run before the key exists and miss the saved draft.
  useEffect(() => {
    if (!draftKey) return
    try { setHasDraft(!!localStorage.getItem(draftKey)) } catch { /* ignore */ }
  }, [draftKey])

  // Debounced autosave; skips empty drafts so a bare visit doesn't create one.
  // Paused while an unrestored draft is pending (hasDraft): otherwise the empty
  // form on a fresh reload would overwrite — or, via the removeItem branch
  // below, delete — the saved draft before the user can hit "Khôi phục".
  useEffect(() => {
    if (!draftKey || hasDraft) return
    const t = setTimeout(() => {
      const d = collectDraft()
      const meaningful = !!(d.title || d.description || d.attachments.length ||
        d.links.some((l) => l.url.trim()) || d.storeId || d.selectedStoreIds.length || d.outputs.length)
      try {
        if (meaningful) localStorage.setItem(draftKey, JSON.stringify(d))
        else localStorage.removeItem(draftKey)
      } catch { /* ignore quota / disabled storage */ }
    }, 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, hasDraft, dirtyTick, taskType, category, priority, storeId, assignedTo, scope,
      selectedStoreIds, outputs, links, attachments, frequency, runTime, weekdays,
      monthDay, schedStartDate, schedEndDate, deadlineOffset])

  function clearDraft() {
    if (draftKey) { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } }
  }

  // Submit-time draft safety: capture the current draft, clear it up-front (so a
  // successful submit that redirects leaves nothing behind), and write it back
  // verbatim if the server action returns an error so nothing is lost.
  function snapshotDraft(): string | null {
    if (!draftKey) return null
    try { return JSON.stringify(collectDraft()) } catch { return null }
  }
  function restoreDraftSnapshot(raw: string | null) {
    if (!draftKey || !raw) return
    // Re-persist the draft and flag it pending so the banner reappears and
    // autosave (paused while hasDraft) can't wipe it right after the error.
    try { localStorage.setItem(draftKey, raw); setHasDraft(true) } catch { /* ignore */ }
  }

  function discardDraft() {
    clearDraft()
    setHasDraft(false)
  }

  function restoreDraft() {
    if (!draftKey) return
    try {
      const raw = localStorage.getItem(draftKey)
      if (!raw) { setHasDraft(false); return }
      const d = JSON.parse(raw)
      setTaskType(d.taskType ?? 'adhoc')
      setCategory(d.category ?? 'other')
      setPriority(d.priority ?? 'normal')
      setStoreId(d.storeId ?? '')
      setAssignedTo(d.assignedTo ?? '')
      setScope(d.scope ?? 'single')
      setSelectedStoreIds(d.selectedStoreIds ?? [])
      setOutputs(d.outputs ?? [])
      setLinks(d.links ?? [])
      setAttachments(d.attachments ?? [])
      setFrequency(d.frequency ?? 'weekly')
      setRunTime(d.runTime ?? '08:00')
      setWeekdays(d.weekdays ?? [1])
      setMonthDay(d.monthDay ?? 1)
      setSchedStartDate(d.schedStartDate ?? '')
      setSchedEndDate(d.schedEndDate ?? '')
      setDeadlineOffset(d.deadlineOffset ?? 24)
      if (d.links?.length) setShowLinks(true)
      if (d.attachments?.length) setShowAttachments(true)
      // Uncontrolled DOM fields
      const f = formRef.current
      if (f) {
        const setVal = (name: string, val: string) => {
          const el = f.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null
          if (el) el.value = val ?? ''
        }
        setVal('title', d.title); setVal('description', d.description)
        setVal('start_date', d.start_date); setVal('deadline', d.deadline)
      }
      setHasDraft(false)
      toast.success('Đã khôi phục bản nháp')
    } catch {
      toast.error('Không đọc được bản nháp')
    }
  }

  function addLink() {
    setLinks((prev) => [...prev, { label: '', url: '' }])
    setShowLinks(true)
  }
  function updateLink(i: number, field: 'label' | 'url', val: string) {
    setLinks((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: val } : l))
  }
  function removeLink(i: number) {
    setLinks((prev) => prev.filter((_, idx) => idx !== i))
  }

  const isAdmin     = currentUserRole === 'admin'
  const isBroadcast = isAdmin && !task && scope !== 'single'
  const isEditMode  = !!task
  const isRecurring = taskType === 'recurring' && !isEditMode

  const visibleStores  = isAdmin ? stores : stores.filter((s) => s.id === currentUserStoreId)
  const storeUsers     = storeId ? users.filter((u) => u.store_id === storeId) : users
  const selectedStoreName = visibleStores.find((s) => s.id === storeId)?.name
  const selectedUserName  = users.find((u) => u.id === assignedTo)?.full_name
  const broadcastCount    = scope === 'all' ? visibleStores.length : selectedStoreIds.length
  const showMultiStore    = isBroadcast || isRecurring

  function deriveVisibility(): TaskVisibility {
    return assignedTo ? 'private' : 'store'
  }

  function handleCategoryChange(v: string | null) {
    if (!v) return
    const cat = v as TaskCategory
    setCategory(cat)
    if (!task) {
      const d = CATEGORY_DEFAULTS[cat]
      setOutputs(d.outputs)
      setPriority(d.priority)
    }
  }

  function handleScopeChange(scopeVal: Scope) {
    setScope(scopeVal)
    setSelectedStoreIds([])
  }

  function handleSetTaskType(t: TaskType) {
    setTaskType(t)
    if (t === 'recurring' && scope === 'single') setScope('multi')
  }

  function toggleWeekday(day: number) {
    setWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    )
  }

  function toggleStoreSelection(id: string) {
    setSelectedStoreIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    )
  }

  function handleStoreChange(v: string | null) {
    if (!v) return
    setStoreId(v)
    if (!users.find((u) => u.id === assignedTo && u.store_id === v)) setAssignedTo('')
  }

  function toggleOutput(val: RequiredOutput) {
    setOutputs((prev) =>
      prev.includes(val) ? prev.filter((o) => o !== val) : [...prev, val]
    )
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)

    // ── Recurring path ────────────────────────────────────────────────────
    if (taskType === 'recurring') {
      const title       = (formData.get('title') as string)?.trim() ?? ''
      const description = (formData.get('description') as string) ?? ''
      if (!schedStartDate) { toast.error('Vui lòng chọn ngày bắt đầu lịch'); return }
      const storeIds = scope === 'all' ? visibleStores.map((s) => s.id) : selectedStoreIds
      if (!storeIds.length) { toast.error('Vui lòng chọn ít nhất một cửa hàng'); return }
      const draftSnapshot = snapshotDraft()
      clearDraft()
      startTransition(async () => {
        const result = await createTaskSchedule({
          title, description, category, priority,
          requiredOutputs: outputs,
          attachments,
          links: links.filter((l) => l.url.trim()),
          frequency,
          runTime,
          weekdays: frequency === 'weekly'  ? weekdays : null,
          monthDay: frequency === 'monthly' ? monthDay : null,
          startDate:           schedStartDate,
          endDate:             schedEndDate || null,
          deadlineOffsetHours: deadlineOffset,
          storeIds,
        })
        if (result?.error) {
          restoreDraftSnapshot(draftSnapshot)
          toast.error(result.error)
        } else {
          toast.success('Đã tạo lịch task định kỳ')
          router.push('/tasks/schedules')
        }
      })
      return
    }

    // ── Phát sinh path ────────────────────────────────────────────────────
    formData.set('category',   category)
    formData.set('priority',   priority)
    formData.set('visibility', deriveVisibility())
    formData.delete('required_outputs')
    outputs.forEach((o) => formData.append('required_outputs', o))

    // Ad-hoc tasks must have start date + deadline (deadline after start).
    // The date fields live in the config panel (hidden on mobile) — open it on
    // failure so a mobile user can see where to fix the problem.
    const startDateVal = (formData.get('start_date') as string) || ''
    const deadlineVal  = (formData.get('deadline') as string) || ''
    const revealConfig = () => {
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
        setShowMobileConfig(true)
      }
    }
    if (!startDateVal) { toast.error('Vui lòng chọn ngày bắt đầu'); revealConfig(); return }
    if (!deadlineVal)  { toast.error('Vui lòng chọn deadline'); revealConfig(); return }
    if (new Date(deadlineVal) <= new Date(startDateVal)) {
      toast.error('Deadline phải sau ngày bắt đầu'); revealConfig(); return
    }

    if (!isBroadcast && !storeId) {
      toast.error('Vui lòng chọn cửa hàng nhận task')
      return
    }

    if (isBroadcast) {
      const storeIds = scope === 'all' ? visibleStores.map((s) => s.id) : selectedStoreIds
      if (!storeIds.length) { toast.error('Vui lòng chọn ít nhất một cửa hàng'); return }
      const draftSnapshot = snapshotDraft()
      clearDraft()
      startTransition(async () => {
        const result = await createBroadcastTask({
          title:           formData.get('title') as string,
          description:     (formData.get('description') as string) || '',
          category, priority,
          visibility:      deriveVisibility(),
          storeIds,
          startDate:       (formData.get('start_date') as string) || null,
          deadline:        (formData.get('deadline') as string) || null,
          requiredOutputs: outputs,
          attachments,
          links: links.filter((l) => l.url.trim()),
        })
        if (result?.error) {
          restoreDraftSnapshot(draftSnapshot)
          toast.error(result.error)
        }
      })
      return
    }

    formData.set('store_id',          storeId)
    formData.set('assigned_to',       assignedTo)
    formData.set('input_attachments', JSON.stringify(attachments))
    formData.set('input_links',       JSON.stringify(links.filter((l) => l.url.trim())))

    const draftSnapshot = snapshotDraft()
    if (!task) clearDraft()
    startTransition(async () => {
      const result = task
        ? await updateTask(task.id, formData)
        : await createTask(formData)
      if (result?.error) {
        restoreDraftSnapshot(draftSnapshot)
        toast.error(result.error)
      }
    })
  }

  const submitLabel = pending
    ? 'Đang lưu...'
    : isRecurring
      ? 'Tạo lịch định kỳ'
      : isBroadcast
        ? `Tạo ${broadcastCount > 0 ? broadcastCount + ' ' : ''}Task`
        : task ? 'Cập nhật' : 'Tạo Task'

  const sectionLabel = 'block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2'

  const WEEKDAY_LABELS: Record<number, string> = { 0: 'CN', 1: 'T2', 2: 'T3', 3: 'T4', 4: 'T5', 5: 'T6', 6: 'T7' }

  return (
    <form ref={formRef} onSubmit={handleSubmit} onInput={() => setDirtyTick((t) => t + 1)} className="flex flex-col h-full">

      {/* ── Header (h-16) ── */}
      <div className="h-16 flex items-center justify-between gap-3 px-5 border-b bg-background sticky top-0 z-10 shrink-0">
        <h1 className="text-lg font-semibold">
          {isEditMode ? 'Chỉnh sửa Task' : 'Tạo task mới'}
        </h1>
        <div className="flex items-center gap-2">
          {/* Config toggle — mobile only */}
          <button
            type="button"
            aria-label="Cấu hình task"
            onClick={() => setShowMobileConfig(true)}
            className="lg:hidden flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2.5 h-9 rounded border border-border transition-colors"
          >
            <Settings className="h-3.5 w-3.5" />
            Cấu hình
          </button>
          <Button type="button" variant="outline" onClick={() => router.back()} className="h-9 px-4">
            Huỷ
          </Button>
          <Button type="submit" disabled={pending} className="h-9 px-4">
            {submitLabel}
          </Button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0 overflow-auto flex-col lg:flex-row">

        {/* ── Left: compose area ── */}
        <div className="flex-1 min-w-0 flex flex-col lg:border-r">

          {/* Draft restore banner — create mode only, no silent restore */}
          {isCreate && hasDraft && (
            <div className="border-b px-5 py-2 flex items-center justify-between gap-2 bg-amber-50">
              <span className="text-xs text-amber-800">Có bản nháp chưa gửi</span>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={restoreDraft}
                  className="text-xs px-2.5 py-1 rounded border border-amber-300 text-amber-800 hover:bg-amber-100"
                >
                  Khôi phục
                </button>
                <button
                  type="button"
                  onClick={discardDraft}
                  className="text-xs px-2.5 py-1 rounded text-muted-foreground hover:text-destructive"
                >
                  Xóa
                </button>
              </div>
            </div>
          )}

          {/* Row 1: Scope pills — admin + new only; recurring hides "Một CH" */}
          {isAdmin && !isEditMode && (
            <div className="border-b px-5 py-2.5 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground shrink-0">Giao đến:</span>
              {(['single', 'multi', 'all'] as Scope[]).map((s) => {
                if (s === 'single' && isRecurring) return null
                const label = s === 'single' ? 'Một CH' : s === 'multi' ? 'Nhiều CH' : `Tất cả (${visibleStores.length})`
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleScopeChange(s)}
                    className={cn(
                      'text-xs px-3 py-1 rounded-full border transition-colors',
                      scope === s
                        ? 'bg-primary text-white border-primary'
                        : 'border-border text-muted-foreground hover:border-primary/60 hover:text-foreground'
                    )}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}

          {/* Row 2: Store / assignee */}
          <div className="border-b px-5 py-3">
            {showMultiStore ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {scope === 'all'
                    ? `Tất cả ${visibleStores.length} cửa hàng ${isRecurring ? 'sẽ nhận task định kỳ' : 'sẽ nhận task này'}`
                    : `Chọn cửa hàng (${selectedStoreIds.length} đã chọn)`}
                </p>
                {scope !== 'all' && (
                  <div className="rounded border max-h-44 overflow-y-auto divide-y">
                    {visibleStores.map((s) => (
                      <label key={s.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-sidebar-accent text-sm">
                        <input
                          type="checkbox"
                          checked={selectedStoreIds.includes(s.id)}
                          onChange={() => toggleStoreSelection(s.id)}
                          className="accent-primary h-4 w-4 shrink-0"
                        />
                        {s.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row gap-2.5">
                <div className="flex-1">
                  <Select value={storeId} onValueChange={handleStoreChange}>
                    <SelectTrigger className="h-8 text-sm bg-background">
                      <SelectValue>
                        {selectedStoreName ?? <span className="text-muted-foreground">Cửa hàng...</span>}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {visibleStores.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1">
                  <Select value={assignedTo} onValueChange={(v) => setAssignedTo(v ?? '')}>
                    <SelectTrigger className="h-8 text-sm bg-background">
                      <SelectValue>
                        {selectedUserName ?? <span className="text-muted-foreground">Người thực hiện...</span>}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Chưa phân công</SelectItem>
                      {storeUsers.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.full_name}
                          <span className="ml-1 text-xs text-muted-foreground">({u.role.replace('_', ' ')})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

          {/* Row 3: Title — subject line, larger */}
          <div className="border-b px-5 py-3">
            <Input
              name="title"
              defaultValue={task?.title}
              required
              placeholder="Tiêu đề task..."
              className="w-full text-xl font-semibold border-0 p-0 h-auto focus-visible:ring-0 shadow-none placeholder:text-muted-foreground/40 bg-transparent"
            />
          </div>

          {/* Row 4: Description */}
          <div className="flex-1 px-5 pt-3 pb-1">
            {/* TODO Sprint N: Replace with Tiptap editor
                - paste image: upload to Supabase Storage → insert img tag
                - paste Excel table: parse HTML table / TSV → render table
                - store as input_data.content_json (Tiptap JSON) + description as plain-text fallback
                - DOMPurify sanitize before rendering in task detail page */}
            <Textarea
              name="description"
              defaultValue={task?.description ?? ''}
              placeholder="Nội dung chi tiết, hướng dẫn thực hiện..."
              className="w-full min-h-[180px] h-full border-0 resize-none p-0 focus-visible:ring-0 shadow-none text-sm bg-transparent placeholder:text-muted-foreground/40"
            />
          </div>

          {/* Attachment panel — always mounted (hidden when inactive) so the
              toolbar button can open the file picker imperatively via ref */}
          <div className={cn('px-5 pb-3 space-y-1.5 border-t', !showAttachments && 'hidden')}>
            <p className="text-xs text-muted-foreground pt-3">Ảnh hướng dẫn, file Excel, PDF, audio...</p>
            <TaskInputAttachments
              ref={attachRef}
              uploadId={uploadIdRef.current}
              value={attachments}
              onChange={setAttachments}
            />
          </div>

          {/* Links panel */}
          {showLinks && (
            <div className="px-5 pb-3 space-y-2 border-t">
              {links.length === 0 && (
                <p className="text-xs text-muted-foreground pt-3">Link đăng ký, meeting, tài liệu...</p>
              )}
              {links.map((link, i) => (
                <div key={i} className={cn('grid grid-cols-[1fr_1.5fr_auto] gap-2', i === 0 && 'pt-3')}>
                  <Input placeholder="Nhãn" value={link.label} onChange={(e) => updateLink(i, 'label', e.target.value)} className="h-8 text-sm" />
                  <Input placeholder="https://..." type="url" value={link.url} onChange={(e) => updateLink(i, 'url', e.target.value)} className="h-8 text-sm" />
                  <button type="button" aria-label="Xoá link" onClick={() => removeLink(i)} className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-destructive">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={addLink} className="h-7 text-xs gap-1 px-2 mt-1">
                <Plus className="h-3 w-3" /> Thêm link
              </Button>
            </div>
          )}

          {/* Toolbar */}
          <div className="border-t px-4 py-1.5 flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={() => { setShowLinks(false); setShowAttachments(true); attachRef.current?.openFilePicker() }}
              className={cn(
                'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors',
                showAttachments ? 'bg-sidebar-accent text-primary' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-primary'
              )}
            >
              <Paperclip className="h-3.5 w-3.5" />
              Đính kèm
              {attachments.length > 0 && (
                <span className="ml-0.5 bg-primary text-white text-[10px] px-1.5 py-0 rounded-full leading-4">
                  {attachments.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => { setShowLinks((v) => !v); if (isEditMode) setShowAttachments(false) }}
              className={cn(
                'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors',
                showLinks ? 'bg-sidebar-accent text-primary' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-primary'
              )}
            >
              <Link2 className="h-3.5 w-3.5" />
              Link
              {links.filter((l) => l.url.trim()).length > 0 && (
                <span className="ml-0.5 bg-primary text-white text-[10px] px-1.5 py-0 rounded-full leading-4">
                  {links.filter((l) => l.url.trim()).length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* ── Right: config panel ── */}
        {/* Desktop: always-visible sidebar. Mobile: hidden by default, overlay when showMobileConfig. */}
        <div className={cn(
          'bg-muted/20 flex flex-col',
          'lg:w-[360px] lg:max-w-[360px] lg:shrink-0 lg:border-l',
          showMobileConfig
            ? 'fixed inset-0 z-50 bg-background overflow-y-auto'
            : 'hidden lg:flex'
        )}>
          {/* Panel heading + mobile close */}
          <div className="px-5 py-3 border-b flex items-center justify-between shrink-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Cấu hình task
            </p>
            <button
              type="button"
              aria-label="Đóng"
              onClick={() => setShowMobileConfig(false)}
              className="lg:hidden text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">

            {/* Loại task — admin + new only */}
            {isAdmin && !isEditMode && (
              <div className="px-5 py-4 border-b">
                <span className={sectionLabel}>Loại task</span>
                <div className="flex rounded-[4px] border overflow-hidden">
                  {(['adhoc', 'recurring'] as TaskType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => handleSetTaskType(t)}
                      className={cn(
                        'flex-1 py-1.5 text-xs font-medium transition-colors',
                        taskType === t ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted'
                      )}
                    >
                      {t === 'adhoc' ? 'Phát sinh' : 'Định kỳ'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Lịch định kỳ — recurring mode only */}
            {isRecurring && (
              <div className="px-5 py-4 border-b space-y-3">
                <span className={sectionLabel}>Lịch chạy</span>

                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Tần suất</p>
                  <div className="flex rounded-[4px] border overflow-hidden">
                    {(['daily', 'weekly', 'monthly'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFrequency(f)}
                        className={cn(
                          'flex-1 py-1.5 text-xs transition-colors',
                          frequency === f ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted'
                        )}
                      >
                        {f === 'daily' ? 'Mỗi ngày' : f === 'weekly' ? 'Mỗi tuần' : 'Mỗi tháng'}
                      </button>
                    ))}
                  </div>
                </div>

                {frequency === 'weekly' && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">Ngày trong tuần</p>
                    <div className="flex gap-1 flex-wrap">
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => toggleWeekday(d)}
                          className={cn(
                            'text-xs px-2 py-1 rounded border transition-colors',
                            weekdays.includes(d)
                              ? 'bg-primary text-white border-primary'
                              : 'border-border text-muted-foreground hover:border-primary/50'
                          )}
                        >
                          {WEEKDAY_LABELS[d]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {frequency === 'monthly' && (
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1.5">Ngày trong tháng (1–28)</label>
                    <Input
                      type="number" min={1} max={28} value={monthDay}
                      onChange={(e) => setMonthDay(Number(e.target.value))}
                      className="h-8 text-sm bg-background w-20"
                    />
                  </div>
                )}

                <div>
                  <label className="text-xs text-muted-foreground block mb-1.5">Giờ tạo task</label>
                  <Input type="time" value={runTime} onChange={(e) => setRunTime(e.target.value)} className="h-8 text-sm bg-background w-28" />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground block mb-1.5">Deadline sau khi tạo</label>
                  <Select value={String(deadlineOffset)} onValueChange={(v) => { if (v) setDeadlineOffset(Number(v)) }}>
                    <SelectTrigger className="h-8 text-sm bg-background">
                      <SelectValue>{deadlineOffset}h</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="24">24h</SelectItem>
                      <SelectItem value="48">48h</SelectItem>
                      <SelectItem value="72">72h</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="text-xs text-muted-foreground block mb-1.5">Ngày bắt đầu *</label>
                  <Input type="date" value={schedStartDate} onChange={(e) => setSchedStartDate(e.target.value)} required={isRecurring} className="h-8 text-sm bg-background" />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground block mb-1.5">Ngày kết thúc (tuỳ chọn)</label>
                  <Input type="date" value={schedEndDate} onChange={(e) => setSchedEndDate(e.target.value)} className="h-8 text-sm bg-background" />
                </div>
              </div>
            )}

            {/* Danh mục */}
            <div className="px-5 py-4 border-b">
              <span className={sectionLabel}>Danh mục</span>
              <Select value={category} onValueChange={handleCategoryChange}>
                <SelectTrigger className="h-8 text-sm bg-background">
                  <SelectValue>{CATEGORY_LABEL[category]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(CATEGORY_LABEL) as TaskCategory[]).map((c) => (
                    <SelectItem key={c} value={c}>{CATEGORY_LABEL[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Ưu tiên */}
            <div className="px-5 py-4 border-b">
              <span className={sectionLabel}>Ưu tiên</span>
              <Select value={priority} onValueChange={(v) => { if (v) setPriority(v as TaskPriority) }}>
                <SelectTrigger className="h-8 text-sm bg-background">
                  <SelectValue>{PRIORITY_LABEL[priority]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">Bình thường</SelectItem>
                  <SelectItem value="urgent">Khẩn cấp</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Thời gian — hidden for recurring */}
            {!isRecurring && (
              <div className="px-5 py-4 border-b space-y-3">
                <span className={sectionLabel}>Thời gian</span>
                <div>
                  <label htmlFor="start_date" className="text-xs text-muted-foreground block mb-1.5">Ngày bắt đầu <span className="text-destructive">*</span></label>
                  <Input id="start_date" name="start_date" type="datetime-local" className="h-8 text-sm bg-background"
                    defaultValue={task?.start_date ? new Date(task.start_date).toISOString().slice(0, 16) : ''} />
                </div>
                <div>
                  <label htmlFor="deadline" className="text-xs text-muted-foreground block mb-1.5">Deadline <span className="text-destructive">*</span></label>
                  <Input id="deadline" name="deadline" type="datetime-local" className="h-8 text-sm bg-background"
                    defaultValue={task?.deadline ? new Date(task.deadline).toISOString().slice(0, 16) : ''} />
                </div>
              </div>
            )}

            {/* Output cần nộp — chips */}
            <div className="px-5 py-4">
              <span className={sectionLabel}>Output cần nộp</span>
              <div className="flex flex-wrap gap-1.5">
                {OUTPUT_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleOutput(value)}
                    className={cn(
                      'text-xs px-3 py-1.5 rounded-full border transition-colors',
                      outputs.includes(value)
                        ? 'bg-primary text-white border-primary'
                        : 'border-border text-muted-foreground hover:border-primary/60 hover:text-foreground'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>
    </form>
  )
}
