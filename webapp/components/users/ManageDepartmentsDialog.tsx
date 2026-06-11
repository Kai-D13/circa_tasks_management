'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Building2, Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { createDepartment, updateDepartment, deleteDepartment } from '@/app/actions/departments'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { DEPARTMENT_COLOR_KEYS, deptBadgeClass, deptDotClass, type Department } from '@/lib/departments'
import { cn } from '@/lib/utils'

interface Props {
  departments: (Department & { memberCount: number })[]
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {DEPARTMENT_COLOR_KEYS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Màu ${c}`}
          onClick={() => onChange(c)}
          className={cn(
            'h-5 w-5 rounded-full transition-transform',
            deptDotClass(c),
            value === c ? 'ring-2 ring-offset-2 ring-primary scale-110' : 'opacity-70 hover:opacity-100',
          )}
        />
      ))}
    </div>
  )
}

export function ManageDepartmentsDialog({ departments }: Props) {
  const [open, setOpen]            = useState(false)
  const [pending, startTransition] = useTransition()

  // Create form
  const [newName, setNewName]   = useState('')
  const [newColor, setNewColor] = useState<string>('orange')

  // Inline edit state — one row at a time
  const [editId, setEditId]       = useState<string | null>(null)
  const [editName, setEditName]   = useState('')
  const [editColor, setEditColor] = useState('orange')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  function handleCreate() {
    if (!newName.trim()) return
    startTransition(async () => {
      const r = await createDepartment(newName, newColor)
      if ('error' in r) { toast.error(r.error); return }
      toast.success('Đã tạo phòng ban')
      setNewName('')
      setNewColor('orange')
    })
  }

  function startEdit(d: Department) {
    setEditId(d.id)
    setEditName(d.name)
    setEditColor(d.color)
    setConfirmDeleteId(null)
  }

  function handleSaveEdit() {
    if (!editId || !editName.trim()) return
    startTransition(async () => {
      const r = await updateDepartment(editId, editName, editColor)
      if ('error' in r) { toast.error(r.error); return }
      toast.success('Đã cập nhật phòng ban')
      setEditId(null)
    })
  }

  function handleDelete(id: string) {
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return }
    startTransition(async () => {
      const r = await deleteDepartment(id)
      if ('error' in r) { toast.error(r.error); setConfirmDeleteId(null); return }
      toast.success('Đã xóa phòng ban')
      setConfirmDeleteId(null)
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setEditId(null); setConfirmDeleteId(null) } }}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Building2 className="h-4 w-4 mr-1" />
        Phòng ban
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Quản lý phòng ban</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground -mt-1">
          Phòng ban là nhãn nhận diện trên task — không thay đổi quyền hạn. Task tạo mới sẽ tự gắn
          nhãn phòng ban của người tạo.
        </p>

        {/* Create */}
        <div className="rounded-lg border p-3 space-y-2.5 bg-muted/30">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Thêm phòng ban</p>
          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate() } }}
              placeholder="Tên phòng ban (vd: Marketing)"
              className="h-9 flex-1"
              maxLength={50}
            />
            <Button size="sm" className="h-9" onClick={handleCreate} disabled={pending || !newName.trim()}>
              <Plus className="h-4 w-4 mr-1" /> Thêm
            </Button>
          </div>
          <ColorPicker value={newColor} onChange={setNewColor} />
        </div>

        {/* List */}
        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {departments.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">Chưa có phòng ban nào</p>
          )}
          {departments.map((d) => (
            <div key={d.id} className="rounded-md border px-3 py-2">
              {editId === d.id ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="h-8 text-sm flex-1"
                      maxLength={50}
                    />
                    <Button size="sm" className="h-8 px-2" onClick={handleSaveEdit} disabled={pending}>
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => setEditId(null)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <ColorPicker value={editColor} onChange={setEditColor} />
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className={cn('text-xs px-2 py-0.5 rounded font-medium', deptBadgeClass(d.color))}>
                    {d.name}
                  </span>
                  <span className="text-xs text-muted-foreground flex-1">
                    {d.memberCount} thành viên
                  </span>
                  <button
                    type="button"
                    onClick={() => startEdit(d)}
                    className="text-muted-foreground hover:text-foreground p-1"
                    aria-label="Sửa phòng ban"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => handleDelete(d.id)}
                    className={cn(
                      'p-1 flex items-center gap-1 text-xs rounded',
                      confirmDeleteId === d.id
                        ? 'text-red-600 bg-red-50 px-1.5 font-medium'
                        : 'text-muted-foreground hover:text-destructive',
                    )}
                    aria-label="Xóa phòng ban"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {confirmDeleteId === d.id && 'Xác nhận?'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
