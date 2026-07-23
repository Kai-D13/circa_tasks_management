'use client'

import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ACTION_OPTIONS } from '@/lib/logs/constants'

export interface LogFilterParams {
  q?:         string
  action?:    string
  user_id?:   string
  task_type?: string
  store_id?:  string
  date_from?: string
  date_to?:   string
}

interface Props {
  params:           LogFilterParams
  isAdmin:          boolean
  stores:           { id: string; name: string }[]
  users:            { id: string; full_name: string }[]
  managerStoreName?: string | null   // shown read-only for store_manager
}

export function LogFilters({ params, isAdmin, stores, users, managerStoreName }: Props) {
  const hasFilter = !!(params.q || params.action || params.user_id || params.task_type
    || params.store_id || params.date_from || params.date_to)

  // text-[16px] on mobile prevents the iOS focus-zoom (root font-size is 15px,
  // so text-sm/text-base both fall under the 16px threshold); compact on md+.
  const fieldCls = 'h-10 md:h-9 rounded-md border border-input bg-background px-3 py-1 text-[16px] md:text-sm shadow-sm'

  return (
    <form method="GET" className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 items-end">
      {/* Task title search */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="lf-q">Tìm task</label>
        <input id="lf-q" name="q" type="text" defaultValue={params.q ?? ''} placeholder="Tên task..." className={fieldCls} />
      </div>

      {/* Action */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="lf-action">Hành động</label>
        <select id="lf-action" name="action" defaultValue={params.action ?? ''} className={fieldCls}>
          <option value="">Tất cả</option>
          {ACTION_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {/* Task type */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="lf-type">Loại task</label>
        <select id="lf-type" name="task_type" defaultValue={params.task_type ?? ''} className={fieldCls}>
          <option value="">Tất cả</option>
          <option value="recurring">Định kỳ</option>
          <option value="adhoc">Phát sinh</option>
        </select>
      </div>

      {/* Store: admin picks; store_manager sees their own store read-only */}
      {isAdmin ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="lf-store">Cửa hàng</label>
          <select id="lf-store" name="store_id" defaultValue={params.store_id ?? ''} className={fieldCls}>
            <option value="">Tất cả</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      ) : managerStoreName ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Cửa hàng</label>
          <input type="text" value={managerStoreName} disabled aria-label="Cửa hàng của bạn"
            className={cn(fieldCls, 'text-muted-foreground cursor-not-allowed')} />
        </div>
      ) : null}

      {/* User */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="lf-user">Nhân viên</label>
        <select id="lf-user" name="user_id" defaultValue={params.user_id ?? ''} className={fieldCls}>
          <option value="">Tất cả</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.full_name}</option>
          ))}
        </select>
      </div>

      {/* Date range */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="lf-from">Từ ngày</label>
        <input id="lf-from" name="date_from" type="date" defaultValue={params.date_from ?? ''} className={fieldCls} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="lf-to">Đến ngày</label>
        <input id="lf-to" name="date_to" type="date" defaultValue={params.date_to ?? ''} className={fieldCls} />
      </div>

      {/* Actions */}
      <div className="flex items-end gap-2">
        <input type="hidden" name="page" value="1" />
        <Button type="submit" variant="outline" size="sm" className="h-[44px] md:h-9">Lọc</Button>
        {hasFilter && (
          <Link href="/logs" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-[44px] md:h-9')}>
            Xoá lọc
          </Link>
        )}
      </div>
    </form>
  )
}
