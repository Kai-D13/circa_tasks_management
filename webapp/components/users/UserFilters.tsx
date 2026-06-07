'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Button } from '@/components/ui/button'
import { Search, UserX } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Store { id: string; name: string; code?: string }

interface Props {
  stores:        Store[]
  currentParams: { q?: string; role?: string; store_id?: string; missing_store?: string }
}

const ALL = '__all__'

const ROLE_LABEL: Record<string, string> = {
  [ALL]:         'Tất cả phân quyền',
  admin:         'Admin',
  store_manager: 'Quản lý',
  staff:         'Nhân viên',
}

export function UserFilters({ stores, currentParams }: Props) {
  const router   = useRouter()
  const pathname = usePathname()

  const [search, setSearch] = useState(currentParams.q ?? '')

  function update(key: string, value: string | null) {
    const params = new URLSearchParams()
    // Exclude 'page' — changing any filter resets to page 1.
    const next = { ...currentParams, [key]: value ?? '', page: '' }
    Object.entries(next).forEach(([k, v]) => {
      if (v && v !== ALL) params.set(k, v)
    })
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  // Debounced search → URL. Only push when the trimmed value actually differs from
  // the current URL param, so this never fires on mount or after a navigation.
  useEffect(() => {
    const handle = setTimeout(() => {
      const current = currentParams.q ?? ''
      if (search.trim() === current) return
      update('q', search.trim() || null)
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  function clear() {
    setSearch('')
    router.push(pathname)
  }

  const missingActive = currentParams.missing_store === 'true'
  const roleVal       = currentParams.role     ?? ALL
  const storeIdVal    = currentParams.store_id ?? ALL

  const hasFilters =
    !!currentParams.q || !!currentParams.role || !!currentParams.store_id || missingActive

  const storeOptions = [
    { value: ALL, label: 'Tất cả cửa hàng' },
    ...stores.map((s) => ({
      value:    s.id,
      label:    s.name,
      keywords: s.code ? [s.code] : undefined,
    })),
  ]

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="relative w-56">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm theo tên hoặc email"
          aria-label="Tìm người dùng"
          className="h-8 pl-8 text-sm"
        />
      </div>

      <Select value={roleVal} onValueChange={(v) => update('role', v)}>
        <SelectTrigger className="w-40 h-8 text-sm">
          <SelectValue>{ROLE_LABEL[roleVal]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Tất cả phân quyền</SelectItem>
          <SelectItem value="admin">Admin</SelectItem>
          <SelectItem value="store_manager">Quản lý</SelectItem>
          <SelectItem value="staff">Nhân viên</SelectItem>
        </SelectContent>
      </Select>

      {stores.length > 0 && (
        <SearchableSelect
          value={storeIdVal}
          options={storeOptions}
          onValueChange={(v) => update('store_id', v)}
          placeholder="Tất cả cửa hàng"
          triggerClassName="w-44 h-8 text-sm"
        />
      )}

      <Button
        variant={missingActive ? 'default' : 'outline'}
        size="sm"
        className="h-8 text-xs gap-1.5"
        onClick={() => update('missing_store', missingActive ? null : 'true')}
      >
        <UserX className="h-3.5 w-3.5" />
        Chưa gán cửa hàng
      </Button>

      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={clear} className={cn('h-8 text-xs')}>
          Xoá bộ lọc
        </Button>
      )}
    </div>
  )
}
