'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useUserStore } from '@/store/userStore'
import { toast } from 'sonner'
import { createTask, updateTask, createBroadcastTask, createTaskSchedule, createImportedStoreTasks } from '@/app/actions/tasks'
import { createClient as createBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RichTextEditor } from '@/components/tasks/RichTextEditor'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Plus, X, Paperclip, Link2, Settings } from 'lucide-react'
import { TaskInputAttachments, type TaskInputAttachmentsHandle } from '@/components/tasks/TaskInputAttachments'
import { TaskExcelSplitPanel, type ExcelSplitState } from '@/components/tasks/TaskExcelSplitPanel'
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

function splitDateTimeStr(value: string): [string, string] {
  if (!value) return ['', '']
  const t = value.indexOf('T')
  if (t === -1) return [value, '']
  return [value.slice(0, t), value.slice(t + 1, t + 6)]
}
function combineDateTimeStr(date: string, time: string): string {
  if (!date || !time) return ''
  return `${date}T${time}`
}

type Scope    = 'single' | 'multi' | 'all'
type TaskType = 'adhoc' | 'recurring'

// Recurring deadline-offset presets (hours); anything else uses the custom input.
const DEADLINE_PRESETS = [3, 6, 12, 24, 48, 72]

interface Props {
  stores: Pick<Store, 'id' | 'name' | 'code'>[]
  users: Pick<UserProfile, 'id' | 'full_name' | 'email' | 'store_id' | 'role'>[]
  currentUserRole: UserRole
  currentUserStoreId: string | null
  task?: Task
  // Preselects the task-type toggle (e.g. /tasks/new?mode=recurring from the
  // schedules page). Create mode only — edit always stays adhoc.
  initialTaskType?: TaskType
}

export function TaskForm({ stores, users, currentUserRole, currentUserStoreId, task, initialTaskType }: Props) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const [category, setCategory]     = useState<TaskCategory>(task?.category ?? 'other')
  const [storeId, setStoreId]       = useState(task?.store_id ?? currentUserStoreId ?? '')
  const [assignedTo, setAssignedTo] = useState(task?.assigned_to ?? '')
  const [priority, setPriority]     = useState<TaskPriority>(task?.priority ?? 'normal')
  const [outputs, setOutputs]       = useState<RequiredOutput[]>(task?.required_outputs ?? [])
  // Description is now rich-text HTML (controlled) — fed to RichTextEditor + a
  // hidden input named "description" so form/draft plumbing is unchanged.
  const [description, setDescription] = useState<string>(task?.description ?? '')
  const [taskType, setTaskType]     = useState<TaskType>(!task && initialTaskType === 'recurring' ? 'recurring' : 'adhoc')
  // staff_all: each pharmacist in the store gets their own child task to submit.
  // Ad-hoc + single-store + new only.
  const [staffMode, setStaffMode]   = useState(false)

  const [startDate, setStartDate]       = useState(task?.start_date ? new Date(task.start_date).toISOString().slice(0, 10) : '')
  const [startTime, setStartTime]       = useState(task?.start_date ? new Date(task.start_date).toISOString().slice(11, 16) : '')
  const [deadlineDate, setDeadlineDate] = useState(task?.deadline ? new Date(task.deadline).toISOString().slice(0, 10) : '')
  const [deadlineTime, setDeadlineTime] = useState(task?.deadline ? new Date(task.deadline).toISOString().slice(11, 16) : '')

  // Recurring-only config
  const [frequency, setFrequency]           = useState<'daily' | 'weekly' | 'monthly'>('weekly')
  const [runTime, setRunTime]               = useState('08:00')
  const [weekdays, setWeekdays]             = useState<number[]>([1])
  const [monthDay, setMonthDay]             = useState(1)
  const [schedStartDate, setSchedStartDate] = useState('')
  const [schedEndDate, setSchedEndDate]     = useState('')
  const [deadlineOffset, setDeadlineOffset] = useState(24)
  const [customDeadline, setCustomDeadline] = useState(false)

  // Recurring has no single-store scope (mirrors handleSetTaskType).
  const [scope, setScope]                       = useState<Scope>(!task && initialTaskType === 'recurring' ? 'multi' : 'single')
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([])

  // Excel split (broadcast + store-mode only): null = no file / plain broadcast.
  const [excelImport, setExcelImport] = useState<ExcelSplitState | null>(null)
  const handleExcelChange = useCallback((s: ExcelSplitState | null) => setExcelImport(s), [])

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
      taskType, category, priority, storeId, assignedTo, scope, selectedStoreIds, staffMode,
      outputs, links, attachments,
      frequency, runTime, weekdays, monthDay, schedStartDate, schedEndDate, deadlineOffset,
      title: dom('title'), description: dom('description'),
      start_date: combineDateTimeStr(startDate, startTime),
      deadline: combineDateTimeStr(deadlineDate, deadlineTime),
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
      selectedStoreIds, staffMode, outputs, links, attachments, frequency, runTime, weekdays,
      monthDay, schedStartDate, schedEndDate, deadlineOffset, description,
      startDate, startTime, deadlineDate, deadlineTime])

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
      setStaffMode(d.staffMode ?? false)
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
      setCustomDeadline(!DEADLINE_PRESETS.includes(d.deadlineOffset ?? 24))
      const [sd, st] = splitDateTimeStr(d.start_date ?? '')
      const [dd, dt] = splitDateTimeStr(d.deadline ?? '')
      setStartDate(sd); setStartTime(st)
      setDeadlineDate(dd); setDeadlineTime(dt)
      if (d.links?.length) setShowLinks(true)
      if (d.attachments?.length) setShowAttachments(true)
      setDescription(d.description ?? '')   // controlled rich-text field
      // Uncontrolled DOM fields
      const f = formRef.current
      if (f) {
        const setVal = (name: string, val: string) => {
          const el = f.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null
          if (el) el.value = val ?? ''
        }
        setVal('title', d.title)
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
  const broadcastCount    = scope === 'all' ? visibleStores.length : selectedStoreIds.length
  const showMultiStore    = isBroadcast || isRecurring

  // staff_all: admin + ad-hoc + new task. Works for all scopes (single/multi/all).
  const canStaffMode       = isAdmin && !isEditMode && !isRecurring
  const effectiveStaffMode = staffMode && canStaffMode
  const staffCount         = storeId
    ? users.filter((u) => u.store_id === storeId && u.role === 'staff').length
    : 0

  // Multi-store staff breakdown: used when broadcast + effectiveStaffMode for preview + guard
  const activeStoreIds     = (isBroadcast && effectiveStaffMode)
    ? (scope === 'all' ? visibleStores.map(s => s.id) : selectedStoreIds)
    : []
  const perStoreStaffInfo  = activeStoreIds.map(id => ({
    id,
    name:  visibleStores.find(s => s.id === id)?.name ?? id,
    count: users.filter(u => u.store_id === id && u.role === 'staff').length,
  }))
  const broadcastStaffTotal = perStoreStaffInfo.reduce((sum, s) => sum + s.count, 0)
  const storesWithoutStaff  = perStoreStaffInfo.filter(s => s.count === 0)

  // Excel split: adhoc + broadcast (multi/all) + store-mode (not per-pharmacist).
  const showExcelSplit  = isBroadcast && !isRecurring && !effectiveStaffMode
  const allowedStoreIds = scope === 'all' ? visibleStores.map((s) => s.id) : selectedStoreIds
  // Drop any staged import when the conditions stop applying (scope→single, staff
  // mode, recurring) so a hidden file can never leak into a different submit path.
  useEffect(() => {
    if (!showExcelSplit && excelImport) setExcelImport(null)
  }, [showExcelSplit, excelImport])

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
    // staffMode intentionally preserved — staff_all works for all scopes
  }

  function handleSetTaskType(t: TaskType) {
    setTaskType(t)
    if (t === 'recurring') setStaffMode(false)
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

    // Every task must define at least one output, else staff get a submit form
    // with no upload widgets (the recurring "quên chọn output" incident). Applies
    // to both adhoc and recurring create paths.
    if (outputs.length === 0) {
      toast.error('Vui lòng chọn ít nhất một loại kết quả cần nộp (Ảnh, Ghi chú, File hoặc Video)')
      return
    }

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

    // Per-pharmacist mode (single-store): needs at least one staff (server re-checks).
    if (effectiveStaffMode && !isBroadcast && staffCount === 0) {
      toast.error('Cửa hàng chưa có dược sĩ nào để giao task')
      return
    }

    if (isBroadcast) {
      const storeIds = scope === 'all' ? visibleStores.map((s) => s.id) : selectedStoreIds
      if (!storeIds.length) { toast.error('Vui lòng chọn ít nhất một cửa hàng'); return }

      // Excel split path: a file is staged → upload it, then create one task per
      // in-scope store (each with its own data slice). Same "Tạo Task" button.
      if (showExcelSplit && excelImport) {
        if (!excelImport.ready) {
          toast.error('File Excel chưa hợp lệ — kiểm tra sheet, cột POS và phạm vi cửa hàng')
          return
        }
        const importFile = excelImport.file
        const draftSnapshot = snapshotDraft()
        clearDraft()
        startTransition(async () => {
          const sb = createBrowserClient()
          const tmpId = crypto.randomUUID()
          const masterPath = `task-inputs/import/${tmpId}/${Date.now()}_${importFile.name}`
          const { error: upErr } = await sb.storage
            .from('task-uploads').upload(masterPath, importFile, { upsert: false })
          if (upErr) { restoreDraftSnapshot(draftSnapshot); toast.error(`Tải file lên thất bại: ${upErr.message}`); return }
          const result = await createImportedStoreTasks({
            masterPath,
            sheetName:       excelImport.sheetName,
            posColumn:       excelImport.posColumn,
            scope:           scope === 'all' ? 'all' : 'multi',
            allowedStoreIds: storeIds,
            title:           formData.get('title') as string,
            description:     (formData.get('description') as string) || '',
            category, priority,
            startDate:       (formData.get('start_date') as string) || '',
            deadline:        (formData.get('deadline') as string) || '',
            requiredOutputs: outputs,
          })
          if (result?.error) { restoreDraftSnapshot(draftSnapshot); toast.error(result.error) }
          else { toast.success(`Đã tạo ${result.count} task`); router.push('/tasks') }
        })
        return
      }

      // Per-pharmacist broadcast: block if any selected store has no staff
      if (effectiveStaffMode && storesWithoutStaff.length > 0) {
        const MAX_NAMES = 3
        const shown = storesWithoutStaff.slice(0, MAX_NAMES).map(s => s.name).join(', ')
        const extra = storesWithoutStaff.length > MAX_NAMES ? ` +${storesWithoutStaff.length - MAX_NAMES} cửa hàng khác` : ''
        toast.error(`Cửa hàng chưa có dược sĩ: ${shown}${extra}`)
        return
      }
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
          assignmentMode:  effectiveStaffMode ? 'staff_all' : 'store',
        })
        if (result?.error) {
          restoreDraftSnapshot(draftSnapshot)
          toast.error(result.error)
        }
      })
      return
    }

    formData.set('store_id',          storeId)
    // staff_all generates one child per pharmacist server-side; the parent has no
    // single assignee, so clear assigned_to and flag the mode.
    if (effectiveStaffMode) {
      formData.set('assignment_mode', 'staff_all')
      formData.set('assigned_to', '')
    } else {
      formData.set('assigned_to', assignedTo)
    }
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

  // When an Excel split is staged + valid, the real count is the in-scope stores.
  const effectiveBroadcastCount = (showExcelSplit && excelImport?.ready)
    ? excelImport.inScopeCount
    : broadcastCount
  const submitLabel = pending
    ? 'Đang lưu...'
    : isRecurring
      ? 'Tạo lịch định kỳ'
      : isBroadcast
        ? `Tạo ${effectiveBroadcastCount > 0 ? effectiveBroadcastCount + ' ' : ''}Task`
        : task ? 'Cập nhật' : 'Tạo Task'

  const sectionLabel = 'block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1.5'

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
                {/* Submit mode toggle — broadcast + admin + ad-hoc */}
                {canStaffMode && (
                  <div className="flex rounded-[4px] border overflow-hidden">
                    {([['store', 'Cửa hàng nộp'], ['staff_all', 'Từng dược sĩ nộp']] as const).map(([val, label]) => {
                      const active = (val === 'staff_all') === staffMode
                      return (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setStaffMode(val === 'staff_all')}
                          className={cn(
                            'flex-1 py-1.5 text-xs font-medium transition-colors',
                            active ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted'
                          )}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                )}
                {effectiveStaffMode && (
                  <p className={cn('text-xs', storesWithoutStaff.length > 0 ? 'text-destructive' : 'text-muted-foreground')}>
                    {activeStoreIds.length === 0
                      ? 'Chọn cửa hàng để xem số dược sĩ sẽ nhận task.'
                      : storesWithoutStaff.length > 0
                        ? `Cửa hàng chưa có dược sĩ: ${storesWithoutStaff.slice(0, 3).map(s => s.name).join(', ')}${storesWithoutStaff.length > 3 ? ` +${storesWithoutStaff.length - 3} khác` : ''}.`
                        : `Sẽ tạo ${broadcastStaffTotal} task con cho ${broadcastStaffTotal} dược sĩ trên ${activeStoreIds.length} cửa hàng.`}
                  </p>
                )}
                {/* Excel split — store-mode broadcast only; per-store data slices */}
                {showExcelSplit && (
                  <TaskExcelSplitPanel
                    stores={visibleStores}
                    allowedStoreIds={allowedStoreIds}
                    onChange={handleExcelChange}
                  />
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                {/* Submit mode — store-level vs per-pharmacist (single-store ad-hoc only) */}
                {canStaffMode && (
                  <div className="flex rounded-[4px] border overflow-hidden">
                    {([['store', 'Cửa hàng nộp'], ['staff_all', 'Từng dược sĩ nộp']] as const).map(([val, label]) => {
                      const active = (val === 'staff_all') === staffMode
                      return (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setStaffMode(val === 'staff_all')}
                          className={cn(
                            'flex-1 py-1.5 text-xs font-medium transition-colors',
                            active ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted'
                          )}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                )}
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <div className="flex-1">
                    <SearchableSelect
                      value={storeId}
                      options={visibleStores.map((s) => ({ value: s.id, label: s.name }))}
                      onValueChange={handleStoreChange}
                      placeholder="Cửa hàng..."
                      triggerClassName="h-8 text-sm bg-background"
                    />
                  </div>
                  {!effectiveStaffMode && (
                    <div className="flex-1">
                      <SearchableSelect
                        value={assignedTo}
                        options={[
                          { value: '', label: 'Chưa phân công' },
                          ...storeUsers.map((u) => ({
                            value: u.id,
                            label: u.full_name,
                            description: u.role.replace('_', ' '),
                          })),
                        ]}
                        onValueChange={(v) => setAssignedTo(v ?? '')}
                        placeholder="Người thực hiện..."
                        triggerClassName="h-8 text-sm bg-background"
                      />
                    </div>
                  )}
                </div>
                {/* Preview when per-pharmacist mode is active */}
                {effectiveStaffMode && (
                  <p className={cn('text-xs', storeId && staffCount === 0 ? 'text-destructive' : 'text-muted-foreground')}>
                    {!storeId
                      ? 'Chọn cửa hàng để xem số dược sĩ sẽ nhận task.'
                      : staffCount === 0
                        ? 'Cửa hàng này chưa có dược sĩ nào — không thể tạo task theo dược sĩ.'
                        : `Sẽ tạo ${staffCount} task con cho ${staffCount} dược sĩ. Quản lý cửa hàng nhận thông báo tổng quan.`}
                  </p>
                )}
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

          {/* Row 4: Description — WYSIWYG (bold/size/highlight/underline/align).
              Controlled `description` HTML mirrored into a hidden input so the
              existing formData('description') + draft DOM-read paths are unchanged. */}
          <div className="px-5 pt-3 pb-2">
            <input type="hidden" name="description" value={description} />
            <RichTextEditor value={description} onChange={setDescription} />
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
              <div className="px-5 py-3 border-b">
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
              <div className="px-5 py-3 border-b space-y-3">
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
                  <div className="flex items-center gap-2">
                    <Select
                      value={customDeadline ? 'custom' : String(deadlineOffset)}
                      onValueChange={(v) => {
                        if (!v) return
                        if (v === 'custom') { setCustomDeadline(true); return }
                        setCustomDeadline(false)
                        setDeadlineOffset(Number(v))
                      }}
                    >
                      <SelectTrigger className="h-8 text-sm bg-background w-32">
                        <SelectValue>{customDeadline ? 'Tùy chỉnh' : `${deadlineOffset}h`}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {DEADLINE_PRESETS.map((h) => (
                          <SelectItem key={h} value={String(h)}>{h}h</SelectItem>
                        ))}
                        <SelectItem value="custom">Tùy chỉnh…</SelectItem>
                      </SelectContent>
                    </Select>
                    {customDeadline && (
                      <div className="flex items-center gap-1">
                        <Input
                          type="number" min={1} max={168} value={deadlineOffset}
                          onChange={(e) => {
                            const n = Number(e.target.value)
                            if (Number.isFinite(n)) setDeadlineOffset(Math.max(1, Math.min(168, Math.round(n))))
                          }}
                          className="h-8 text-sm bg-background w-20"
                        />
                        <span className="text-xs text-muted-foreground">giờ</span>
                      </div>
                    )}
                  </div>
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
            <div className="px-5 py-3 border-b">
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
            <div className="px-5 py-3 border-b">
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
              <div className="px-5 py-3 border-b space-y-3">
                <span className={sectionLabel}>Thời gian</span>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1.5">Ngày bắt đầu <span className="text-destructive">*</span></label>
                  <div className="flex gap-1.5">
                    <Input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-8 text-sm bg-background flex-1" />
                    <Input type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} className="h-8 text-sm bg-background w-[88px]" />
                  </div>
                  <input type="hidden" name="start_date" value={combineDateTimeStr(startDate, startTime)} />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1.5">Deadline <span className="text-destructive">*</span></label>
                  <div className="flex gap-1.5">
                    <Input type="date" required value={deadlineDate} onChange={(e) => setDeadlineDate(e.target.value)} className="h-8 text-sm bg-background flex-1" />
                    <Input type="time" required value={deadlineTime} onChange={(e) => setDeadlineTime(e.target.value)} className="h-8 text-sm bg-background w-[88px]" />
                  </div>
                  <input type="hidden" name="deadline" value={combineDateTimeStr(deadlineDate, deadlineTime)} />
                </div>
              </div>
            )}

            {/* Output cần nộp — chips */}
            <div className="px-5 py-3">
              <span className={sectionLabel}>Output cần nộp <span className="text-destructive">*</span></span>
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
