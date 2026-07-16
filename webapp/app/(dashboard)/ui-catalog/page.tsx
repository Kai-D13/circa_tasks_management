import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { Boxes, CheckCircle2, Loader, RotateCcw, Layers, Plus, Search } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/ds/PageHeader'
import { StatCard } from '@/components/ds/StatCard'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { FilterTabs } from '@/components/ds/FilterTabs'
import { DataToolbar } from '@/components/ds/DataToolbar'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { Pagination } from '@/components/common/Pagination'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { LoadingState } from '@/components/ds/LoadingState'
import { DetailPageShell } from '@/components/ds/DetailPageShell'
import { cn } from '@/lib/utils'

// Dev-only design-system catalog (UI program P1.4). 100% MOCK data — the
// committed component-snapshot baseline lives on this page, so it must stay
// deterministic and PII-free. Gate: UI_CATALOG=1 env (never set on Coolify →
// production returns 404) + super admin.
// Run locally: UI_CATALOG=1 npm start (or dev), login super, open /ui-catalog.

// Fixtures (fake only — per UI_CHANGE_GUARDRAILS PII rule)
const LONG_NAME =
  'Thuốc bổ gan tăng cường chức năng miễn dịch Nguyễn Văn A siêu dài dùng để kiểm tra wrap hai dòng và cắt chữ khi vượt quá một trăm hai mươi ký tự'
const FIXTURE_ROWS = [
  { code: 'DHC_TEST_001', store: 'POS_TEST Cửa hàng A', who: 'Nguyễn Văn A', tone: 'success' as const, label: 'Hoàn tất' },
  { code: 'DHC_TEST_002', store: 'POS_TEST Cửa hàng B', who: 'Trần Thị B', tone: 'warning' as const, label: 'Đang xử lý' },
  { code: 'DHC_TEST_003', store: 'POS_TEST Cửa hàng C', who: 'Lê Văn C', tone: 'danger' as const, label: 'Đã hủy' },
  { code: 'DHC_TEST_004', store: LONG_NAME, who: 'Phạm Thị D', tone: 'neutral' as const, label: 'Nháp' },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  )
}

export default async function UiCatalogPage() {
  // Production must 404: Coolify never sets UI_CATALOG. Super admin only.
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()

  return (
    <div className="p-4 space-y-8 max-w-5xl" data-testid="ui-catalog">
      <PageHeader
        title="Design System Catalog"
        subtitle="Dev-only · fixtures giả 100% · nguồn snapshot component"
        icon={Boxes}
        actions={<Button size="sm" className="gap-1.5 h-[44px] md:h-8"><Plus className="h-4 w-4" /> Action</Button>}
      />

      <Section title="StatusBadge — 5 tone × 2 size">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="success">Hoàn tất</StatusBadge>
          <StatusBadge tone="warning">Đang xử lý</StatusBadge>
          <StatusBadge tone="danger">Quá hạn</StatusBadge>
          <StatusBadge tone="neutral">Nháp</StatusBadge>
          <StatusBadge tone="info">Sắp đến kỳ</StatusBadge>
          <StatusBadge tone="success" size="sm">Đã duyệt</StatusBadge>
          <StatusBadge tone="warning" size="sm">Chờ duyệt</StatusBadge>
          <StatusBadge tone="danger" size="sm">Lỗi DHC</StatusBadge>
          <StatusBadge tone="neutral" size="sm">Ngừng hoạt động</StatusBadge>
          <StatusBadge tone="info" size="sm">Đang xử lý bởi Nguyễn Văn A</StatusBadge>
        </div>
      </Section>

      <Section title="StatCard — 4 tone (grid trang tự quyết)">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Tổng phiên" value={128} icon={Layers} />
          <StatCard label="Hoàn thành" value={97} icon={CheckCircle2} tone="success" hint="76% tổng" />
          <StatCard label="Đang xử lý" value={24} icon={Loader} tone="warning" />
          <StatCard label="Cần làm lại" value={7} icon={RotateCcw} tone="danger" />
        </div>
      </Section>

      <Section title="FilterTabs — count pills">
        <FilterTabs
          activeKey="all"
          tabs={[
            { key: 'all', label: 'Tất cả', count: 3189, href: '#' },
            { key: 'draft', label: 'Nháp', count: 105, href: '#' },
            { key: 'done', label: 'Hoàn tất', count: 2967, href: '#' },
            { key: 'cancelled', label: 'Đã hủy', count: 117, href: '#' },
          ]}
        />
      </Section>

      <Section title="DataToolbar — search trái, action phải">
        <DataToolbar
          search={
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input placeholder="Tìm kiếm..." aria-label="Tìm kiếm" readOnly
                className="pl-8 h-10 md:h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-[16px] md:text-sm shadow-sm" />
            </div>
          }
          filters={
            <select aria-label="Lọc" className="h-10 md:h-8 rounded-md border border-input bg-background px-2 py-1 text-[16px] md:text-sm shadow-sm" defaultValue="">
              <option value="">Tất cả cửa hàng</option>
            </select>
          }
          actions={
            <>
              <span className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-[44px] md:h-8')}>Làm mới</span>
              <span className={cn(buttonVariants({ size: 'sm' }), 'h-[44px] md:h-8')}>Áp dụng</span>
            </>
          }
        />
      </Section>

      <Section title="DataTableShell + StatusBadge + Pagination (full)">
        <DataTableShell>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mã phiếu</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Người điều chỉnh</TableHead>
                <TableHead>Cửa hàng</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {FIXTURE_ROWS.map((r) => (
                <TableRow key={r.code}>
                  <TableCell className="font-mono font-medium">{r.code}</TableCell>
                  <TableCell><StatusBadge tone={r.tone}>{r.label}</StatusBadge></TableCell>
                  <TableCell className="text-muted-foreground">{r.who}</TableCell>
                  <TableCell className="text-muted-foreground max-w-64"><span className="line-clamp-2">{r.store}</span></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataTableShell>
        <div className="px-1">
          <Pagination page={2} totalPages={320} totalRows={3189} pageSize={10} hrefForPage={() => '#'} />
          <Pagination mode="simple" page={2} hasNext hrefForPage={() => '#'} />
        </div>
      </Section>

      <Section title="Empty / Error / Loading states">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border">
            <EmptyState icon={Boxes} title="Không tìm thấy phiếu nào" hint="Thử đổi bộ lọc hoặc từ khóa." />
          </div>
          <div className="space-y-3">
            <ErrorState message="Không tải được danh sách" hint="Có thể migration TEST_000 chưa được chạy." />
            <LoadingState variant="cards" rows={2} />
          </div>
        </div>
        <LoadingState variant="table" rows={3} />
        <LoadingState variant="list" rows={2} />
      </Section>

      <Section title="DetailPageShell (khung — nested demo)">
        <div className="rounded-lg border bg-muted/20">
          <DetailPageShell
            backHref="#"
            backLabel="Danh sách phiếu"
            title={LONG_NAME.slice(0, 60)}
            badges={<><StatusBadge tone="warning">Đang xử lý</StatusBadge><StatusBadge tone="info" size="sm">Đang xử lý bởi Nguyễn Văn A</StatusBadge></>}
            meta={<>POS_TEST Cửa hàng A · Tạo bởi Nguyễn Văn A · 01/01/2026</>}
          >
            <p className="text-sm text-muted-foreground">Nội dung trang chi tiết…</p>
          </DetailPageShell>
        </div>
      </Section>
    </div>
  )
}
